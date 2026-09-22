/**
 * Unit tests for src/mollie.ts (payment creation, webhook processing,
 * status checks, refunds, payment links, upgrade payments, method/locale
 * resolution, the daily sales report refund math and the App Designer
 * figures in the sales, country and tax reports).
 *
 * Everything outbound is mocked at the module boundary:
 *  - mollie-api-typescript → Client class replaced (HTTPClient stays real so
 *                            the settlementAmount response hook is exercised);
 *                            first client constructed = "live", second =
 *                            "test" (matches field init order).
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
    payments: {
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      cancel: vi.fn(),
    },
    paymentLinks: { create: vi.fn() },
    refunds: { create: vi.fn() },
  });
  const liveClient = makeClient();
  const testClient = makeClient();
  let calls = 0;
  // Mollie class fields: `mollieClient` (live key) is initialized before
  // `mollieClientTest`, so the first Client constructed is the live one.
  // A constructor returning an object hands that object back from `new`.
  const Client = vi.fn(function () {
    return calls++ % 2 === 0 ? liveClient : testClient;
  });
  return { liveClient, testClient, Client };
});
vi.mock('mollie-api-typescript', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, Client: mollieApi.Client };
});

const prismaMock = vi.hoisted(() => ({
  payment: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
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
    count: vi.fn(),
  },
  user: { update: vi.fn() },
  gamesPurchase: { create: vi.fn(), groupBy: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  appDesignPurchase: { groupBy: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  $queryRawUnsafe: vi.fn(),
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
  attachPaymentToDiscountUses: vi.fn(),
  confirmDiscountUsesByIds: vi.fn(),
  confirmDiscountUsesByPaymentId: vi.fn(),
  releaseDiscountUsesByPaymentId: vi.fn(),
  removeDiscountUsesByIds: vi.fn(),
  supersedeOpenReservations: vi.fn(),
  sweepExpiredReservations: vi.fn(),
}));
vi.mock('../../../src/discount', () => {
  class DiscountStub {
    calculateDiscounts = discountMock.calculateDiscounts;
    attachPaymentToDiscountUses = discountMock.attachPaymentToDiscountUses;
    confirmDiscountUsesByIds = discountMock.confirmDiscountUsesByIds;
    confirmDiscountUsesByPaymentId =
      discountMock.confirmDiscountUsesByPaymentId;
    releaseDiscountUsesByPaymentId =
      discountMock.releaseDiscountUsesByPaymentId;
    removeDiscountUsesByIds = discountMock.removeDiscountUsesByIds;
    supersedeOpenReservations = discountMock.supersedeOpenReservations;
    sweepExpiredReservations = discountMock.sweepExpiredReservations;
    // Same normalisation as the real class (trim, upper-case, dedupe).
    static normalizeCodes(discounts?: { code?: string }[] | null): string[] {
      const out: string[] = [];
      for (const d of discounts || []) {
        const code = String(d?.code || '').trim().toUpperCase();
        if (code && !out.includes(code)) out.push(code);
      }
      return out;
    }
  }
  class DiscountApplyError extends Error {
    constructor(public code: string, public messageKey: string) {
      super(`Discount ${code}: ${messageKey}`);
    }
  }
  return { default: DiscountStub, DiscountApplyError };
});

const translationMock = vi.hoisted(() => ({
  getTranslationsByPrefix: vi.fn(),
  // Echoes the key and its params, so invoice lines can be asserted.
  translate: vi.fn((key: string, _locale?: string, options?: Record<string, any>) =>
    options ? `${key} ${JSON.stringify(options)}` : key
  ),
}));
vi.mock('../../../src/translation', () => ({
  default: class {
    getTranslationsByPrefix = translationMock.getTranslationsByPrefix;
    translate = translationMock.translate;
  },
}));

const utilsMock = vi.hoisted(() => ({
  isMainServer: vi.fn(async () => false),
  isTrustedIp: vi.fn(() => false),
  lookupIp: vi.fn(async () => null as any),
  generateRandomString: vi.fn(() => 'RND1234567'),
}));
vi.mock('../../../src/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils')>();
  return {
    default: class {
      isMainServer = utilsMock.isMainServer;
      isTrustedIp = utilsMock.isTrustedIp;
      lookupIp = utilsMock.lookupIp;
      generateRandomString = utilsMock.generateRandomString;
      // Pure helper; use the real one so tinyint/boolean coercion is exercised.
      parseBoolean = actual.default.prototype.parseBoolean;
    },
  };
});

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

const appDesignMock = vi.hoisted(() => ({ processUpgradePayment: vi.fn() }));
vi.mock('../../../src/appDesign', () => ({
  default: { getInstance: () => appDesignMock },
}));

const upgradeInvoicesMock = vi.hoisted(() => ({ issue: vi.fn() }));
vi.mock('../../../src/upgradeInvoice', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  default: { getInstance: () => upgradeInvoicesMock },
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
    links: { checkout: { href: 'https://pay.mollie.test/tr_test123' } },
    ...over,
  };
}

/**
 * The SDK's payment schema has no `settlementAmount` and strips unknown keys,
 * so src/mollie.ts lifts it off the raw response body in an HTTPClient hook.
 * The client is mocked here, so seed what that hook would have stored.
 */
function seedSettlement(
  paymentId: string,
  value: string,
  currency = 'EUR'
): void {
  (mollie as any).settlementAmounts.set(paymentId, { currency, value });
}

