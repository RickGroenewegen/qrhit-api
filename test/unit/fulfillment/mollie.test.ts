/**
 * Unit tests for src/mollie.ts (payment creation, webhook processing,
 * status checks, refunds, payment links, upgrade payments, method/locale
 * resolution and the daily sales report refund math).
 *
 * Everything outbound is mocked at the module boundary:
 *  - @mollie/api-client    → createMollieClient replaced (Locale/PaymentMethod
 *                            enums stay real); first client created = "live",
 *                            second = "test" (matches field init order).
 *  - ../../../src/prisma   → in-memory prisma stub (no DB)
 *  - ../../../src/cache    → get/set/del stubs (no Redis)
 *  - ../../../src/services/fx → deterministic rates (EUR 1:1, USD ×1.2)
 *  - order/discount/data/translation/utils/generator/promotional/apptheme/
 *    bingo/MusicServiceRegistry/aiPlaylist/game/cron → stubs
 * Mail + PrintEnBind stay on the global recording proxies from test/setup.ts
 * (asserted via `outbound.calls(...)`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { outbound } from '../../helpers/recording-mock';

// ---------------------------------------------------------------------------
// Module-boundary mocks (hoisted)
// ---------------------------------------------------------------------------

const mollieApi = vi.hoisted(() => {
  const makeClient = () => ({
    payments: { create: vi.fn(), get: vi.fn() },
    paymentLinks: { create: vi.fn() },
    paymentRefunds: { create: vi.fn() },
  });
  const liveClient = makeClient();
  const testClient = makeClient();
  let calls = 0;
  // Mollie class fields: `mollieClient` (live key) is initialized before
  // `mollieClientTest`, so the first createMollieClient call is the live one.
  const createMollieClient = vi.fn(() =>
    calls++ % 2 === 0 ? liveClient : testClient
  );
  return { liveClient, testClient, createMollieClient };
});
vi.mock('@mollie/api-client', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, createMollieClient: mollieApi.createMollieClient };
});

const prismaMock = vi.hoisted(() => ({
  payment: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    groupBy: vi.fn(),
  },
  paymentHasPlaylist: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  user: { update: vi.fn() },
  gamesPurchase: { create: vi.fn() },
}));
vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

const cacheMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  executeCommand: vi.fn(),
}));
vi.mock('../../../src/cache', () => ({
  default: { getInstance: () => cacheMock },
}));

const fxMock = vi.hoisted(() => ({ tryConvert: vi.fn() }));
vi.mock('../../../src/services/fx', () => ({
  default: { getInstance: () => fxMock },
}));

const dataMock = vi.hoisted(() => ({
  storeUser: vi.fn(),
  storePlaylists: vi.fn(),
  getTaxRate: vi.fn(),
  updatePlaylistDetails: vi.fn(),
  euCountryCodes: ['NL', 'BE', 'DE', 'FR', 'AT', 'IT', 'ES', 'PL'],
}));
vi.mock('../../../src/data', () => ({
  default: { getInstance: () => dataMock },
}));

const orderMock = vi.hoisted(() => ({
  calculateOrder: vi.fn(),
  getOrderType: vi.fn(),
}));
vi.mock('../../../src/order', () => ({
  default: { getInstance: () => orderMock },
}));

const discountMock = vi.hoisted(() => ({
  calculateDiscounts: vi.fn(),
  associatePaymentWithDiscountUse: vi.fn(),
  removeDiscountUsesByPaymentId: vi.fn(),
}));
vi.mock('../../../src/discount', () => ({
  default: class {
    calculateDiscounts = discountMock.calculateDiscounts;
    associatePaymentWithDiscountUse =
      discountMock.associatePaymentWithDiscountUse;
    removeDiscountUsesByPaymentId = discountMock.removeDiscountUsesByPaymentId;
  },
}));

const translationMock = vi.hoisted(() => ({
  getTranslationsByPrefix: vi.fn(),
}));
vi.mock('../../../src/translation', () => ({
  default: class {
    getTranslationsByPrefix = translationMock.getTranslationsByPrefix;
  },
}));

const utilsMock = vi.hoisted(() => ({
  isMainServer: vi.fn(async () => false),
  isTrustedIp: vi.fn(() => false),
  lookupIp: vi.fn(async () => null as any),
  generateRandomString: vi.fn(() => 'RND1234567'),
}));
vi.mock('../../../src/utils', () => ({
  default: class {
    isMainServer = utilsMock.isMainServer;
    isTrustedIp = utilsMock.isTrustedIp;
    lookupIp = utilsMock.lookupIp;
    generateRandomString = utilsMock.generateRandomString;
  },
}));

const generatorMock = vi.hoisted(() => ({
  queueGenerate: vi.fn(),
  generateBoxInsertPdf: vi.fn(),
}));
vi.mock('../../../src/generator', () => ({
  default: { getInstance: () => generatorMock },
}));

const promotionalMock = vi.hoisted(() => ({
  creditPromotionalDiscount: vi.fn(),
}));
vi.mock('../../../src/promotional', () => ({
  default: { getInstance: () => promotionalMock },
}));

const appThemeMock = vi.hoisted(() => ({ reload: vi.fn() }));
vi.mock('../../../src/apptheme', () => ({
  default: { getInstance: () => appThemeMock },
}));

const bingoMock = vi.hoisted(() => ({ processBingoUpgradePayment: vi.fn() }));
vi.mock('../../../src/bingo', () => ({
  default: { getInstance: () => bingoMock },
}));

const providerMock = vi.hoisted(() => ({ getTracks: vi.fn() }));
vi.mock('../../../src/services/MusicServiceRegistry', () => ({
  default: { getInstance: () => ({ getProviderByString: () => providerMock }) },
}));

vi.mock('../../../src/aiPlaylist', () => ({
  aiPlaylistPromptKey: (spotifyId: string) => `ai:${spotifyId}`,
}));

// Real value is 5.00; pinned here so assertions are self-contained.
vi.mock('../../../src/game', () => ({ QRGAMES_UPGRADE_PRICE: 5.0 }));

vi.mock('cron', () => ({
  CronJob: class {
    start() {}
  },
}));

import Mollie from '../../../src/mollie';
import { PaymentMethod, Locale } from '@mollie/api-client';
import { BOX_PRICE } from '../../../src/config/constants';

const mollie = new Mollie();

// ---------------------------------------------------------------------------
// Defaults + fixtures
// ---------------------------------------------------------------------------

const TRANSLATIONS = {
  playlist: 'Playlist',
  playlists: 'Playlists',
  giftcard: 'Gift card',
  giftcards: 'Gift cards',
  items: 'Items',
};

function fakeMolliePayment(over: Record<string, any> = {}): any {
  return {
    id: 'tr_test123',
    status: 'open',
    method: null,
    metadata: {},
    getCheckoutUrl: () => 'https://pay.mollie.test/tr_test123',
    ...over,
  };
}

function applyDefaults(): void {
  prismaMock.payment.findUnique.mockResolvedValue(null);
  prismaMock.payment.findMany.mockResolvedValue([]);
  prismaMock.payment.create.mockResolvedValue({ id: 555 });
  prismaMock.payment.update.mockResolvedValue({});
  prismaMock.payment.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.payment.delete.mockResolvedValue({});
  prismaMock.payment.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.payment.groupBy.mockResolvedValue([]);
  prismaMock.paymentHasPlaylist.findUnique.mockResolvedValue(null);
  prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([]);
  prismaMock.paymentHasPlaylist.update.mockResolvedValue({});
  prismaMock.user.update.mockResolvedValue({});
  prismaMock.gamesPurchase.create.mockResolvedValue({});

  cacheMock.get.mockResolvedValue(null);
  cacheMock.set.mockResolvedValue(undefined);
  cacheMock.del.mockResolvedValue(undefined);

  // Mirrors Fx.tryConvert: EUR (or unsupported) → identity; USD → ×1.2.
  fxMock.tryConvert.mockImplementation(
    async (amountEur: number, currency: string) => {
      if (currency === 'USD') {
        return {
          amount: Number((amountEur * 1.2).toFixed(2)),
          rate: 1.2,
          currency: 'USD',
        };
      }
      return { amount: Number(amountEur.toFixed(2)), rate: 1, currency: 'EUR' };
    }
  );

  dataMock.storeUser.mockResolvedValue(42);
  dataMock.storePlaylists.mockImplementation(
    async (_userId: number, items: any[]) => items.map((_, i) => 700 + i)
  );
  dataMock.getTaxRate.mockResolvedValue(21);
  dataMock.updatePlaylistDetails.mockResolvedValue({ success: true });

  orderMock.calculateOrder.mockResolvedValue({
    success: true,
    data: {
      total: 25,
      price: '20.66',
      payment: '0.00',
      taxRate: 21,
      taxRateShipping: 21,
      boxFee: 0,
      reverseCharge: false,
      vatIdChecked: null,
    },
  });
  orderMock.getOrderType.mockResolvedValue({ id: 3, amount: 15 });

  discountMock.calculateDiscounts.mockResolvedValue({
    discountAmount: 0,
    discountUseIds: [],
    discountUsed: false,
  });
  discountMock.associatePaymentWithDiscountUse.mockResolvedValue(undefined);
  discountMock.removeDiscountUsesByPaymentId.mockResolvedValue(undefined);

  translationMock.getTranslationsByPrefix.mockResolvedValue(TRANSLATIONS);

  utilsMock.isMainServer.mockResolvedValue(false);
  utilsMock.isTrustedIp.mockReturnValue(false);
  utilsMock.lookupIp.mockResolvedValue(null);
  utilsMock.generateRandomString.mockReturnValue('RND1234567');

  generatorMock.queueGenerate.mockResolvedValue(undefined);
  generatorMock.generateBoxInsertPdf.mockResolvedValue(undefined);
  promotionalMock.creditPromotionalDiscount.mockResolvedValue(undefined);
  appThemeMock.reload.mockReturnValue(undefined);
  bingoMock.processBingoUpgradePayment.mockResolvedValue({ success: true });
  providerMock.getTracks.mockResolvedValue({
    success: true,
    data: { total: 100 },
  });

  mollieApi.liveClient.payments.create.mockResolvedValue(fakeMolliePayment());
  mollieApi.liveClient.payments.get.mockRejectedValue(
    new Error('payments.get not stubbed (live)')
  );
  mollieApi.testClient.payments.get.mockRejectedValue(
    new Error('payments.get not stubbed (test)')
  );
  mollieApi.liveClient.paymentLinks.create.mockResolvedValue({
    id: 'pl_1',
    description: 'A link',
    getPaymentUrl: () => 'https://paymentlink.mollie.com/payment/pl_1',
  });
  mollieApi.liveClient.paymentRefunds.create.mockResolvedValue({
    id: 're_1',
    status: 'pending',
  });
}

function makeItem(over: Record<string, any> = {}): any {
  return {
    playlistId: 'sp1',
    playlistName: 'Best Hits',
    productType: 'cards',
    type: 'digital',
    subType: 'none',
    amount: 1,
    price: 25,
    numberOfTracks: 100,
    doubleSided: false,
    eco: false,
    hideCircle: false,
    ...over,
  };
}

function makeParams(over: Record<string, any> = {}): any {
  return {
    locale: 'nl',
    orderType: 'digital',
    currency: 'EUR',
    refreshPlaylists: [],
    viewerCountry: null,
    extraOrderData: {
      email: 'buyer@example.com',
      fullname: 'Buyer One',
      countrycode: 'NL',
      marketingEmails: true,
    },
    cart: { items: [makeItem()] },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  outbound.reset();
  applyDefaults();
});

// ---------------------------------------------------------------------------
// filterMethodsByCurrency
// ---------------------------------------------------------------------------

describe('filterMethodsByCurrency', () => {
  it('keeps only methods that accept the presentment currency', () => {
    const result = mollie.filterMethodsByCurrency(
      [
        PaymentMethod.ideal,
        PaymentMethod.creditcard,
        PaymentMethod.swish,
        PaymentMethod.klarna,
      ],
      'SEK'
    );
    expect(result).toEqual([
      PaymentMethod.creditcard,
      PaymentMethod.swish,
      PaymentMethod.klarna,
    ]);
  });

  it('treats unmapped methods as EUR-only', () => {
    expect(
      mollie.filterMethodsByCurrency([PaymentMethod.banktransfer], 'SEK')
    ).toEqual([]);
    expect(
      mollie.filterMethodsByCurrency([PaymentMethod.banktransfer], 'EUR')
    ).toEqual([PaymentMethod.banktransfer]);
  });
});

// ---------------------------------------------------------------------------
// resolveMollieMethods / locale resolution
// ---------------------------------------------------------------------------

describe('resolveMollieMethods', () => {
  it('billing country wins over viewer and ip; NL gets iDEAL first', () => {
    const result = mollie.resolveMollieMethods({
      language: 'nl',
      billingCountry: 'nl',
      viewerCountry: 'DE',
      ipCountry: 'FR',
      currency: 'EUR',
    });
    expect(result.country).toBe('NL');
    expect(result.countrySource).toBe('billing');
    expect(result.locale).toBe(Locale.nl_NL);
    expect(result.methods).toEqual([
      PaymentMethod.ideal,
      PaymentMethod.applepay,
      PaymentMethod.creditcard,
      PaymentMethod.paypal,
      PaymentMethod.klarna,
      PaymentMethod.in3,
    ]);
  });

  it('appends language-implied country methods (Swedish speaker in DE sees swish for SEK)', () => {
    // Note: swish only supports SEK, so the "Swedish speaker still sees
    // Swish" behaviour only materializes when presenting in SEK — with EUR
    // presentment the currency filter removes it again.
    const result = mollie.resolveMollieMethods({
      language: 'sv',
      viewerCountry: 'DE',
      currency: 'SEK',
    });
    expect(result.countrySource).toBe('viewer');
    expect(result.locale).toBe(Locale.sv_SE);
    // DE list first, then SE list (deduped), then fallback (deduped),
    // finally filtered to SEK-capable methods (directdebit/paysafecard are
    // EUR-only and drop out).
    expect(result.methods).toEqual([
      PaymentMethod.paypal,
      PaymentMethod.klarna,
      PaymentMethod.creditcard,
      PaymentMethod.applepay,
      PaymentMethod.riverty,
      PaymentMethod.trustly,
      PaymentMethod.swish,
    ]);
  });

  it('falls back to the generic list when no signal is present', () => {
    const result = mollie.resolveMollieMethods({
      language: 'hi',
      currency: 'EUR',
    });
    expect(result.country).toBeNull();
    expect(result.countrySource).toBe('none');
    expect(result.locale).toBe(Locale.en_US);
    expect(result.methods).toEqual([
      PaymentMethod.creditcard,
      PaymentMethod.paypal,
      PaymentMethod.applepay,
      PaymentMethod.klarna,
    ]);
  });

  it('resolves country-dependent locales (de_AT, fr_BE, nl_BE)', () => {
    expect(
      mollie.resolveMollieMethods({
        language: 'de',
        billingCountry: 'AT',
        currency: 'EUR',
      }).locale
    ).toBe(Locale.de_AT);
    expect(
      mollie.resolveMollieMethods({
        language: 'fr',
        billingCountry: 'BE',
        currency: 'EUR',
      }).locale
    ).toBe(Locale.fr_BE);
    expect(
      mollie.resolveMollieMethods({
        language: 'nl',
        billingCountry: 'BE',
        currency: 'EUR',
      }).locale
    ).toBe(Locale.nl_BE);
    expect(
      mollie.resolveMollieMethods({
        language: 'de',
        billingCountry: 'CH',
        currency: 'EUR',
      }).locale
    ).toBe(Locale.de_CH);
  });

  it('ignores malformed country codes (length !== 2) and uses ip as last resort', () => {
    const result = mollie.resolveMollieMethods({
      language: 'en',
      billingCountry: 'NLD',
      viewerCountry: '',
      ipCountry: 'pl',
      currency: 'EUR',
    });
    expect(result.country).toBe('PL');
    expect(result.countrySource).toBe('ip');
    expect(result.methods[0]).toBe(PaymentMethod.blik);
  });
});

// ---------------------------------------------------------------------------
// getPaymentUri
// ---------------------------------------------------------------------------

describe('getPaymentUri', () => {
  const IP = '1.2.3.4';

  it('rejects requests without extraOrderData', async () => {
    const result = await mollie.getPaymentUri({ cart: { items: [] } }, IP);
    expect(result).toEqual({
      success: false,
      error: 'Invalid request: extraOrderData is required',
    });
    expect(mollieApi.liveClient.payments.create).not.toHaveBeenCalled();
  });

  it('builds the exact Mollie payload for a digital EUR order', async () => {
    const result = await mollie.getPaymentUri(makeParams(), IP);

    expect(mollieApi.liveClient.payments.create).toHaveBeenCalledWith({
      amount: { currency: 'EUR', value: '25.00' },
      metadata: { clientIp: IP, refreshPlaylists: '' },
      method: [
        PaymentMethod.ideal,
        PaymentMethod.applepay,
        PaymentMethod.creditcard,
        PaymentMethod.paypal,
        PaymentMethod.klarna,
        PaymentMethod.in3,
      ],
      description: 'Playlist : Best Hits',
      redirectUrl: 'http://localhost:4200/nl/generate/check_payment',
      webhookUrl: 'http://localhost:3004/mollie/webhook',
      locale: Locale.nl_NL,
    });

    expect(result).toEqual({
      success: true,
      data: {
        paymentId: 'tr_test123',
        paymentUri: 'https://pay.mollie.test/tr_test123',
        userId: 42,
        generationQueued: false,
      },
    });
    expect(generatorMock.queueGenerate).not.toHaveBeenCalled();
  });

  it('persists the Payment row with exact VAT/price breakdown (digital, 21%)', async () => {
    await mollie.getPaymentUri(makeParams(), IP);

    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1);
    const data = prismaMock.payment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      paymentId: 'tr_test123',
      vibe: false,
      user: { connect: { id: 42 } },
      totalPrice: 25,
      totalPriceWithoutTax: 20.66, // 25 / 1.21
      status: 'open',
      locale: 'nl',
      taxRate: 21,
      taxRateShipping: 21,
      productPriceWithoutTax: 20.66,
      shippingPriceWithoutTax: 0,
      productVATPrice: 4.34, // 20.66 * 0.21
      shippingVATPrice: 0,
      totalVATPrice: 4.34,
      clientIp: IP,
      test: false,
      profit: 20.66,
      printApiPrice: 0,
      discount: 0,
      boxFee: 0,
      currency: 'EUR',
      exchangeRate: 1,
      totalPricePresentment: 25,
      reverseCharge: false,
      vatIdChecked: null,
      boxInstructionsMailSent: false,
      // extraOrderData spread:
      email: 'buyer@example.com',
      fullname: 'Buyer One',
      countrycode: 'NL',
      marketingEmails: true,
    });

    const row = data.PaymentHasPlaylist.create[0];
    expect(row).toMatchObject({
      playlistId: 700,
      orderTypeId: 3,
      amount: 1,
      numberOfTracks: 100,
      type: 'digital',
      subType: 'none',
      price: 25,
      priceWithoutVAT: 20.66,
      priceVAT: 4.34,
      printApiPrice: 15, // orderType.amount * amount
      gamesEnabled: false,
      gamesPrice: 0,
      boxEnabled: false,
      boxQuantity: 0,
      boxPrice: 0,
      aiPrompt: null,
    });

    // orderId = 100000000 + db id
    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { id: 555 },
      data: { orderId: '100000555' },
    });
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { marketingEmails: true, sync: true },
    });
    expect(appThemeMock.reload).toHaveBeenCalled();
  });

  it('splits shipping VAT for physical orders', async () => {
    orderMock.calculateOrder.mockResolvedValue({
      success: true,
      data: {
        total: 54.95,
        price: '41.32',
        payment: '4.95', // shipping incl. VAT
        taxRate: 21,
        taxRateShipping: 21,
        boxFee: 0,
        reverseCharge: false,
        vatIdChecked: null,
      },
    });
    const params = makeParams({
      cart: { items: [makeItem({ type: 'physical', amount: 2, price: 25 })] },
    });

    await mollie.getPaymentUri(params, IP);

    const data = prismaMock.payment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      totalPrice: 54.95,
      totalPriceWithoutTax: 45.41, // 54.95 / 1.21
      shippingPriceWithoutTax: 4.09, // 4.95 / 1.21
      shippingVATPrice: 0.86, // 4.95 - 4.09
      productVATPrice: 8.68, // 41.32 * 0.21
      totalVATPrice: 9.54,
      profit: 45.41, // 41.32 + 4.09
    });
    const row = data.PaymentHasPlaylist.create[0];
    expect(row).toMatchObject({
      type: 'physical',
      amount: 2,
      price: 50, // 25 * 2
      priceWithoutVAT: 41.32,
      priceVAT: 8.68,
      printApiPrice: 30, // 15 * 2
    });
  });

  it('converts to the presentment currency and filters methods (USD)', async () => {
    const result = await mollie.getPaymentUri(
      makeParams({ currency: 'USD' }),
      IP
    );

    expect(fxMock.tryConvert).toHaveBeenCalledWith(25, 'USD');
    const payload = mollieApi.liveClient.payments.create.mock.calls[0][0];
    expect(payload.amount).toEqual({ currency: 'USD', value: '30.00' });
    // NL list minus EUR-only methods (ideal, klarna, in3 don't take USD).
    expect(payload.method).toEqual([
      PaymentMethod.applepay,
      PaymentMethod.creditcard,
      PaymentMethod.paypal,
    ]);

    const data = prismaMock.payment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      totalPrice: 25, // EUR amount stays the booked amount
      currency: 'USD',
      exchangeRate: 1.2,
      totalPricePresentment: 30,
    });
    expect(result.success).toBe(true);
  });

  it('falls back to EUR for unsupported currency codes', async () => {
    await mollie.getPaymentUri(makeParams({ currency: 'XXX' }), IP);
    expect(fxMock.tryConvert).toHaveBeenCalledWith(25, 'EUR');
    const payload = mollieApi.liveClient.payments.create.mock.calls[0][0];
    expect(payload.amount).toEqual({ currency: 'EUR', value: '25.00' });
  });

  it('caps the discount at the order total and goes through the free path', async () => {
    orderMock.calculateOrder.mockResolvedValue({
      success: true,
      data: {
        total: 5,
        price: '4.13',
        payment: '0.00',
        taxRate: 21,
        taxRateShipping: 21,
        boxFee: 0,
        reverseCharge: false,
        vatIdChecked: null,
      },
    });
    discountMock.calculateDiscounts.mockResolvedValue({
      discountAmount: 10, // more than the total → clamped to 5
      discountUseIds: [11],
      discountUsed: true,
    });

    const result = await mollie.getPaymentUri(makeParams(), IP, true, true);

    expect(mollieApi.liveClient.payments.create).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      data: {
        paymentId: 'free_RND1234567',
        paymentUri: 'http://localhost:4200/nl/generate/progress',
        userId: 42,
        generationQueued: true,
      },
    });

    const data = prismaMock.payment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      paymentId: 'free_RND1234567',
      status: 'paid',
      totalPrice: 0,
      discount: 5,
    });

    // waitForDirectGeneration=true → awaited queue call with skip-mail flag.
    expect(generatorMock.queueGenerate).toHaveBeenCalledWith(
      'free_RND1234567',
      IP,
      '',
      false,
      true,
      false
    );
    expect(discountMock.associatePaymentWithDiscountUse).toHaveBeenCalledWith(
      11,
      555
    );
  });

  it('treats vibe orders with totals <= 10 as paid without Mollie', async () => {
    orderMock.calculateOrder.mockResolvedValue({
      success: true,
      data: {
        total: 8,
        price: '6.61',
        payment: '0.00',
        taxRate: 21,
        taxRateShipping: 21,
        boxFee: 0,
        reverseCharge: false,
        vatIdChecked: null,
      },
    });
    const params = makeParams();
    params.extraOrderData.vibe = true;

    const result = await mollie.getPaymentUri(params, IP);

    expect(mollieApi.liveClient.payments.create).not.toHaveBeenCalled();
    expect(result.data.paymentId).toBe('free_RND1234567');
    expect(result.data.generationQueued).toBe(true);
    expect(prismaMock.payment.create.mock.calls[0][0].data).toMatchObject({
      vibe: true,
      status: 'paid',
      totalPrice: 0,
    });
    expect(generatorMock.queueGenerate).toHaveBeenCalledWith(
      'free_RND1234567',
      IP,
      '',
      false,
      false,
      false
    );
  });

  it('refuses non-free orders with a total <= 3', async () => {
    orderMock.calculateOrder.mockResolvedValue({
      success: true,
      data: {
        total: 2,
        price: '1.65',
        payment: '0.00',
        taxRate: 21,
        taxRateShipping: 21,
        boxFee: 0,
        reverseCharge: false,
        vatIdChecked: null,
      },
    });
    const result = await mollie.getPaymentUri(makeParams(), IP);
    expect(result).toEqual({ success: false, error: 'Failed to create payment' });
    expect(mollieApi.liveClient.payments.create).not.toHaveBeenCalled();
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
  });

  it('does NOT discount the VAT breakdown for partially discounted orders (suspected bug)', async () => {
    discountMock.calculateDiscounts.mockResolvedValue({
      discountAmount: 10,
      discountUseIds: [11],
      discountUsed: true,
    });

    await mollie.getPaymentUri(makeParams(), IP);

    const data = prismaMock.payment.create.mock.calls[0][0].data;
    // SUSPECTED BUG: totalPrice/totalPriceWithoutTax are net of the €10
    // discount, but productVATPrice/profit are still computed from the
    // pre-discount product price. The stored VAT (4.34) is the VAT on €25,
    // not on the €15 actually charged (which would be 15/1.21*0.21 = 2.60),
    // so totalPriceWithoutTax + totalVATPrice = 16.74 ≠ totalPrice (15) and
    // profit is overstated by the discount's ex-VAT share.
    expect(data).toMatchObject({
      totalPrice: 15,
      totalPriceWithoutTax: 12.4, // 15 / 1.21
      productVATPrice: 4.34, // pre-discount VAT
      totalVATPrice: 4.34,
      profit: 20.66, // pre-discount profit
      discount: 10,
    });
  });

  it('uses giftcard description and takes profit from the item price (digital giftcard)', async () => {
    const params = makeParams({
      cart: {
        items: [
          makeItem({ productType: 'giftcard', price: 25, playlistName: '' }),
        ],
      },
    });

    await mollie.getPaymentUri(params, IP);

    const payload = mollieApi.liveClient.payments.create.mock.calls[0][0];
    expect(payload.description).toBe('Gift card');
    // No track refresh for giftcards.
    expect(providerMock.getTracks).not.toHaveBeenCalled();
    // NOTE: digital giftcard profit is items[0].price only — a cart with
    // amount > 1 or multiple giftcards would understate profit. Matching
    // actual behavior here; flagged in the test report.
    expect(prismaMock.payment.create.mock.calls[0][0].data.profit).toBe(25);
  });

  it('describes multi-item carts (mixed → "2x Items", all giftcards → "2x Gift cards")', async () => {
    await mollie.getPaymentUri(
      makeParams({
        cart: {
          items: [makeItem(), makeItem({ productType: 'giftcard' })],
        },
      }),
      IP
    );
    expect(
      mollieApi.liveClient.payments.create.mock.calls[0][0].description
    ).toBe('2x Items');

    await mollie.getPaymentUri(
      makeParams({
        cart: {
          items: [
            makeItem({ productType: 'giftcard' }),
            makeItem({ productType: 'giftcard' }),
          ],
        },
      }),
      IP
    );
    expect(
      mollieApi.liveClient.payments.create.mock.calls[1][0].description
    ).toBe('2x Gift cards');
  });

  it('applies the fallback country when the client sent an empty countrycode', async () => {
    const params = makeParams();
    params.extraOrderData.countrycode = '';

    await mollie.getPaymentUri(params, IP, false, false, 'DE');

    expect(prismaMock.payment.create.mock.calls[0][0].data.countrycode).toBe(
      'DE'
    );
    // Methods resolved with billingCountry DE → PayPal leads.
    expect(
      mollieApi.liveClient.payments.create.mock.calls[0][0].method[0]
    ).toBe(PaymentMethod.paypal);
  });

  it('persists cached AI playlist prompts and clears them from Redis', async () => {
    cacheMock.get.mockImplementation(async (key: string) =>
      key === 'ai:sp1' ? 'songs about rain' : null
    );

    await mollie.getPaymentUri(makeParams(), IP);

    const row =
      prismaMock.payment.create.mock.calls[0][0].data.PaymentHasPlaylist
        .create[0];
    expect(row.aiPrompt).toBe('songs about rain');
    expect(cacheMock.del).toHaveBeenCalledWith('ai:sp1');
  });

  it('records a QRGames purchase and box pricing for cards with games + boxes', async () => {
    const params = makeParams({
      cart: {
        items: [
          makeItem({
            productType: 'cards',
            gamesEnabled: true,
            boxEnabled: true,
            boxQuantity: 2,
          }),
        ],
      },
    });

    await mollie.getPaymentUri(params, IP);

    const row =
      prismaMock.payment.create.mock.calls[0][0].data.PaymentHasPlaylist
        .create[0];
    expect(row).toMatchObject({
      gamesEnabled: true,
      gamesPrice: 5,
      boxEnabled: true,
      boxQuantity: 2,
      boxPrice: Number((2 * BOX_PRICE).toFixed(2)), // 13.98
    });
    expect(prismaMock.gamesPurchase.create).toHaveBeenCalledWith({
      data: {
        userId: 42,
        totalPrice: 5,
        playlistCount: 1,
        pricePerPlaylist: 5,
        type: 'initial',
        countrycode: 'NL',
        taxRate: 21,
        molliePaymentId: 'tr_test123',
      },
    });
  });

  it('refreshes stale track counts and reprices the item before charging', async () => {
    providerMock.getTracks.mockResolvedValue({
      success: true,
      data: { total: 120 },
    });
    orderMock.getOrderType.mockResolvedValue({ id: 9, amount: 30 });

    await mollie.getPaymentUri(makeParams(), IP);

    // Refresh recalculated the price using the fresh count.
    expect(orderMock.getOrderType).toHaveBeenCalledWith(
      120,
      true,
      'cards',
      'sp1',
      'none'
    );
    const row =
      prismaMock.payment.create.mock.calls[0][0].data.PaymentHasPlaylist
        .create[0];
    expect(row).toMatchObject({
      numberOfTracks: 120,
      price: 30, // repriced from orderType.amount
      orderTypeId: 9,
      printApiPrice: 30,
    });
  });
});

// ---------------------------------------------------------------------------
// processWebhook
// ---------------------------------------------------------------------------

describe('processWebhook', () => {
  it('ignores webhooks without an id', async () => {
    const result = await mollie.processWebhook({});
    expect(result).toEqual({ success: true });
    expect(mollieApi.liveClient.payments.get).not.toHaveBeenCalled();
  });

  it('rejects non-Mollie payment id formats', async () => {
    const result = await mollie.processWebhook({ id: 'free_abc' });
    expect(result).toEqual({
      success: false,
      error: 'Invalid payment ID format',
    });
    expect(mollieApi.liveClient.payments.get).not.toHaveBeenCalled();
  });

  it('paid: claims the status flip, clears cache, credits promos and queues generation', async () => {
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_x',
        status: 'paid',
        method: 'ideal',
        metadata: { clientIp: '9.9.9.9', refreshPlaylists: 'a,b' },
        settlementAmount: { currency: 'EUR', value: '25.00' },
      })
    );
    prismaMock.payment.findUnique.mockResolvedValue({
      id: 10,
      paymentId: 'tr_x',
      status: 'open',
      user: { hash: 'uhash' },
    });
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      { playlistId: 1 },
      { playlistId: 2 },
    ]);

    const result = await mollie.processWebhook({ id: 'tr_x' });

    expect(result).toEqual({ success: true });
    expect(prismaMock.payment.updateMany).toHaveBeenCalledWith({
      where: { paymentId: 'tr_x', status: { not: 'paid' } },
      data: {
        status: 'paid',
        paymentMethod: 'ideal',
        settlementAmountEur: 25,
      },
    });
    expect(cacheMock.del).toHaveBeenCalledWith('playlists:user:uhash');
    expect(promotionalMock.creditPromotionalDiscount).toHaveBeenCalledTimes(2);
    expect(promotionalMock.creditPromotionalDiscount).toHaveBeenCalledWith(
      1,
      10
    );
    expect(promotionalMock.creditPromotionalDiscount).toHaveBeenCalledWith(
      2,
      10
    );
    expect(generatorMock.queueGenerate).toHaveBeenCalledWith(
      'tr_x',
      '9.9.9.9',
      'a,b',
      false,
      false,
      false
    );
  });

  it('replayed paid webhook (no status flip) skips all side effects', async () => {
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_x',
        status: 'paid',
        metadata: { clientIp: '9.9.9.9', refreshPlaylists: '' },
      })
    );
    prismaMock.payment.findUnique.mockResolvedValue({
      id: 10,
      paymentId: 'tr_x',
      status: 'paid',
      user: { hash: 'uhash' },
    });
    prismaMock.payment.updateMany.mockResolvedValue({ count: 0 });

    const result = await mollie.processWebhook({ id: 'tr_x' });

    expect(result).toEqual({ success: true });
    expect(generatorMock.queueGenerate).not.toHaveBeenCalled();
    expect(cacheMock.del).not.toHaveBeenCalled();
    expect(promotionalMock.creditPromotionalDiscount).not.toHaveBeenCalled();
  });

  it('failed/expired payments release their discount uses (no settlementAmountEur)', async () => {
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({ id: 'tr_x', status: 'expired', method: 'ideal' })
    );
    prismaMock.payment.findUnique.mockResolvedValue({
      id: 10,
      paymentId: 'tr_x',
      status: 'open',
      user: { hash: 'uhash' },
    });

    const result = await mollie.processWebhook({ id: 'tr_x' });

    expect(result).toEqual({ success: true });
    const updateData = prismaMock.payment.updateMany.mock.calls[0][0].data;
    expect(updateData).toEqual({ status: 'expired', paymentMethod: 'ideal' });
    expect('settlementAmountEur' in updateData).toBe(false);
    expect(discountMock.removeDiscountUsesByPaymentId).toHaveBeenCalledWith(10);
    expect(generatorMock.queueGenerate).not.toHaveBeenCalled();
  });

  it('returns success for webhooks about payments we do not know', async () => {
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({ id: 'tr_unknown', status: 'paid' })
    );
    prismaMock.payment.findUnique.mockResolvedValue(null);

    const result = await mollie.processWebhook({ id: 'tr_unknown' });

    expect(result).toEqual({ success: true });
    expect(prismaMock.payment.updateMany).not.toHaveBeenCalled();
  });

  it('falls back to the test Mollie client when the live lookup fails', async () => {
    mollieApi.liveClient.payments.get.mockRejectedValue(new Error('404'));
    mollieApi.testClient.payments.get.mockResolvedValue(
      fakeMolliePayment({ id: 'tr_t', status: 'open' })
    );
    prismaMock.payment.findUnique.mockResolvedValue({
      id: 11,
      paymentId: 'tr_t',
      status: 'open',
      user: { hash: 'h' },
    });
    prismaMock.payment.updateMany.mockResolvedValue({ count: 0 });

    const result = await mollie.processWebhook({ id: 'tr_t' });

    expect(mollieApi.testClient.payments.get).toHaveBeenCalledWith('tr_t');
    expect(result).toEqual({ success: true });
  });

  it('routes paid bingo_upgrade payments to the bingo module', async () => {
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_bingo',
        status: 'paid',
        metadata: {
          type: 'bingo_upgrade',
          paymentHasPlaylistIds: '1,2',
          userId: '5',
          pricePerPlaylist: '4.5',
        },
      })
    );

    const result = await mollie.processWebhook({ id: 'tr_bingo' });

    expect(bingoMock.processBingoUpgradePayment).toHaveBeenCalledWith(
      '1,2',
      5,
      4.5,
      'tr_bingo'
    );
    expect(result).toEqual({ success: true });
    // Bingo upgrades never reach the regular order flow.
    expect(prismaMock.payment.updateMany).not.toHaveBeenCalled();
  });

  it('box_upgrade: enables the box, re-derives VAT, increments totalPrice and orders printing', async () => {
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_box',
        status: 'paid',
        metadata: {
          type: 'box_upgrade',
          paymentHasPlaylistId: '77',
          userId: '5',
          originalPaymentId: 'tr_orig',
          quantity: '2',
          boxPrice: '6.99',
          shippingCost: '3.50',
        },
      })
    );
    prismaMock.paymentHasPlaylist.findUnique
      .mockResolvedValueOnce({
        boxEnabled: false,
        payment: { sentToPrinter: true },
      }) // idempotency check
      .mockResolvedValueOnce({ payment: { countrycode: 'NL' } }) // VAT lookup
      .mockResolvedValueOnce({ payment: { user: { hash: 'h2' } } }); // cache clear

    const result = await mollie.processWebhook({ id: 'tr_box' });

    expect(result).toEqual({ success: true });
    expect(prismaMock.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 77 },
      data: { boxEnabled: true, boxPrice: 13.98 }, // 6.99 * 2
    });
    // 13.98 + VAT(13.98 * 21% = 2.94) + shipping 3.50 = 20.42
    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'tr_orig' },
      data: { totalPrice: { increment: 20.42 } },
    });
    expect(generatorMock.generateBoxInsertPdf).toHaveBeenCalledWith(
      77,
      'tr_orig',
      2
    );
    expect(
      outbound.calls('PrintEnBind', 'createBoxUpgradeOrder').map((c) => c.args)
    ).toEqual([[77, 2]]);
    expect(cacheMock.del).toHaveBeenCalledWith('playlists:user:h2');
  });

  it('box_upgrade is idempotent when the box is already enabled', async () => {
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_box',
        status: 'paid',
        metadata: {
          type: 'box_upgrade',
          paymentHasPlaylistId: '77',
          userId: '5',
          originalPaymentId: 'tr_orig',
          quantity: '1',
        },
      })
    );
    prismaMock.paymentHasPlaylist.findUnique.mockResolvedValueOnce({
      boxEnabled: true,
      payment: { sentToPrinter: false },
    });

    const result = await mollie.processWebhook({ id: 'tr_box' });

    expect(result).toEqual({ success: true });
    expect(prismaMock.paymentHasPlaylist.update).not.toHaveBeenCalled();
    expect(prismaMock.payment.update).not.toHaveBeenCalled();
    expect(outbound.calls('PrintEnBind', 'createBoxUpgradeOrder')).toEqual([]);
  });

  it('box_upgrade skips the separate print order when the main order has not shipped', async () => {
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_box',
        status: 'paid',
        metadata: {
          type: 'box_upgrade',
          paymentHasPlaylistId: '77',
          userId: '5',
          originalPaymentId: 'tr_orig',
          quantity: '1',
        },
      })
    );
    prismaMock.paymentHasPlaylist.findUnique
      .mockResolvedValueOnce({
        boxEnabled: false,
        payment: { sentToPrinter: false },
      })
      .mockResolvedValueOnce({ payment: { countrycode: 'NL' } })
      .mockResolvedValueOnce(null);

    const result = await mollie.processWebhook({ id: 'tr_box' });

    expect(result).toEqual({ success: true });
    // boxPrice falls back to BOX_PRICE when metadata carries none.
    expect(prismaMock.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 77 },
      data: { boxEnabled: true, boxPrice: 6.99 },
    });
    expect(outbound.calls('PrintEnBind', 'createBoxUpgradeOrder')).toEqual([]);
  });

  it('tracks_upgrade: bumps the track count, books the charge and sets the idempotency key', async () => {
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_tracks',
        status: 'paid',
        amount: { currency: 'EUR', value: '10.00' },
        metadata: {
          type: 'tracks_upgrade',
          paymentHasPlaylistId: '88',
          userId: '5',
          originalPaymentId: 'tr_orig',
          extraTracks: '50',
          previousNumberOfTracks: '100',
        },
      })
    );
    prismaMock.paymentHasPlaylist.findUnique
      .mockResolvedValueOnce({ id: 88, numberOfTracks: 100 })
      .mockResolvedValueOnce({ payment: { user: { hash: 'h3' } } });

    const result = await mollie.processWebhook({ id: 'tr_tracks' });

    expect(result).toEqual({ success: true });
    expect(dataMock.updatePlaylistDetails).toHaveBeenCalledWith(
      88,
      150,
      undefined
    );
    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'tr_orig' },
      data: { totalPrice: { increment: 10 } },
    });
    expect(cacheMock.set).toHaveBeenCalledWith(
      'tracks_upgrade_processed:tr_tracks',
      '1',
      60 * 60 * 24 * 60
    );
    expect(cacheMock.del).toHaveBeenCalledWith('playlists:user:h3');
    // No extra boxes in metadata → no box bump.
    expect(prismaMock.paymentHasPlaylist.update).not.toHaveBeenCalled();
  });

  it('tracks_upgrade replays are skipped via the Redis idempotency key', async () => {
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_tracks',
        status: 'paid',
        metadata: {
          type: 'tracks_upgrade',
          paymentHasPlaylistId: '88',
          userId: '5',
          originalPaymentId: 'tr_orig',
          extraTracks: '50',
        },
      })
    );
    cacheMock.get.mockResolvedValue('1');

    const result = await mollie.processWebhook({ id: 'tr_tracks' });

    expect(result).toEqual({ success: true });
    expect(dataMock.updatePlaylistDetails).not.toHaveBeenCalled();
    expect(prismaMock.payment.update).not.toHaveBeenCalled();
  });

  it('tracks_upgrade rolls spilled-over boxes into boxQuantity/boxPrice', async () => {
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_tracks',
        status: 'paid',
        amount: { currency: 'EUR', value: '22.50' },
        metadata: {
          type: 'tracks_upgrade',
          paymentHasPlaylistId: '88',
          userId: '5',
          originalPaymentId: 'tr_orig',
          extraTracks: '200',
          extraBoxes: '2',
          newBoxQuantity: '3',
          boxUnitPriceEur: '5.00',
        },
      })
    );
    prismaMock.paymentHasPlaylist.findUnique
      .mockResolvedValueOnce({ id: 88, numberOfTracks: 150 })
      .mockResolvedValueOnce(null);

    await mollie.processWebhook({ id: 'tr_tracks' });

    expect(prismaMock.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 88 },
      data: { boxQuantity: 3, boxPrice: { increment: 10 } }, // 5.00 * 2
    });
  });
});

// ---------------------------------------------------------------------------
// checkPaymentStatus
// ---------------------------------------------------------------------------

describe('checkPaymentStatus', () => {
  it('maps paid statuses to success', async () => {
    const payment = { status: 'paid', user: { userId: 'u', hash: 'h' } };
    prismaMock.payment.findUnique.mockResolvedValue(payment);
    expect(await mollie.checkPaymentStatus('tr_1')).toEqual({
      success: true,
      data: { status: 'paid', payment },
    });
  });

  it('maps open/pending/authorized statuses to non-success "open"', async () => {
    for (const status of ['open', 'pending', 'authorized']) {
      prismaMock.payment.findUnique.mockResolvedValue({ status, user: {} });
      expect(await mollie.checkPaymentStatus('tr_1')).toEqual({
        success: false,
        data: { status: 'open' },
      });
    }
  });

  it('maps failed/canceled/expired statuses to "failed"', async () => {
    for (const status of ['failed', 'canceled', 'expired']) {
      prismaMock.payment.findUnique.mockResolvedValue({ status, user: {} });
      expect(await mollie.checkPaymentStatus('tr_1')).toEqual({
        success: false,
        data: { status: 'failed' },
      });
    }
  });

  it('returns an error for unknown payments', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(null);
    expect(await mollie.checkPaymentStatus('tr_nope')).toEqual({
      success: false,
      error: 'Error checking payment status',
    });
  });
});

// ---------------------------------------------------------------------------
// createRefund
// ---------------------------------------------------------------------------

describe('createRefund', () => {
  it('refunds EUR payments with the exact 2-decimal amount string', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({
      currency: 'EUR',
      exchangeRate: 1,
      totalPrice: 40,
      totalPricePresentment: 40,
    });

    const result = await mollie.createRefund('tr_1', 10);

    expect(mollieApi.liveClient.paymentRefunds.create).toHaveBeenCalledWith({
      paymentId: 'tr_1',
      amount: { currency: 'EUR', value: '10.00' },
    });
    expect(result).toEqual({
      success: true,
      data: {
        refundId: 're_1',
        amount: '10.00',
        currency: 'EUR',
        status: 'pending',
      },
    });
  });

  it('converts non-EUR refunds proportionally to the presentment total', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({
      currency: 'SEK',
      exchangeRate: 11.5,
      totalPrice: 40, // EUR
      totalPricePresentment: 460, // SEK
    });

    await mollie.createRefund('tr_1', 10); // refund 25% of the order

    expect(mollieApi.liveClient.paymentRefunds.create).toHaveBeenCalledWith({
      paymentId: 'tr_1',
      amount: { currency: 'SEK', value: '115.00' }, // 10/40 * 460
    });
  });

  it('falls back to the stored exchange rate when totals are missing', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({
      currency: 'SEK',
      exchangeRate: 11.5,
      totalPrice: 0,
      totalPricePresentment: 0,
    });

    await mollie.createRefund('tr_1', 10);

    expect(mollieApi.liveClient.paymentRefunds.create).toHaveBeenCalledWith({
      paymentId: 'tr_1',
      amount: { currency: 'SEK', value: '115.00' }, // 10 * 11.5
    });
  });

  it('surfaces Mollie errors as a failed ApiResult', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(null); // unknown → EUR
    mollieApi.liveClient.paymentRefunds.create.mockRejectedValue(
      new Error('Refund too large')
    );

    expect(await mollie.createRefund('tr_1', 10)).toEqual({
      success: false,
      error: 'Refund too large',
    });
  });
});

// ---------------------------------------------------------------------------
// createPaymentLink
// ---------------------------------------------------------------------------

describe('createPaymentLink', () => {
  it('creates an EUR payment link with a default description', async () => {
    const result = await mollie.createPaymentLink(12.345);

    expect(mollieApi.liveClient.paymentLinks.create).toHaveBeenCalledWith({
      amount: { currency: 'EUR', value: '12.35' }, // toFixed(2) rounds
      description: 'QRSong! Custom Payment - EUR 12.35',
    });
    expect(result).toEqual({
      success: true,
      data: {
        paymentLinkId: 'pl_1',
        paymentLink: 'https://paymentlink.mollie.com/payment/pl_1',
        amount: '12.35',
        description: 'A link',
      },
    });
  });

  it('returns the Mollie error message on failure', async () => {
    mollieApi.liveClient.paymentLinks.create.mockRejectedValue(
      new Error('Invalid amount')
    );
    expect(await mollie.createPaymentLink(5, 'custom')).toEqual({
      success: false,
      error: 'Invalid amount',
    });
  });
});

// ---------------------------------------------------------------------------
// createUpgradePayment
// ---------------------------------------------------------------------------

describe('createUpgradePayment', () => {
  it('converts the EUR amount, filters methods per currency and builds the payload', async () => {
    const result = await mollie.createUpgradePayment({
      amountEur: 5,
      requestedCurrency: 'USD',
      description: 'QRGames upgrade',
      locale: 'de',
      redirectUrl: 'https://example.com/back',
      metadata: { type: 'bingo_upgrade', userId: '5' },
      clientIp: '1.2.3.4',
      billingCountry: 'DE',
    });

    expect(mollieApi.liveClient.payments.create).toHaveBeenCalledWith({
      amount: { currency: 'USD', value: '6.00' }, // 5 EUR × 1.2
      method: [
        PaymentMethod.paypal,
        PaymentMethod.creditcard,
        PaymentMethod.applepay,
      ], // DE list filtered to USD-capable methods
      metadata: { type: 'bingo_upgrade', userId: '5' },
      description: 'QRGames upgrade',
      redirectUrl: 'https://example.com/back',
      webhookUrl: 'http://localhost:3004/mollie/webhook',
      locale: Locale.de_DE,
    });
    expect(result).toEqual({
      id: 'tr_test123',
      checkoutUrl: 'https://pay.mollie.test/tr_test123',
      currency: 'USD',
      amount: 6,
    });
  });

  it('defaults to EUR when no currency is requested', async () => {
    await mollie.createUpgradePayment({
      amountEur: 5,
      description: 'd',
      locale: 'en',
      redirectUrl: 'https://example.com',
      metadata: {},
      clientIp: '1.2.3.4',
    });
    expect(fxMock.tryConvert).toHaveBeenCalledWith(5, 'EUR');
    expect(
      mollieApi.liveClient.payments.create.mock.calls[0][0].amount
    ).toEqual({ currency: 'EUR', value: '5.00' });
  });
});

// ---------------------------------------------------------------------------
// canDownloadPDF / deletePayment
// ---------------------------------------------------------------------------

describe('canDownloadPDF', () => {
  it('returns true only when the playlist belongs to the payment', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({
      PaymentHasPlaylist: [
        { playlist: { playlistId: 'spA' } },
        { playlist: { playlistId: 'spB' } },
      ],
    });
    expect(await mollie.canDownloadPDF('spB', 'tr_1')).toBe(true);
    expect(await mollie.canDownloadPDF('spZ', 'tr_1')).toBe(false);
  });

  it('returns false when the payment does not exist', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(null);
    expect(await mollie.canDownloadPDF('spA', 'tr_missing')).toBe(false);
  });
});

describe('deletePayment', () => {
  it('fails when the payment is not found', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(null);
    expect(await mollie.deletePayment('tr_x')).toEqual({
      success: false,
      error: 'Payment not found',
    });
    expect(prismaMock.payment.delete).not.toHaveBeenCalled();
  });

  it('deletes existing payments by paymentId', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({ id: 1 });
    expect(await mollie.deletePayment('tr_x')).toEqual({ success: true });
    expect(prismaMock.payment.delete).toHaveBeenCalledWith({
      where: { paymentId: 'tr_x' },
    });
  });

  it('wraps database errors', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({ id: 1 });
    prismaMock.payment.delete.mockRejectedValue(new Error('FK violation'));
    expect(await mollie.deletePayment('tr_x')).toEqual({
      success: false,
      error: 'Failed to delete payment from database',
    });
  });
});

// ---------------------------------------------------------------------------
// getPaymentsByDay (refund netting math)
// ---------------------------------------------------------------------------

describe('getPaymentsByDay', () => {
  it('groups per day, nets refunds proportionally and sorts newest first', async () => {
    const day2 = new Date('2025-01-02T10:00:00Z');
    const day2b = new Date('2025-01-02T18:00:00Z');
    const day3 = new Date('2025-01-03T09:00:00Z');
    prismaMock.payment.groupBy.mockResolvedValue([
      {
        createdAt: day2,
        _count: { _all: 1 },
        _sum: { totalPrice: 50, totalPriceWithoutTax: 41.32 },
      },
      {
        createdAt: day2b,
        _count: { _all: 1 },
        _sum: { totalPrice: 50, totalPriceWithoutTax: 41.32 },
      },
      {
        createdAt: day3,
        _count: { _all: 1 },
        _sum: { totalPrice: 30, totalPriceWithoutTax: 24.79 },
      },
    ]);
    // One 50% partial refund on 2025-01-02: refund 25 of a 50 gross payment.
    prismaMock.payment.findMany.mockResolvedValue([
      {
        createdAt: day2,
        countrycode: 'NL',
        taxRate: 21,
        totalPrice: 50,
        totalPriceWithoutTax: 41.32,
        productVATPrice: 8.68,
        refundAmount: 25,
      },
    ]);

    const report = await mollie.getPaymentsByDay();

    expect(report).toHaveLength(2);
    expect(report[0].day).toBe('2025-01-03');
    expect(report[0]).toMatchObject({
      numberOfSales: 1,
      totalPrice: 30,
      totalRefunded: 0,
    });

    expect(report[1].day).toBe('2025-01-02');
    expect(report[1].numberOfSales).toBe(2);
    expect(report[1].totalPrice).toBe(75); // 100 - 25
    // ex-VAT netted by the refund's proportional ex-VAT share:
    // 82.64 - (41.32 * 25/50) = 61.98
    expect(report[1].totalPriceWithoutTax).toBeCloseTo(61.98, 2);
    expect(report[1].totalRefunded).toBe(25);
  });
});