function applyDefaults(): void {
  (mollie as any).settlementAmounts.clear();
  prismaMock.payment.findUnique.mockResolvedValue(null);
  prismaMock.payment.findFirst.mockResolvedValue(null);
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
  prismaMock.paymentHasPlaylist.count.mockResolvedValue(0);
  prismaMock.user.update.mockResolvedValue({});
  prismaMock.gamesPurchase.create.mockResolvedValue({});
  prismaMock.gamesPurchase.groupBy.mockResolvedValue([]);
  prismaMock.gamesPurchase.findMany.mockResolvedValue([]);
  prismaMock.gamesPurchase.findFirst.mockResolvedValue(null);
  prismaMock.appDesignPurchase.groupBy.mockResolvedValue([]);
  prismaMock.appDesignPurchase.findMany.mockResolvedValue([]);
  prismaMock.appDesignPurchase.findUnique.mockResolvedValue(null);
  prismaMock.$queryRawUnsafe.mockResolvedValue([]);
  upgradeInvoicesMock.issue.mockResolvedValue(undefined);

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
    percentAmount: 0,
    percent: null,
    label: '',
  });
  discountMock.attachPaymentToDiscountUses.mockResolvedValue(undefined);
  discountMock.confirmDiscountUsesByIds.mockResolvedValue(undefined);
  discountMock.confirmDiscountUsesByPaymentId.mockResolvedValue({
    count: 0,
    shortfalls: [],
  });
  discountMock.releaseDiscountUsesByPaymentId.mockResolvedValue({
    success: true,
    count: 0,
    message: 'discountUsesReleasedSuccessfully',
  });
  discountMock.removeDiscountUsesByIds.mockResolvedValue({
    success: true,
    message: 'discountUsesRemovedSuccessfully',
  });
  discountMock.supersedeOpenReservations.mockResolvedValue({ paymentIds: [] });
  discountMock.sweepExpiredReservations.mockResolvedValue(0);
  mollieApi.liveClient.payments.cancel.mockResolvedValue({});

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
  mollieApi.liveClient.payments.update.mockResolvedValue(fakeMolliePayment());
  mollieApi.testClient.payments.update.mockResolvedValue(fakeMolliePayment());
  mollieApi.liveClient.payments.get.mockRejectedValue(
    new Error('payments.get not stubbed (live)')
  );
  mollieApi.testClient.payments.get.mockRejectedValue(
    new Error('payments.get not stubbed (test)')
  );
  mollieApi.liveClient.paymentLinks.create.mockResolvedValue({
    id: 'pl_1',
    description: 'A link',
    links: {
      paymentLink: { href: 'https://paymentlink.mollie.com/payment/pl_1' },
    },
  });
  mollieApi.liveClient.refunds.create.mockResolvedValue({
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
        'ideal',
        'creditcard',
        'swish',
        'klarna',
      ],
      'SEK'
    );
    expect(result).toEqual([
      'creditcard',
      'swish',
      'klarna',
    ]);
  });

  it('treats unmapped methods as EUR-only', () => {
    expect(
      mollie.filterMethodsByCurrency(['banktransfer'], 'SEK')
    ).toEqual([]);
    expect(
      mollie.filterMethodsByCurrency(['banktransfer'], 'EUR')
    ).toEqual(['banktransfer']);
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
    expect(result.locale).toBe('nl_NL');
    expect(result.methods).toEqual([
      'ideal',
      'applepay',
      'creditcard',
      'paypal',
      'klarna',
      'in3',
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
    expect(result.locale).toBe('sv_SE');
    // DE list first, then SE list (deduped), then fallback (deduped),
    // finally filtered to SEK-capable methods (directdebit/paysafecard are
    // EUR-only and drop out).
    expect(result.methods).toEqual([
      'paypal',
      'klarna',
      'creditcard',
      'applepay',
      'riverty',
      'trustly',
      'swish',
    ]);
  });

  it('falls back to the generic list when no signal is present', () => {
    const result = mollie.resolveMollieMethods({
      language: 'hi',
      currency: 'EUR',
    });
    expect(result.country).toBeNull();
    expect(result.countrySource).toBe('none');
    expect(result.locale).toBe('en_US');
    expect(result.methods).toEqual([
      'creditcard',
      'paypal',
      'applepay',
      'klarna',
    ]);
  });

  it('resolves country-dependent locales (de_AT, fr_BE, nl_BE)', () => {
    expect(
      mollie.resolveMollieMethods({
        language: 'de',
        billingCountry: 'AT',
        currency: 'EUR',
      }).locale
    ).toBe('de_AT');
    expect(
      mollie.resolveMollieMethods({
        language: 'fr',
        billingCountry: 'BE',
        currency: 'EUR',
      }).locale
    ).toBe('fr_BE');
    expect(
      mollie.resolveMollieMethods({
        language: 'nl',
        billingCountry: 'BE',
        currency: 'EUR',
      }).locale
    ).toBe('nl_BE');
    expect(
      mollie.resolveMollieMethods({
        language: 'de',
        billingCountry: 'CH',
        currency: 'EUR',
      }).locale
    ).toBe('de_CH');
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
    expect(result.methods[0]).toBe('blik');
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
      paymentRequest: {
        amount: { currency: 'EUR', value: '25.00' },
        metadata: { clientIp: IP, refreshPlaylists: '' },
        method: ['ideal', 'applepay', 'creditcard', 'paypal', 'klarna', 'in3'],
        description: 'Playlist : Best Hits',
        redirectUrl: 'http://localhost:4200/nl/generate/check_payment',
        webhookUrl: 'http://localhost:3004/mollie/webhook',
        locale: 'nl_NL',
      },
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

  it('patches the redirect URL with the payment id after creation', async () => {
    await mollie.getPaymentUri(makeParams(), IP);

    expect(mollieApi.liveClient.payments.update).toHaveBeenCalledWith({
      paymentId: 'tr_test123',
      requestBody: {
        redirectUrl:
          'http://localhost:4200/nl/generate/check_payment?paymentId=tr_test123',
      },
    });
  });

  it('still returns a checkout URL when patching the redirect URL fails', async () => {
    mollieApi.liveClient.payments.update.mockRejectedValue(
      new Error('Mollie rejected the update')
    );

    const result = await mollie.getPaymentUri(makeParams(), IP);

    expect(result.success).toBe(true);
    expect(result.data.paymentUri).toBe('https://pay.mollie.test/tr_test123');
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

  it('normalises tinyint 1/0 design flags to booleans', async () => {
    // A cart item rebuilt from a stored design (dashboard reorder, designer
    // page) carries MySQL tinyint flags from the raw SQL readers. Prisma
    // rejects Int for Boolean columns, which used to abort payment creation
    // with "Argument `useGradient`: Invalid value provided. Expected Boolean,
    // provided Int."
    const params = makeParams({
      cart: {
        items: [
          makeItem({
            doubleSided: 1,
            eco: 0,
            hideCircle: 0,
            allowDuplicates: 1,
            useFrontGradient: 0,
            useGradient: 1,
            gamesEnabled: 1,
            boxEnabled: 0,
            boxFrontUseFrontGradient: 1,
            boxBackUseGradient: 0,
          }),
        ],
      },
    });

    const result = await mollie.getPaymentUri(params, IP);

    expect(result.success).toBe(true);
    const row =
      prismaMock.payment.create.mock.calls[0][0].data.PaymentHasPlaylist
        .create[0];
    // toMatchObject is strict about type: 1 does not match true.
    expect(row).toMatchObject({
      doubleSided: true,
      eco: false,
      hideCircle: false,
      qrBackgroundType: 'square',
      allowDuplicates: true,
      useFrontGradient: false,
      useGradient: true,
      gamesEnabled: true,
      boxEnabled: false,
      boxFrontUseFrontGradient: true,
      boxBackUseGradient: false,
    });
    expect(row.gamesPrice).toBeGreaterThan(0);
  });

  it('converts to the presentment currency and filters methods (USD)', async () => {
    const result = await mollie.getPaymentUri(
      makeParams({ currency: 'USD' }),
      IP
    );

    expect(fxMock.tryConvert).toHaveBeenCalledWith(25, 'USD');
    const payload = mollieApi.liveClient.payments.create.mock.calls[0][0].paymentRequest;
    expect(payload.amount).toEqual({ currency: 'USD', value: '30.00' });
    // NL list minus EUR-only methods (ideal, klarna, in3 don't take USD).
    expect(payload.method).toEqual([
      'applepay',
      'creditcard',
      'paypal',
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
    const payload = mollieApi.liveClient.payments.create.mock.calls[0][0].paymentRequest;
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
    // Free orders never get a webhook, so the reservation is settled here.
    expect(discountMock.confirmDiscountUsesByIds).toHaveBeenCalledWith(
      [11],
      555
    );
    expect(discountMock.attachPaymentToDiscountUses).not.toHaveBeenCalled();
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
    // A stable code so the checkout can say "this order is too small to pay
    // online" instead of a generic failure the user can't act on.
    expect(result).toEqual({ success: false, error: 'amount_too_low' });
    expect(mollieApi.liveClient.payments.create).not.toHaveBeenCalled();
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
  });

  it('releases reserved discount uses when payment creation fails', async () => {
    // calculateDiscounts() redeems the voucher before the Mollie payment
    // exists, and the webhook cannot clean up rows that have no paymentId — so
    // without this the customer's voucher was burned by a payment that never
    // happened, and burned again on every retry.
    discountMock.calculateDiscounts.mockResolvedValue({
      discountAmount: 5,
      discountUseIds: [41, 42],
      discountUsed: true,
    });
    mollieApi.liveClient.payments.create.mockRejectedValue(
      new Error('Mollie is down')
    );

    const result = await mollie.getPaymentUri(makeParams(), IP);

    expect(result.success).toBe(false);
    expect(discountMock.removeDiscountUsesByIds).toHaveBeenCalledWith([41, 42]);
  });

  it('does not try to release anything when no discount was used', async () => {
    mollieApi.liveClient.payments.create.mockRejectedValue(
      new Error('Mollie is down')
    );

    await mollie.getPaymentUri(makeParams(), IP);

    expect(discountMock.removeDiscountUsesByIds).not.toHaveBeenCalled();
  });

  it('computes VAT and profit net of the discount and snapshots it on the row', async () => {
    discountMock.calculateDiscounts.mockResolvedValue({
      discountAmount: 10,
      discountUseIds: [11],
      discountUsed: true,
      percentAmount: 2.5,
      percent: 10,
      label: 'SUMMER10 (10%), GIFT-1',
    });

    await mollie.getPaymentUri(makeParams(), IP);

    const data = prismaMock.payment.create.mock.calls[0][0].data;
    // €25 incl. 21% minus €10 discount: VAT is collected on the €15 actually
    // charged (15 × 21/121 = 2.60), the ex-VAT total is 15 − 2.60 = 12.40,
    // and profit drops by the discount's ex-VAT share (10 / 1.21 = 8.26).
    expect(data).toMatchObject({
      totalPrice: 15,
      totalPriceWithoutTax: 12.4,
      productPriceWithoutTax: 20.66,
      productVATPrice: 2.6,
      totalVATPrice: 2.6,
      profit: 12.4,
      discount: 10,
      pricingVersion: 2,
      discountPercent: 10,
      discountPercentAmount: 2.5,
      discountCodes: 'SUMMER10 (10%), GIFT-1',
      discountWithoutTax: 8.26,
      discountVAT: 1.74,
      discountShipping: 0,
      volumeDiscount: 0,
      shipping: 0,
    });
    // The customer email travels along for once-per-customer codes.
    expect(discountMock.calculateDiscounts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ price: '20.66', taxRate: 21 }),
      'buyer@example.com'
    );
    expect(discountMock.attachPaymentToDiscountUses).toHaveBeenCalledWith(
      [11],
      555
    );
  });

  it('refuses to create the payment when a cart code cannot be applied', async () => {
    const { DiscountApplyError } = await import('../../../src/discount');
    discountMock.calculateDiscounts.mockRejectedValue(
      new DiscountApplyError('SUMMER10', 'discountCodeExhausted')
    );

    const result = await mollie.getPaymentUri(
      makeParams({ cart: { items: [makeItem()], discounts: [{ code: 'SUMMER10' }] } }),
      IP
    );

    expect(result).toEqual({
      success: false,
      error: 'discount_failed',
      discount: { code: 'SUMMER10', message: 'discountCodeExhausted' },
    });
    expect(mollieApi.liveClient.payments.create).not.toHaveBeenCalled();
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
  });

  it('supersedes the customer\'s earlier open payment holding the same code and swallows cancel failures', async () => {
    discountMock.supersedeOpenReservations.mockResolvedValue({
      paymentIds: ['tr_old1', 'tr_old2'],
    });
    mollieApi.liveClient.payments.cancel
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('not cancelable'));

    const result = await mollie.getPaymentUri(
      makeParams({
        cart: { items: [makeItem()], discounts: [{ code: ' gift-1 ' }] },
      }),
      IP
    );

    expect(result.success).toBe(true);
    expect(discountMock.supersedeOpenReservations).toHaveBeenCalledWith(
      'buyer@example.com',
      ['GIFT-1']
    );
    expect(mollieApi.liveClient.payments.cancel).toHaveBeenCalledTimes(2);
  });

  it('ignores server-owned fields echoed back in extraOrderData', async () => {
    const params = makeParams();
    params.extraOrderData.discount = 999;
    params.extraOrderData.status = 'paid';
    params.extraOrderData.test = true;
    params.extraOrderData.profit = 12345;
    params.extraOrderData.boxFee = 50;
    params.extraOrderData.totalPrice = 1;

    await mollie.getPaymentUri(params, IP);

    const data = prismaMock.payment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      discount: 0,
      status: 'open',
      test: false,
      profit: 20.66,
      boxFee: 0,
      totalPrice: 25,
      email: 'buyer@example.com',
      fullname: 'Buyer One',
    });
  });

  it('writes shipping and the volume discount server-side', async () => {
    orderMock.calculateOrder.mockResolvedValue({
      success: true,
      data: {
        total: 27.99,
        price: '20.66',
        payment: '2.99',
        shipping: 2.99,
        taxRate: 21,
        taxRateShipping: 21,
        boxFee: 0,
        volumeDiscount: 0,
        reverseCharge: false,
        vatIdChecked: null,
      },
    });
    const params = makeParams({
      orderType: 'physical',
      cart: { items: [makeItem({ type: 'physical' })] },
    });

    await mollie.getPaymentUri(params, IP);

    const data = prismaMock.payment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      shipping: 2.99,
      volumeDiscount: 0,
      shippingPriceWithoutTax: 2.47,
      shippingVATPrice: 0.52,
      productVATPrice: 4.34,
      totalVATPrice: 4.86,
      totalPriceWithoutTax: 23.13,
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

    const payload = mollieApi.liveClient.payments.create.mock.calls[0][0].paymentRequest;
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
      mollieApi.liveClient.payments.create.mock.calls[0][0].paymentRequest.description
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
      mollieApi.liveClient.payments.create.mock.calls[1][0].paymentRequest.description
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
      mollieApi.liveClient.payments.create.mock.calls[0][0].paymentRequest.method[0]
    ).toBe('paypal');
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

  // Regression: the refresh used to call getTracks() without the opt-out, so a
  // playlist the customer chose to keep duplicates on was re-deduped here. That
  // undercharged the order (the count below feeds getOrderType) AND truncated
  // the PDF later, because pdf.ts paginates on the stored numberOfTracks.
  it('forwards allowDuplicates to Spotify when refreshing the count', async () => {
    providerMock.getTracks.mockResolvedValue({
      success: true,
      data: { total: 3 },
    });
    orderMock.getOrderType.mockResolvedValue({ id: 9, amount: 30 });

    await mollie.getPaymentUri(
      makeParams({
        cart: {
          items: [
            makeItem({
              serviceType: 'spotify',
              allowDuplicates: true,
              numberOfTracks: 2, // stale deduped count from the browser cart
            }),
          ],
        },
      }),
      IP
    );

    expect(providerMock.getTracks).toHaveBeenCalledWith('sp1', {
      allowDuplicates: true,
    });
    // Priced and stored on the with-duplicates count, not the stale 2.
    expect(orderMock.getOrderType).toHaveBeenCalledWith(
      3,
      true,
      'cards',
      'sp1',
      'none'
    );
    const row =
      prismaMock.payment.create.mock.calls[0][0].data.PaymentHasPlaylist
        .create[0];
    expect(row).toMatchObject({ numberOfTracks: 3, allowDuplicates: true });
  });

  // The duplicate filter is not Spotify-specific any more — every provider
  // applies it (see providers/trackDedupe.ts), so every provider must also be
  // told when the customer opted out.
  it('forwards allowDuplicates for non-Spotify providers too', async () => {
    providerMock.getTracks.mockResolvedValue({
      success: true,
      data: { total: 40 },
    });
    orderMock.getOrderType.mockResolvedValue({ id: 9, amount: 30 });

    await mollie.getPaymentUri(
      makeParams({
        cart: {
          items: [makeItem({ serviceType: 'tidal', allowDuplicates: true })],
        },
      }),
      IP
    );

    expect(providerMock.getTracks).toHaveBeenCalledWith('sp1', {
      allowDuplicates: true,
    });
  });

  it('defaults allowDuplicates to false when the cart item omits it', async () => {
    providerMock.getTracks.mockResolvedValue({
      success: true,
      data: { total: 40 },
    });
    orderMock.getOrderType.mockResolvedValue({ id: 9, amount: 30 });

    await mollie.getPaymentUri(makeParams(), IP);

    expect(providerMock.getTracks).toHaveBeenCalledWith('sp1', {
      allowDuplicates: false,
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
      })
    );
    seedSettlement('tr_x', '25.00');
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
    expect(discountMock.releaseDiscountUsesByPaymentId).toHaveBeenCalledWith(10);
    expect(generatorMock.queueGenerate).not.toHaveBeenCalled();
  });

  it('replayed failure webhook (no status flip) still releases the discount uses', async () => {
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({ id: 'tr_x', status: 'expired', method: 'ideal' })
    );
    prismaMock.payment.findUnique.mockResolvedValue({
      id: 10,
      paymentId: 'tr_x',
      status: 'expired',
      user: { hash: 'uhash' },
    });
    prismaMock.payment.updateMany.mockResolvedValue({ count: 0 });

    await mollie.processWebhook({ id: 'tr_x' });

    expect(discountMock.releaseDiscountUsesByPaymentId).toHaveBeenCalledWith(10);
  });

  it('paid webhook settles the reservations even on a replay', async () => {
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
    discountMock.confirmDiscountUsesByPaymentId.mockResolvedValue({
      count: 1,
      shortfalls: [{ code: 'GIFT-1', over: 5 }],
    });

    await mollie.processWebhook({ id: 'tr_x' });

    expect(discountMock.confirmDiscountUsesByPaymentId).toHaveBeenCalledWith(10);
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

    expect(mollieApi.testClient.payments.get).toHaveBeenCalledWith({
      paymentId: 'tr_t',
    });
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

  it('bingo_upgrade issues a QRGames invoice from the purchase row, linked to no order', async () => {
    bingoMock.processBingoUpgradePayment.mockResolvedValueOnce({ success: true });
    prismaMock.gamesPurchase.findFirst.mockResolvedValueOnce({
      id: 3,
      userId: 5,
      totalPrice: 9,
      playlistCount: 2,
      pricePerPlaylist: 4.5,
      taxRate: 21,
      countrycode: 'NL',
    });
    prismaMock.paymentHasPlaylist.findUnique.mockResolvedValueOnce({
      payment: {
        id: 400,
        email: 'gamer@example.com',
        locale: 'fr',
        fullname: 'Claire',
        countrycode: 'FR',
      },
    });
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_bingo',
        status: 'paid',
        metadata: {
          type: 'bingo_upgrade',
          paymentHasPlaylistIds: '12,13',
          userId: '5',
          pricePerPlaylist: '4.5',
        },
      })
    );

    const result = await mollie.processWebhook({ id: 'tr_bingo' });

    expect(result).toEqual({ success: true });
    expect(prismaMock.gamesPurchase.findFirst).toHaveBeenCalledWith({
      where: { molliePaymentId: 'tr_bingo', type: 'upgrade' },
    });
    expect(prismaMock.paymentHasPlaylist.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 12 } })
    );
    expect(upgradeInvoicesMock.issue.mock.calls[0][0]).toMatchObject({
      type: 'games',
      userId: 5,
      paymentId: null,
      email: 'gamer@example.com',
      locale: 'fr',
      taxRate: 21,
      items: [{ description: 'invoice.qrGames', quantity: 2, totalIncl: 9 }],
    });
  });

  it('bingo_upgrade without a purchase row issues no invoice', async () => {
    bingoMock.processBingoUpgradePayment.mockResolvedValueOnce({ success: true });
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_bingo',
        status: 'paid',
        metadata: { type: 'bingo_upgrade', paymentHasPlaylistIds: '12', userId: '5' },
      })
    );

    const result = await mollie.processWebhook({ id: 'tr_bingo' });

    expect(result).toEqual({ success: true });
    expect(upgradeInvoicesMock.issue).not.toHaveBeenCalled();
  });

  it('app_design_upgrade: records the purchase with what Mollie charged and mails the receipt', async () => {
    appDesignMock.processUpgradePayment.mockResolvedValueOnce({
      success: true,
      created: true,
      purchaseId: 11,
    });
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_appdesign',
        status: 'paid',
        amount: { value: '105.00', currency: 'SEK' },
        metadata: {
          type: 'app_design_upgrade',
          userId: '5',
          price: '9',
          taxRate: '25',
          countrycode: 'SE',
        },
      })
    );

    const result = await mollie.processWebhook({ id: 'tr_appdesign' });

    expect(appDesignMock.processUpgradePayment).toHaveBeenCalledWith({
      userId: 5,
      molliePaymentId: 'tr_appdesign',
      price: 9,
      taxRate: 25,
      countrycode: 'SE',
      currency: 'SEK',
      amountCharged: 105,
    });
    const mails = outbound.calls('Mail', 'sendAppDesignEnabledEmail');
    expect(mails[mails.length - 1]?.args).toEqual([11]);
    expect(result).toEqual({ success: true });
    // An account purchase never touches an order.
    expect(prismaMock.payment.update).not.toHaveBeenCalled();
  });

  it('app_design_upgrade replays do not mail twice', async () => {
    appDesignMock.processUpgradePayment.mockResolvedValueOnce({
      success: true,
      created: false,
      purchaseId: 11,
    });
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_appdesign',
        status: 'paid',
        amount: { value: '9.00', currency: 'EUR' },
        metadata: { type: 'app_design_upgrade', userId: '5', price: '9', taxRate: '21', countrycode: 'NL' },
      })
    );
    const before = outbound.calls('Mail', 'sendAppDesignEnabledEmail').length;

    const result = await mollie.processWebhook({ id: 'tr_appdesign' });

    expect(result).toEqual({ success: true });
    expect(outbound.calls('Mail', 'sendAppDesignEnabledEmail').length).toBe(before);
  });

  it('app_design_upgrade replays offer the invoice again (issue is idempotent)', async () => {
    appDesignMock.processUpgradePayment.mockResolvedValueOnce({
      success: true,
      created: false,
      purchaseId: 11,
    });
    prismaMock.appDesignPurchase.findUnique.mockResolvedValueOnce({
      id: 11,
      userId: 5,
      totalPrice: 9,
      taxRate: 21,
      countrycode: 'NL',
      user: { id: 5, email: 'account@example.com', locale: 'nl' },
    });
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_appdesign',
        status: 'paid',
        amount: { value: '9.00', currency: 'EUR' },
        metadata: { type: 'app_design_upgrade', userId: '5', price: '9', taxRate: '21', countrycode: 'NL' },
      })
    );

    await mollie.processWebhook({ id: 'tr_appdesign' });

    // No paid order found: the account's own address and language are used.
    expect(upgradeInvoicesMock.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'app_design',
        email: 'account@example.com',
        locale: 'nl',
        customer: expect.objectContaining({ countrycode: 'NL' }),
      })
    );
  });

  it('app_design_upgrade issues an invoice billed to the latest paid card order', async () => {
    appDesignMock.processUpgradePayment.mockResolvedValueOnce({
      success: true,
      created: true,
      purchaseId: 11,
    });
    prismaMock.appDesignPurchase.findUnique.mockResolvedValueOnce({
      id: 11,
      userId: 5,
      totalPrice: 9,
      taxRate: 25,
      countrycode: 'SE',
      user: { id: 5, email: 'account@example.com', locale: 'en' },
    });
    prismaMock.payment.findFirst.mockResolvedValueOnce({
      id: 900,
      email: 'order@example.com',
      locale: 'sv',
      fullname: 'Anna Svensson',
      address: 'Gatan',
      housenumber: '3',
      zipcode: '111 22',
      city: 'Stockholm',
      countrycode: 'SE',
      invoiceAddress: null,
    });
    const molliePayment = fakeMolliePayment({
      id: 'tr_appdesign_inv',
      status: 'paid',
      method: 'klarna',
      amount: { value: '105.00', currency: 'SEK' },
      metadata: {
        type: 'app_design_upgrade',
        userId: '5',
        price: '9',
        taxRate: '25',
        countrycode: 'SE',
        locale: 'sv',
      },
    });
    mollieApi.liveClient.payments.get.mockResolvedValue(molliePayment);

    const result = await mollie.processWebhook({ id: 'tr_appdesign_inv' });

    expect(result).toEqual({ success: true });
    expect(prismaMock.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 5, status: 'paid' }),
        orderBy: { createdAt: 'desc' },
      })
    );
    expect(upgradeInvoicesMock.issue).toHaveBeenCalledTimes(1);
    const params = upgradeInvoicesMock.issue.mock.calls[0][0];
    expect(params).toMatchObject({
      type: 'app_design',
      userId: 5,
      paymentId: null,
      email: 'order@example.com',
      locale: 'sv',
      taxRate: 25,
      items: [{ description: 'invoice.appDesigner', quantity: 1, totalIncl: 9 }],
    });
    expect(params.molliePayment.id).toBe('tr_appdesign_inv');
    expect(params.customer).toMatchObject({
      fullname: 'Anna Svensson',
      address: 'Gatan',
      city: 'Stockholm',
      countrycode: 'SE',
    });
  });

  it('app_design_upgrade still succeeds when the invoice lookups fail', async () => {
    appDesignMock.processUpgradePayment.mockResolvedValueOnce({
      success: true,
      created: false,
      purchaseId: 11,
    });
    prismaMock.appDesignPurchase.findUnique.mockRejectedValueOnce(new Error('db hiccup'));
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_appdesign_inv_fail',
        status: 'paid',
        amount: { value: '9.00', currency: 'EUR' },
        metadata: { type: 'app_design_upgrade', userId: '5', price: '9', taxRate: '21', countrycode: 'NL' },
      })
    );

    const result = await mollie.processWebhook({ id: 'tr_appdesign_inv_fail' });

    expect(result).toEqual({ success: true });
    expect(upgradeInvoicesMock.issue).not.toHaveBeenCalled();
  });

  it('app_design_upgrade reports a failure so Mollie retries', async () => {
    appDesignMock.processUpgradePayment.mockResolvedValueOnce({
      success: false,
      created: false,
      error: 'db down',
    });
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_appdesign_fail',
        status: 'paid',
        amount: { value: '9.00', currency: 'EUR' },
        metadata: { type: 'app_design_upgrade', userId: '5', price: '9', taxRate: '21', countrycode: 'NL' },
      })
    );

    const result = await mollie.processWebhook({ id: 'tr_appdesign_fail' });

    expect(result).toEqual({ success: false, error: 'db down' });
  });

  it('box_upgrade: enables the box, books what was charged, invoices it and orders printing', async () => {
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
        payment: { sentToPrinter: true, taxRate: 19, countrycode: 'DE' },
      }) // idempotency check
      .mockResolvedValueOnce({ payment: { user: { hash: 'h2' } } }); // cache clear
    prismaMock.payment.findUnique.mockResolvedValueOnce({
      id: 321,
      paymentId: 'tr_orig',
      email: 'buyer@example.com',
      locale: 'de',
      fullname: 'Max Muster',
      countrycode: 'DE',
    });
    dataMock.getTaxRate.mockResolvedValueOnce(19);

    const result = await mollie.processWebhook({ id: 'tr_box' });

    expect(result).toEqual({ success: true });
    expect(prismaMock.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 77 },
      data: { boxEnabled: true, boxPrice: 13.98 }, // 6.99 * 2
    });
    // The box price is VAT-inclusive: 13.98 + shipping 3.50, no VAT on top.
    // Booked with the order's 19% split, the two boxes' wholesale cost
    // (2 x 0.75) off the profit.
    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'tr_orig' },
      data: {
        totalPrice: { increment: 17.48 },
        totalPriceWithoutTax: { increment: 14.69 },
        productVATPrice: { increment: 2.79 },
        profit: { increment: 13.19 },
      },
    });
    expect(dataMock.getTaxRate).toHaveBeenCalledWith('DE');
    expect(upgradeInvoicesMock.issue).toHaveBeenCalledTimes(1);
    expect(upgradeInvoicesMock.issue.mock.calls[0][0]).toMatchObject({
      type: 'box',
      userId: 5,
      paymentId: 321,
      email: 'buyer@example.com',
      locale: 'de',
      taxRate: 19,
      items: [
        { description: 'invoice.giftBox', quantity: 2, totalIncl: 13.98 },
        { description: 'invoice.shippingAndHandling', quantity: 1, totalIncl: 3.5 },
      ],
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
    prismaMock.payment.findUnique.mockResolvedValueOnce({
      id: 321,
      paymentId: 'tr_orig',
      email: 'buyer@example.com',
      locale: 'nl',
      countrycode: 'NL',
    });

    const result = await mollie.processWebhook({ id: 'tr_box' });

    expect(result).toEqual({ success: true });
    expect(prismaMock.paymentHasPlaylist.update).not.toHaveBeenCalled();
    expect(prismaMock.payment.update).not.toHaveBeenCalled();
    expect(outbound.calls('PrintEnBind', 'createBoxUpgradeOrder')).toEqual([]);
    // The invoice is offered again (issue is idempotent), with the same
    // lines: boxPrice falls back to BOX_PRICE, no shipping.
    expect(upgradeInvoicesMock.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'box',
        paymentId: 321,
        items: [
          { description: 'invoice.giftBox', quantity: 1, totalIncl: BOX_PRICE },
          { description: 'invoice.shippingAndHandling', quantity: 1, totalIncl: 0 },
        ],
      })
    );
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
      .mockResolvedValueOnce(null);

    const result = await mollie.processWebhook({ id: 'tr_box' });

    expect(result).toEqual({ success: true });
    // boxPrice falls back to BOX_PRICE when metadata carries none.
    expect(prismaMock.paymentHasPlaylist.update).toHaveBeenCalledWith({
      where: { id: 77 },
      data: { boxEnabled: true, boxPrice: 6.99 },
    });
    expect(outbound.calls('PrintEnBind', 'createBoxUpgradeOrder')).toEqual([]);
    // No order found for the invoice: nothing is issued, the upgrade stands.
    expect(upgradeInvoicesMock.issue).not.toHaveBeenCalled();
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
    // No rate in the metadata and none on the order: the country's 21%.
    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'tr_orig' },
      data: {
        totalPrice: { increment: 10 },
        totalPriceWithoutTax: { increment: 8.26 },
        productVATPrice: { increment: 1.74 },
        profit: { increment: 8.26 },
      },
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

  const ORIGINAL_ORDER = {
    id: 321,
    paymentId: 'tr_orig',
    email: 'buyer@example.com',
    locale: 'nl',
    fullname: 'Jan Jansen',
    address: 'Straat',
    housenumber: '1',
    zipcode: '1000 AA',
    city: 'Amsterdam',
    countrycode: 'NL',
    invoiceAddress: 'Factuurlaan',
    invoiceHousenumber: '9',
    invoiceZipcode: '2000 BB',
    invoiceCity: 'Haarlem',
    invoiceCountrycode: 'NL',
  };

  it('tracks_upgrade invoices cards, handling and boxes, adding up to what was charged', async () => {
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_tracks_inv',
        status: 'paid',
        method: 'ideal',
        amount: { currency: 'EUR', value: '31.08' },
        metadata: {
          type: 'tracks_upgrade',
          paymentHasPlaylistId: '88',
          userId: '5',
          originalPaymentId: 'tr_orig',
          extraTracks: '50',
          previousNumberOfTracks: '100',
          extraBoxes: '1',
          newBoxQuantity: '2',
          boxUnitPriceEur: '9.95',
          extraTracksCostEur: '15',
          handlingFeeEur: '2.5',
          boxesCostEur: '9.95',
          totalEur: '31.08',
          taxRate: '21',
        },
      })
    );
    prismaMock.paymentHasPlaylist.findUnique
      .mockResolvedValueOnce({ id: 88, numberOfTracks: 100 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ playlist: { name: 'Top 2000' } });
    prismaMock.payment.findUnique.mockResolvedValueOnce(ORIGINAL_ORDER);

    const result = await mollie.processWebhook({ id: 'tr_tracks_inv' });

    expect(result).toEqual({ success: true });
    expect(upgradeInvoicesMock.issue).toHaveBeenCalledTimes(1);
    const params = upgradeInvoicesMock.issue.mock.calls[0][0];
    expect(params).toMatchObject({
      type: 'extra_tracks',
      userId: 5,
      paymentId: 321,
      email: 'buyer@example.com',
      locale: 'nl',
      taxRate: 21,
    });
    // handling 2.50 ex → 3.03 incl; cards take the rest: 31.08 - 9.95 - 3.03
    expect(params.items).toEqual([
      { description: 'invoice.extraCards {"playlist":"Top 2000"}', quantity: 50, totalIncl: 18.1 },
      { description: 'invoice.handlingFee', quantity: 1, totalIncl: 3.03 },
      { description: 'invoice.giftBox', quantity: 1, totalIncl: 9.95 },
    ]);
    const sum = params.items.reduce((s: number, i: any) => s + i.totalIncl, 0);
    expect(Math.round(sum * 100) / 100).toBe(31.08);
    // The invoice address wins over the delivery address.
    expect(params.customer).toMatchObject({
      address: 'Factuurlaan',
      housenumber: '9',
      zipcode: '2000 BB',
      city: 'Haarlem',
    });
  });

  it('tracks_upgrade in another currency books the EUR price, the same total as its invoice', async () => {
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_tracks_sek',
        status: 'paid',
        amount: { currency: 'SEK', value: '365.00' },
        metadata: {
          type: 'tracks_upgrade',
          paymentHasPlaylistId: '88',
          userId: '5',
          originalPaymentId: 'tr_orig',
          extraTracks: '50',
          extraTracksCostEur: '22',
          handlingFeeEur: '2.5',
          boxesCostEur: '0',
          totalEur: '30.63',
          taxRate: '25',
        },
      })
    );
    seedSettlement('tr_tracks_sek', '29.10');
    prismaMock.paymentHasPlaylist.findUnique.mockResolvedValueOnce({ id: 88, numberOfTracks: 100 });

    await mollie.processWebhook({ id: 'tr_tracks_sek' });

    // Split at the 25% the upgrade was sold at, like its invoice.
    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'tr_orig' },
      data: {
        totalPrice: { increment: 30.63 },
        totalPriceWithoutTax: { increment: 24.5 },
        productVATPrice: { increment: 6.13 },
        profit: { increment: 24.5 },
      },
    });
  });

  it('tracks_upgrade from before the breakdown was stored invoices one line of the EUR charge', async () => {
    mollieApi.liveClient.payments.get.mockResolvedValue(
      fakeMolliePayment({
        id: 'tr_tracks_old',
        status: 'paid',
        amount: { currency: 'EUR', value: '10.00' },
        metadata: {
          type: 'tracks_upgrade',
          paymentHasPlaylistId: '88',
          userId: '5',
          originalPaymentId: 'tr_orig',
          extraTracks: '50',
        },
      })
    );
    prismaMock.paymentHasPlaylist.findUnique
      .mockResolvedValueOnce({ id: 88, numberOfTracks: 100 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ playlist: { name: 'Top 2000' } });
    prismaMock.payment.findUnique.mockResolvedValueOnce(ORIGINAL_ORDER);
    dataMock.getTaxRate.mockResolvedValueOnce(21);

    await mollie.processWebhook({ id: 'tr_tracks_old' });

    expect(dataMock.getTaxRate).toHaveBeenCalledWith('NL');
    expect(upgradeInvoicesMock.issue.mock.calls[0][0].items).toEqual([
      { description: 'invoice.extraCards {"playlist":"Top 2000"}', quantity: 50, totalIncl: 10 },
    ]);
  });

  it('tracks_upgrade replays offer the invoice again without re-applying the upgrade', async () => {
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
          totalEur: '10',
          handlingFeeEur: '0',
          boxesCostEur: '0',
          taxRate: '21',
        },
      })
    );
    cacheMock.get.mockResolvedValue('1');
    prismaMock.payment.findUnique.mockResolvedValueOnce(ORIGINAL_ORDER);

    const result = await mollie.processWebhook({ id: 'tr_tracks' });

    expect(result).toEqual({ success: true });
    expect(dataMock.updatePlaylistDetails).not.toHaveBeenCalled();
    expect(upgradeInvoicesMock.issue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'extra_tracks', paymentId: 321 })
    );
  });

  it('tracks_upgrade without an order email skips the invoice', async () => {
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
        },
      })
    );
    prismaMock.paymentHasPlaylist.findUnique.mockResolvedValueOnce({ id: 88, numberOfTracks: 100 });

    const result = await mollie.processWebhook({ id: 'tr_tracks' });

    expect(result).toEqual({ success: true });
    expect(upgradeInvoicesMock.issue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// settlementAmount capture (HTTPClient response hook)
// ---------------------------------------------------------------------------

describe('settlementAmount capture', () => {
  /**
   * The Client is mocked, but the HTTPClient carrying the hook is real, so the
   * hook is driven here by stubbing the fetch it wraps.
   */
  async function respondWith(url: string, body: any, status = 200) {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    );
    try {
      return await (mollie as any).settlementCapture.request(new Request(url));
    } finally {
      fetchSpy.mockRestore();
    }
  }

  const take = (id: string) => (mollie as any).takeSettlementAmountEur(id);

  it('lifts settlementAmount off the raw payment response', async () => {
    const res = await respondWith(
      'https://api.mollie.com/v2/payments/tr_hook',
      { id: 'tr_hook', settlementAmount: { currency: 'EUR', value: '12.50' } }
    );

    // The hook must clone: the SDK still has to be able to read the body.
    expect(await res.json()).toMatchObject({ id: 'tr_hook' });
    expect(take('tr_hook')).toBe(12.5);
  });

  it('consumes the value, so a replayed webhook does not book it twice', async () => {
    await respondWith('https://api.mollie.com/v2/payments/tr_once', {
      settlementAmount: { currency: 'EUR', value: '9.00' },
    });

    expect(take('tr_once')).toBe(9);
    expect(take('tr_once')).toBeNull();
  });

  it('ignores non-EUR settlements and payments it never saw', async () => {
    await respondWith('https://api.mollie.com/v2/payments/tr_sek', {
      settlementAmount: { currency: 'SEK', value: '120.00' },
    });

    expect(take('tr_sek')).toBeNull();
    expect(take('tr_never')).toBeNull();
  });

  it('ignores responses without a payment id in the path and error responses', async () => {
    await respondWith('https://api.mollie.com/v2/payments', {
      count: 0,
      settlementAmount: { currency: 'EUR', value: '1.00' },
    });
    await respondWith(
      'https://api.mollie.com/v2/payments/tr_bad',
      { settlementAmount: { currency: 'EUR', value: '1.00' } },
      422
    );

    expect((mollie as any).settlementAmounts.size).toBe(0);
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

  it('returns an explicit unknown status for unknown payments', async () => {
    // A status-less response made the frontend swallow every poll
    // (`if (!status) return`) and eventually claim the payment had failed.
    prismaMock.payment.findUnique.mockResolvedValue(null);
    expect(await mollie.checkPaymentStatus('tr_nope')).toEqual({
      success: false,
      data: { status: 'unknown' },
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

    expect(mollieApi.liveClient.refunds.create).toHaveBeenCalledWith({
      paymentId: 'tr_1',
      refundRequest: {
        amount: { currency: 'EUR', value: '10.00' },
        description: 'QRSong! refund tr_1',
        metadata: null,
      },
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

    expect(mollieApi.liveClient.refunds.create).toHaveBeenCalledWith({
      paymentId: 'tr_1',
      refundRequest: {
        amount: { currency: 'SEK', value: '115.00' }, // 10/40 * 460
        description: 'QRSong! refund tr_1',
        metadata: null,
      },
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

    expect(mollieApi.liveClient.refunds.create).toHaveBeenCalledWith({
      paymentId: 'tr_1',
      refundRequest: {
        amount: { currency: 'SEK', value: '115.00' }, // 10 * 11.5
        description: 'QRSong! refund tr_1',
        metadata: null,
      },
    });
  });

  it('surfaces Mollie errors as a failed ApiResult', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(null); // unknown → EUR
    mollieApi.liveClient.refunds.create.mockRejectedValue(
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
      requestBody: {
        amount: { currency: 'EUR', value: '12.35' }, // toFixed(2) rounds
        description: 'QRSong! Custom Payment - EUR 12.35',
      },
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
      paymentRequest: {
        amount: { currency: 'USD', value: '6.00' }, // 5 EUR × 1.2
        // DE list filtered to USD-capable methods
        method: ['paypal', 'creditcard', 'applepay'],
        metadata: { type: 'bingo_upgrade', userId: '5' },
        description: 'QRGames upgrade',
        redirectUrl: 'https://example.com/back',
        webhookUrl: 'http://localhost:3004/mollie/webhook',
        locale: 'de_DE',
      },
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
      mollieApi.liveClient.payments.create.mock.calls[0][0].paymentRequest.amount
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

// ---------------------------------------------------------------------------
// App Designer in the financial reports. It is an account upgrade with its
// own Mollie payment and no Payment row, so every report reads its ledger
// (app_design_purchases) next to the payments.
// ---------------------------------------------------------------------------

/** Route the raw sales-report queries by the table they read. */
function mockSalesReportQueries(tables: {
  payments?: any[];
  games?: any[];
  boxes?: any[];
  appDesign?: any[];
}): void {
  prismaMock.$queryRawUnsafe.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM app_design_purchases')) return tables.appDesign || [];
    if (sql.includes('FROM games_purchases')) return tables.games || [];
    if (sql.includes('boxAmount')) return tables.boxes || [];
    return tables.payments || [];
  });
}

describe('getSalesReport: App Designer', () => {
  it('adds count, gross and ex-VAT per period, including periods with only App Designer', async () => {
    mockSalesReportQueries({
      payments: [
        {
          period: '2026-09',
          numberOfSales: 10n,
          totalPrice: '250',
          totalPriceWithoutTax: '206.61',
          totalRefunded: '0',
          totalProfit: '80',
          profitAssignedCount: 10n,
        },
        {
          period: '2026-08',
          numberOfSales: 4n,
          totalPrice: '100',
          totalPriceWithoutTax: '82.64',
          totalRefunded: '0',
          totalProfit: '30',
          profitAssignedCount: 4n,
        },
      ],
      games: [{ period: '2026-09', gamesAmount: 3n, gamesTotal: '5' }],
      appDesign: [
        { period: '2026-09', appDesignAmount: 2n, appDesignTotal: '18', appDesignExVat: '14.88' },
        { period: '2026-07', appDesignAmount: 1n, appDesignTotal: '9', appDesignExVat: '7.44' },
      ],
    });

    const report = await mollie.getSalesReport('month');

    expect(report.map((r: any) => r.period)).toEqual(['2026-09', '2026-08', '2026-07']);
    expect(report[0]).toMatchObject({
      numberOfSales: 10,
      totalPrice: 250,
      gamesAmount: 3,
      gamesTotal: 5,
      appDesignAmount: 2,
      appDesignTotal: 18,
      appDesignExVat: 14.88,
      totalProfit: 80,
    });
    expect(report[1]).toMatchObject({
      appDesignAmount: 0,
      appDesignTotal: 0,
      appDesignExVat: 0,
    });
    // July: App Designer was the only sale, so there is no payments row.
    expect(report[2]).toEqual({
      period: '2026-07',
      numberOfSales: 0,
      totalPrice: 0,
      totalPriceWithoutTax: 0,
      boxAmount: 0,
      totalRefunded: 0,
      gamesAmount: 0,
      gamesTotal: 0,
      gamesExVat: 0,
      appDesignAmount: 1,
      appDesignTotal: 9,
      appDesignExVat: 7.44,
      totalProfit: 0,
      profitAssignedCount: 0,
    });

    const appDesignSql = prismaMock.$queryRawUnsafe.mock.calls
      .map((c: any[]) => c[0] as string)
      .find((sql: string) => sql.includes('FROM app_design_purchases'));
    expect(appDesignSql).toContain("DATE_FORMAT(adp.createdAt, '%Y-%m')");
  });

  it('dates the day report by the purchase day', async () => {
    mockSalesReportQueries({
      appDesign: [
        { period: '2026-09-14', appDesignAmount: 1n, appDesignTotal: '9', appDesignExVat: '7.44' },
      ],
    });

    const report = await mollie.getSalesReport('day');

    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ period: '2026-09-14', appDesignAmount: 1 });
    const appDesignSql = prismaMock.$queryRawUnsafe.mock.calls
      .map((c: any[]) => c[0] as string)
      .find((sql: string) => sql.includes('FROM app_design_purchases'));
    expect(appDesignSql).toContain("DATE_FORMAT(adp.createdAt, '%Y-%m-%d')");
  });

  it('zeroes App Designer in the filtered (per product type) views', async () => {
    mockSalesReportQueries({
      payments: [
        {
          period: '2026-09',
          numberOfSales: 2n,
          totalPrice: '50',
          totalPriceWithoutTax: '41.32',
          totalRefunded: '0',
        },
      ],
      appDesign: [
        { period: '2026-09', appDesignAmount: 2n, appDesignTotal: '18', appDesignExVat: '14.88' },
      ],
    });

    const report = await mollie.getSalesReport('month', 'digital');

    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({
      appDesignAmount: 0,
      appDesignTotal: 0,
      appDesignExVat: 0,
    });
    const sqls = prismaMock.$queryRawUnsafe.mock.calls.map((c: any[]) => c[0] as string);
    expect(sqls.some((sql: string) => sql.includes('app_design_purchases'))).toBe(false);
  });
});

describe('getPaymentsByMonth: App Designer', () => {
  it('adds App Designer per country and a row for a country with only App Designer', async () => {
    prismaMock.payment.groupBy.mockResolvedValue([
      {
        countrycode: 'NL',
        _count: { _all: 2 },
        _sum: { totalPrice: 50, totalPriceWithoutTax: 41.32 },
        _max: { taxRate: 21 },
      },
    ]);
    prismaMock.appDesignPurchase.findMany.mockResolvedValue([
      { countrycode: 'NL', paymentId: null, totalPrice: 9, totalPriceWithoutTax: 7.44, taxRate: 21 },
      // Bought at checkout: already inside the NL order totals above.
      { countrycode: 'NL', paymentId: 40, totalPrice: 9, totalPriceWithoutTax: 7.44, taxRate: 21 },
      { countrycode: 'DE', paymentId: null, totalPrice: 9, totalPriceWithoutTax: 7.56, taxRate: 19 },
      { countrycode: 'DE', paymentId: null, totalPrice: 9, totalPriceWithoutTax: 7.57, taxRate: 19 },
    ]);
    const start = new Date(2026, 8, 1);
    const end = new Date(2026, 9, 0, 23, 59, 59);

    const report = await mollie.getPaymentsByMonth(start, end);

    expect(prismaMock.appDesignPurchase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { createdAt: { gte: start, lte: end } },
      })
    );
    expect(report).toHaveLength(2);
    expect(report[0]).toMatchObject({
      country: 'NL',
      numberOfSales: 2,
      totalPrice: 50,
      appDesignAmount: 2,
      appDesignTotal: 9,
      appDesignExVat: 7.44,
    });
    expect(report[1]).toMatchObject({
      country: 'DE',
      numberOfSales: 0,
      totalPrice: 0,
      totalPriceWithoutTax: 0,
      taxRate: 19,
      totalPlaylists: 0,
      appDesignAmount: 2,
      appDesignTotal: 18,
      appDesignExVat: 15.13,
      totalProfit: 0,
    });
  });
});

describe('getPaymentsByTaxRate: App Designer', () => {
  beforeEach(() => {
    prismaMock.payment.findMany.mockImplementation(async (args: any) =>
      // The refund lookup asks for refunded payments only; none here.
      args?.where?.refundAmount
        ? []
        : [
            {
              paymentId: 'tr_nl',
              countrycode: 'NL',
              taxRate: 21,
              totalPrice: 25,
              totalPriceWithoutTax: 20.66,
              productVATPrice: 4.34,
            },
            {
              paymentId: 'tr_de',
              countrycode: 'de',
              taxRate: 19,
              totalPrice: 30,
              totalPriceWithoutTax: 25.21,
              productVATPrice: 4.79,
            },
          ]
    );
    prismaMock.appDesignPurchase.findMany.mockResolvedValue([
      { molliePaymentId: 'tr_a_nl', countrycode: 'NL', taxRate: 21, totalPrice: 9, totalPriceWithoutTax: 7.44, totalVAT: 1.56 },
      // Bought at checkout with tr_nl, so already inside its totals and VAT.
      { molliePaymentId: 'tr_nl', paymentId: 1, countrycode: 'NL', taxRate: 21, totalPrice: 9, totalPriceWithoutTax: 7.44, totalVAT: 1.56 },
      { molliePaymentId: 'tr_a_de', countrycode: 'DE', taxRate: 19, totalPrice: 9, totalPriceWithoutTax: 7.56, totalVAT: 1.44 },
      { molliePaymentId: 'tr_a_fr', countrycode: 'FR', taxRate: 20, totalPrice: 9, totalPriceWithoutTax: 7.5, totalVAT: 1.5 },
      { molliePaymentId: 'tr_a_us', countrycode: 'US', taxRate: 0, totalPrice: 9, totalPriceWithoutTax: 9, totalVAT: 0 },
    ]);
  });

  it('keys App Designer by zone, country and rate and counts it in the taxable totals', async () => {
    const start = new Date(2026, 6, 1);
    const end = new Date(2026, 9, 0, 23, 59, 59);

    const { rows } = await mollie.getPaymentsByTaxRate(start, end);

    expect(prismaMock.appDesignPurchase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { createdAt: { gte: start, lte: end } } })
    );
    expect(rows.map((r: any) => `${r.zone}|${r.countrycode}|${r.taxRate}`)).toEqual([
      'NL|NL|21',
      'EU|DE|19',
      'EU|FR|20',
      'EXPORT|US|0',
    ]);

    const nl = rows[0];
    expect(nl.numberOfSales).toBe(1);
    expect(nl.totalPrice).toBe(25); // playlists' gross; App Designer has its own
    expect(nl.totalPriceWithoutTax).toBeCloseTo(20.66 + 7.44, 2);
    expect(nl.totalVAT).toBeCloseTo(4.34 + 1.56, 2);
    // Both purchases are counted; only the account one adds money, and the
    // checkout one's ex-VAT is carried for the MoneyBird split.
    expect(nl).toMatchObject({
      appDesignAmount: 2,
      appDesignTotal: 9,
      appDesignExVat: 7.44,
      appDesignVAT: 1.56,
      appDesignCheckoutExVat: 7.44,
    });

    // Lower-case payment country and the ledger's upper-case one share a row.
    const de = rows[1];
    expect(de.numberOfSales).toBe(1);
    expect(de.totalPriceWithoutTax).toBeCloseTo(25.21 + 7.56, 2);
    expect(de.totalVAT).toBeCloseTo(4.79 + 1.44, 2);
    expect(de.appDesignAmount).toBe(1);

    // A country whose only sale was App Designer still gets a row.
    expect(rows[2]).toMatchObject({
      zone: 'EU',
      countrycode: 'FR',
      firstPaymentId: 'tr_a_fr',
      numberOfSales: 0,
      totalPrice: 0,
      totalPriceWithoutTax: 7.5,
      totalVAT: 1.5,
      appDesignAmount: 1,
      appDesignTotal: 9,
    });
    expect(rows[3]).toMatchObject({ zone: 'EXPORT', totalVAT: 0, appDesignExVat: 9 });

    // VAT owed is every payment's VAT plus every App Designer VAT, once.
    const vat = rows.reduce((s: number, r: any) => s + r.totalVAT, 0);
    expect(vat).toBeCloseTo(4.34 + 4.79 + 1.56 + 1.44 + 1.5, 2);
  });

  it('adds App Designer to the OSS breakdown for EU countries outside NL only', async () => {
    const { ossBreakdown } = await mollie.getPaymentsByTaxRate(
      new Date(2026, 6, 1),
      new Date(2026, 9, 0, 23, 59, 59)
    );

    expect(ossBreakdown.map((r: any) => `${r.country}|${r.taxRate}`)).toEqual([
      'DE|19',
      'FR|20',
    ]);
    expect(ossBreakdown[0].totalPriceWithoutTax).toBeCloseTo(25.21 + 7.56, 2);
    expect(ossBreakdown[0].totalVAT).toBeCloseTo(4.79 + 1.44, 2);
    expect(ossBreakdown[0]).toMatchObject({
      numberOfSales: 1,
      totalPrice: 30,
      appDesignAmount: 1,
      appDesignExVat: 7.56,
      appDesignVAT: 1.44,
    });
    expect(ossBreakdown[1]).toMatchObject({
      country: 'FR',
      numberOfSales: 0,
      totalPriceWithoutTax: 7.5,
      totalVAT: 1.5,
      appDesignAmount: 1,
      appDesignTotal: 9,
    });
  });

  it('counts a games upgrade, charged VAT-inclusive, in the taxable totals', async () => {
    prismaMock.gamesPurchase.findMany.mockResolvedValue([
      { molliePaymentId: 'tr_g_nl', countrycode: 'NL', taxRate: 21, totalPrice: 5, type: 'upgrade' },
      // The free games that came with an order: counted, no money.
      { molliePaymentId: null, countrycode: 'NL', taxRate: 21, totalPrice: 0, type: 'initial' },
      // A country whose only sale was a games upgrade still gets a row.
      { molliePaymentId: 'tr_g_be', countrycode: 'BE', taxRate: 21, totalPrice: 5, type: 'upgrade' },
    ]);

    const { rows, ossBreakdown } = await mollie.getPaymentsByTaxRate(
      new Date(2026, 6, 1),
      new Date(2026, 9, 0, 23, 59, 59)
    );

    const nl = rows.find((r: any) => r.countrycode === 'NL');
    expect(nl).toMatchObject({ gamesAmount: 2, gamesTotal: 5, gamesExVat: 4.13, gamesVAT: 0.87 });
    expect(nl.totalPriceWithoutTax).toBeCloseTo(20.66 + 7.44 + 4.13, 2);
    expect(nl.totalVAT).toBeCloseTo(4.34 + 1.56 + 0.87, 2);

    const be = rows.find((r: any) => r.countrycode === 'BE');
    expect(be).toMatchObject({
      zone: 'EU',
      firstPaymentId: 'tr_g_be',
      numberOfSales: 0,
      totalPrice: 0,
      totalPriceWithoutTax: 4.13,
      totalVAT: 0.87,
      gamesAmount: 1,
      gamesTotal: 5,
    });
    expect(ossBreakdown.find((r: any) => r.country === 'BE')).toMatchObject({
      totalPriceWithoutTax: 4.13,
      totalVAT: 0.87,
      gamesExVat: 4.13,
    });
  });
});

describe('getSalesTotals', () => {
  it("adds the report's rows up the way the day and month reports do", async () => {
    mockSalesReportQueries({
      payments: [
        {
          period: '2026-09',
          numberOfSales: 10n,
          totalPrice: '250',
          totalPriceWithoutTax: '206.61',
          totalRefunded: '5',
          totalProfit: '80',
          profitAssignedCount: 8n,
        },
        {
          period: '2026-08',
          numberOfSales: 4n,
          totalPrice: '100',
          totalPriceWithoutTax: '82.64',
          totalRefunded: '0',
          totalProfit: '30',
          profitAssignedCount: 4n,
        },
      ],
      games: [{ period: '2026-09', gamesAmount: 3n, gamesTotal: '5', gamesExVat: '4.13' }],
      appDesign: [
        { period: '2026-09', appDesignAmount: 2n, appDesignTotal: '18', appDesignExVat: '14.88' },
        { period: '2026-07', appDesignAmount: 1n, appDesignTotal: '9', appDesignExVat: '7.44' },
      ],
    });

    const totals = await mollie.getSalesTotals();

    // Turnover: the reports' "Combined €" (gross playlists, games upgrades
    // and account App Designer); profit: their "Profit €" (ex-VAT).
    expect(totals).toEqual({
      turnover: 250 + 100 + 5 + 18 + 9,
      profit: 136.45, // 80 + 30 + 4.13 + 14.88 + 7.44
      numberOfSales: 14,
      profitAssignedCount: 12,
    });
  });
});
