/**
 * Unit tests for src/merchantcenter.ts (MerchantCenterService).
 *
 * Everything with I/O is mocked at the module boundary:
 *  - googleapis            → Content API products.* captured (payload assertions)
 *  - cron                  → no-op CronJob class (constructor-scheduled jobs never fire)
 *  - ../../../src/prisma   → in-memory prisma stub (no MariaDB)
 *  - ../../../src/services/fx → deterministic convertAndFormat with fixed rates
 *  - ../../../src/translation / order / shipping / utils / pdf / logger → stubs
 *  - openai / sharp / axios / @hyzyla/pdfium → stubbed (no network, no native deps)
 * src/data/currency-map is the REAL module (pure country→currency logic).
 *
 * ENVIRONMENT=test (not "development"), so upload paths really hit the
 * (mocked) Content API and we can assert the exact request payloads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fsp from 'fs/promises';
import path from 'path';

const h = vi.hoisted(() => {
  // The singleton constructor + initializeAuth read these at import/call time,
  // so they must be finalized before the module under test loads.
  process.env['GOOGLE_SERVICE_ACCOUNT_KEY_FILE'] = '/tmp/fake-google-key.json';
  process.env['GOOGLE_MERCHANT_ID'] = 'merchant-test-1';
  process.env['FRONTEND_URI'] = 'https://www.qrsong.io';
  process.env['API_URI'] = 'https://api.qrsong.io';
  process.env['ENVIRONMENT'] = 'test';
  delete process.env['DEBUG_MERCHANT_CENTER'];
  delete process.env['FORCE_NEW_IMAGES'];

  return {
    // googleapis Content API
    products: {
      get: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    },
    googleAuthCtor: vi.fn(),
    contentCtor: vi.fn(),
    authClient: { fake: 'auth-client' },
    // prisma
    prisma: {
      playlist: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      paymentHasPlaylist: { findFirst: vi.fn() },
    },
    // collaborators
    translationsByPrefix: vi.fn(),
    getOrderType: vi.fn(),
    getShippingInfoByCountry: vi.fn(),
    // Default needed: merchantcenter calls isMainServer().then() at module
    // import, before any test can configure the mock.
    isMainServer: vi.fn(async () => false),
    fxConvertAndFormat: vi.fn(),
    pdfRenderUrlToPdfBuffer: vi.fn(),
    openaiImagesEdit: vi.fn(),
    axiosGet: vi.fn(),
    cronCtor: vi.fn(),
  };
});

vi.mock('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: class {
        constructor(opts: any) {
          h.googleAuthCtor(opts);
        }
        getClient = async () => h.authClient;
      },
    },
    content: (opts: any) => {
      h.contentCtor(opts);
      return { products: h.products };
    },
  },
}));

vi.mock('cron', () => ({
  CronJob: class {
    constructor(...args: any[]) {
      h.cronCtor(...args);
    }
    start() {}
    stop() {}
  },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log(_msg?: any) {}
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prisma },
}));

vi.mock('../../../src/translation', () => ({
  default: class {
    getTranslationsByPrefix = h.translationsByPrefix;
  },
}));

vi.mock('../../../src/order', () => ({
  default: { getInstance: () => ({ getOrderType: h.getOrderType }) },
}));

vi.mock('../../../src/shipping', () => ({
  default: {
    getInstance: () => ({
      getShippingInfoByCountry: h.getShippingInfoByCountry,
    }),
  },
}));

vi.mock('../../../src/utils', () => ({
  default: class {
    isMainServer = h.isMainServer;
  },
}));

vi.mock('../../../src/services/fx', () => ({
  default: { getInstance: () => ({ convertAndFormat: h.fxConvertAndFormat }) },
}));

vi.mock('../../../src/pdf', () => ({
  default: class {
    renderUrlToPdfBuffer = h.pdfRenderUrlToPdfBuffer;
  },
}));

vi.mock('openai', () => ({
  default: class {
    images = { edit: h.openaiImagesEdit };
    constructor(_opts: any) {}
  },
}));

vi.mock('axios', () => ({ default: { get: h.axiosGet } }));

vi.mock('sharp', () => {
  const makeChain = () => {
    const chain: any = {};
    for (const m of [
      'jpeg',
      'png',
      'resize',
      'extend',
      'modulate',
      'composite',
    ]) {
      chain[m] = () => chain;
    }
    chain.toBuffer = async () => Buffer.from('sharp-bytes');
    chain.toFile = async () => ({});
    chain.metadata = async () => ({ width: 1200, height: 1200 });
    return chain;
  };
  return { default: (..._args: any[]) => makeChain() };
});

vi.mock('@hyzyla/pdfium', () => ({
  PDFiumLibrary: {
    init: async () => ({
      loadDocument: async () => ({
        getPage: () => ({
          render: async () => ({ data: Buffer.from('png-bytes') }),
        }),
        destroy() {},
      }),
      destroy() {},
    }),
  },
}));

import { merchantCenter } from '../../../src/merchantcenter';

const svc: any = merchantCenter; // for private-method access in tests

const PUBLIC_DIR = process.env['PUBLIC_DIR']!;
const ASSETS_DIR = process.env['ASSETS_DIR']!;
const PRODUCTS_DIR = path.join(PUBLIC_DIR, 'products');
const AI_IMAGE_URL =
  'https://api.qrsong.io/public/products/merchant_ai_PL7_1000.jpg';

// Deterministic FX rates used by the mocked Fx.convertAndFormat. Mirrors the
// real contract: unknown / EUR targets fall back to EUR with the raw amount.
const FX_RATES: Record<string, number> = {
  USD: 2,
  GBP: 0.8,
  AUD: 1.6,
  CAD: 1.4,
  CHF: 1.2,
  SEK: 10,
  NOK: 12,
};

const MERCHANT_TRANSLATIONS: Record<string, Record<string, string>> = {
  en: { qr_music_game: 'QR Music Game', cards: 'cards', pdf: 'PDF', sheets: 'sheets' },
  nl: { qr_music_game: 'QR Muziekspel', cards: 'kaarten', pdf: 'PDF', sheets: 'vellen' },
  de: { qr_music_game: 'QR Musikspiel', cards: 'Karten', pdf: 'PDF', sheets: 'Bögen' },
  es: { qr_music_game: 'Juego Musical QR', cards: 'cartas' },
  sv: { qr_music_game: 'QR Musikspel', cards: 'kort' },
  no: { qr_music_game: 'QR Musikkspill', cards: 'kort' },
};

const PRODUCT_TYPE_TRANSLATIONS: Record<string, Record<string, string>> = {
  en: { digital: 'Digital PDF (en)', physical: 'Physical Cards (en)' },
  nl: { digital: 'Digitale PDF' },
};

const SHIPPING_TIERS = [
  { size: 80, cost: 3 },
  { size: 405, cost: 5 },
  { size: 1000, cost: 8 },
];
const ALL_COUNTRIES = [
  'US', 'GB', 'AU', 'CA', 'NL', 'BE', 'DE', 'AT', 'CH', 'ES', 'SE', 'NO',
];

function makePlaylist(overrides: Record<string, any> = {}): any {
  return {
    id: 7,
    playlistId: 'PL7',
    name: 'Top Hits',
    slug: 'top-hits',
    image: 'https://i.scdn.co/image/abc',
    price: 25,
    numberOfTracks: 100,
    featured: true,
    featuredLocale: null,
    description_en: 'EN description',
    description_nl: 'NL beschrijving',
    description_de: 'DE Beschreibung',
    genre: {
      id: 1,
      slug: 'pop',
      name_en: 'Pop',
      name_nl: 'Pop',
      name_de: 'Pop',
      name_es: 'Pop',
      name_sv: 'Pop',
      name_no: 'Pop',
    },
    ...overrides,
  };
}

function makeVariant(overrides: Record<string, any> = {}): any {
  return {
    id: 7,
    playlistId: 'PL7',
    name: 'Top Hits',
    description: 'NL beschrijving',
    image: 'https://i.scdn.co/image/abc',
    price: 21.95,
    numberOfTracks: 100,
    type: 'physical',
    locale: 'nl',
    country: 'NL',
    slug: 'top-hits',
    genre: 'Pop',
    genreSlug: 'pop',
    ...overrides,
  };
}

async function putAIImage(playlistId = 'PL7', ts = 1000): Promise<void> {
  await fsp.mkdir(PRODUCTS_DIR, { recursive: true });
  await fsp.writeFile(
    path.join(PRODUCTS_DIR, `merchant_ai_${playlistId}_${ts}.jpg`),
    'jpg-bytes'
  );
}

function notFound404(): Error {
  const err: any = new Error('product not found');
  err.code = 404;
  return err;
}

beforeEach(async () => {
  // Reset every holder mock (calls AND one-off implementations)…
  for (const fn of [
    ...Object.values(h.products),
    ...Object.values(h.prisma.playlist),
    h.prisma.paymentHasPlaylist.findFirst,
    h.translationsByPrefix,
    h.getOrderType,
    h.getShippingInfoByCountry,
    h.isMainServer,
    h.fxConvertAndFormat,
    h.pdfRenderUrlToPdfBuffer,
    h.openaiImagesEdit,
    h.axiosGet,
    h.cronCtor,
    h.googleAuthCtor,
    h.contentCtor,
  ]) {
    fn.mockReset();
  }

  // …then install the defaults each suite relies on.
  h.isMainServer.mockResolvedValue(false);
  h.fxConvertAndFormat.mockImplementation(
    async (amountEur: number, target: string) => {
      const rate = FX_RATES[target];
      if (!rate) return { value: amountEur.toFixed(2), currency: 'EUR' };
      return { value: (amountEur * rate).toFixed(2), currency: target };
    }
  );
  h.translationsByPrefix.mockImplementation(
    async (locale: string, prefix: string) => {
      if (prefix === 'merchant') return MERCHANT_TRANSLATIONS[locale] ?? null;
      if (prefix === 'product_type') {
        return PRODUCT_TYPE_TRANSLATIONS[locale] ?? null;
      }
      return null;
    }
  );
  h.getOrderType.mockResolvedValue({ amount: 21.95 });
  h.getShippingInfoByCountry.mockResolvedValue({
    countries: ALL_COUNTRIES.map((countryCode) => ({
      countryCode,
      shippingCosts: SHIPPING_TIERS,
    })),
  });
  h.products.get.mockImplementation(async () => {
    throw notFound404();
  });
  h.products.insert.mockResolvedValue({});
  h.products.update.mockResolvedValue({});
  h.products.delete.mockResolvedValue({});
  h.products.list.mockResolvedValue({ data: { resources: [] } });
  h.prisma.playlist.findMany.mockResolvedValue([]);
  h.prisma.playlist.findUnique.mockResolvedValue(null);
  h.prisma.playlist.update.mockResolvedValue({});
  h.prisma.playlist.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue(null);
  h.axiosGet.mockRejectedValue(new Error('axios not stubbed for this test'));
  h.pdfRenderUrlToPdfBuffer.mockResolvedValue(Buffer.from('%PDF-fake'));
  h.openaiImagesEdit.mockResolvedValue({
    data: [{ b64_json: Buffer.from('ai-image').toString('base64') }],
  });

  // Per-test filesystem + instance state.
  svc.shippingCostsByCountry = new Map();
  await fsp.rm(PRODUCTS_DIR, { recursive: true, force: true });
  delete process.env['DEBUG_MERCHANT_CENTER'];
  delete process.env['FORCE_NEW_IMAGES'];
  process.env['ENVIRONMENT'] = 'test';
});

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
describe('initialization', () => {
  it('authenticates with the service account and builds the v2.1 Content API client', async () => {
    // First public call triggers lazy init.
    const products = await merchantCenter.listProducts();
    expect(products).toEqual([]);
    expect(h.googleAuthCtor).toHaveBeenCalledWith({
      keyFile: '/tmp/fake-google-key.json',
      scopes: ['https://www.googleapis.com/auth/content'],
    });
    expect(h.contentCtor).toHaveBeenCalledWith({
      version: 'v2.1',
      auth: h.authClient,
    });
    expect(h.products.list).toHaveBeenCalledWith({
      merchantId: 'merchant-test-1',
    });
  });

  it('falls back to a no-op stub client when the key file env var is missing', async () => {
    const savedKey = process.env['GOOGLE_SERVICE_ACCOUNT_KEY_FILE'];
    try {
      delete process.env['GOOGLE_SERVICE_ACCOUNT_KEY_FILE'];
      svc.initialized = false;
      svc.initPromise = null;
      const products = await merchantCenter.listProducts();
      expect(products).toEqual([]);
      // The real (mocked) Content API was never touched.
      expect(h.products.list).not.toHaveBeenCalled();
    } finally {
      process.env['GOOGLE_SERVICE_ACCOUNT_KEY_FILE'] = savedKey;
      svc.initialized = false;
      svc.initPromise = null;
      await svc.ensureInitialized(); // reinstall the captured client
    }
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe('getGenreGroup (PMax custom_label_1)', () => {
  it('maps known genre slugs to their campaign group, case-insensitively', () => {
    expect(svc.getGenreGroup('pop')).toBe('pop_hits');
    expect(svc.getGenreGroup('METAL')).toBe('rock_metal');
    expect(svc.getGenreGroup('hiphop')).toBe('world_dance');
    expect(svc.getGenreGroup('jazz')).toBe('other');
  });

  it('falls back to "other" for unknown or missing slugs', () => {
    expect(svc.getGenreGroup(undefined)).toBe('other');
    expect(svc.getGenreGroup('polka')).toBe('other');
  });

  it('only matches the misspelled keys "raggae"/"sountracks" — correctly spelled slugs fall through to "other" (suspected typo bug)', () => {
    expect(svc.getGenreGroup('raggae')).toBe('world_dance');
    expect(svc.getGenreGroup('sountracks')).toBe('other');
    // If the real genre table uses correct spellings, these silently land in
    // "other" instead of their intended groups:
    expect(svc.getGenreGroup('reggae')).toBe('other');
    expect(svc.getGenreGroup('soundtracks')).toBe('other');
  });
});

describe('getTrackCountRange (PMax custom_label_3)', () => {
  it('buckets track counts at <100 / <=250 / >250', () => {
    expect(svc.getTrackCountRange(99)).toBe('small');
    expect(svc.getTrackCountRange(100)).toBe('medium');
    expect(svc.getTrackCountRange(250)).toBe('medium');
    expect(svc.getTrackCountRange(251)).toBe('large');
  });
});

describe('getProductTypes', () => {
  it('includes the genre and the per-type leaf category', () => {
    expect(svc.getProductTypes(makeVariant())).toEqual([
      'Music',
      'QR Codes',
      'Pop',
      'Physical Product',
    ]);
    expect(
      svc.getProductTypes(makeVariant({ type: 'digital', genre: undefined }))
    ).toEqual(['Music', 'QR Codes', 'Digital Downloads']);
    expect(svc.getProductTypes(makeVariant({ type: 'sheets' }))).toEqual([
      'Music',
      'QR Codes',
      'Pop',
      'Printable',
    ]);
  });
});

describe('computeExpectedProductIdsForPlaylist', () => {
  it('produces one physical product ID per locale-country pair', () => {
    const ids = svc.computeExpectedProductIdsForPlaylist({
      id: 7,
      featuredLocale: null,
    });
    expect(ids).toEqual([
      'online:en:US:7_3_1',
      'online:en:GB:7_3_1',
      'online:en:AU:7_3_1',
      'online:en:CA:7_3_1',
      'online:nl:NL:7_3_2',
      'online:nl:BE:7_3_2',
      'online:de:DE:7_3_3',
      'online:de:AT:7_3_3',
      'online:de:CH:7_3_3',
      'online:es:ES:7_3_4',
      'online:sv:SE:7_3_5',
      'online:no:NO:7_3_6',
    ]);
  });

  it('restricts to the featured locale when one is set', () => {
    const ids = svc.computeExpectedProductIdsForPlaylist({
      id: 7,
      featuredLocale: 'de',
    });
    expect(ids).toEqual([
      'online:de:DE:7_3_3',
      'online:de:AT:7_3_3',
      'online:de:CH:7_3_3',
    ]);
  });

  it('returns nothing for an unsupported featured locale', () => {
    expect(
      svc.computeExpectedProductIdsForPlaylist({ id: 7, featuredLocale: 'fr' })
    ).toEqual([]);
  });
});

describe('getProductTypeLabel', () => {
  it('uses the locale translation when available', async () => {
    expect(await svc.getProductTypeLabel('digital', 'nl')).toBe(
      'Digitale PDF'
    );
  });

  it('falls back to English when the locale lacks the key', async () => {
    expect(await svc.getProductTypeLabel('physical', 'nl')).toBe(
      'Physical Cards (en)'
    );
    expect(await svc.getProductTypeLabel('physical', 'de')).toBe(
      'Physical Cards (en)'
    );
  });

  it('falls back to the hardcoded defaults, then to the raw type', async () => {
    expect(await svc.getProductTypeLabel('sheets', 'de')).toBe('Print Sheets');
    expect(await svc.getProductTypeLabel('mystery', 'de')).toBe('mystery');
  });
});

// ---------------------------------------------------------------------------
// Shipping cost resolution
// ---------------------------------------------------------------------------
describe('loadShippingCosts / getShippingCostForVariant', () => {
  it('loads per-country tiers from Shipping and resolves the PrintEnBind size tiers', async () => {
    await svc.loadShippingCosts();
    // digital is always free
    expect(svc.getShippingCostForVariant('NL', 'digital', 500)).toBe(0);
    // sheets always use the smallest tier
    expect(svc.getShippingCostForVariant('NL', 'sheets', 500)).toBe(3);
    // physical picks the smallest tier >= numberOfTracks
    expect(svc.getShippingCostForVariant('NL', 'physical', 80)).toBe(3);
    expect(svc.getShippingCostForVariant('NL', 'physical', 81)).toBe(5);
    expect(svc.getShippingCostForVariant('NL', 'physical', 405)).toBe(5);
    expect(svc.getShippingCostForVariant('NL', 'physical', 406)).toBe(8);
    // capped at the 1000 tier
    expect(svc.getShippingCostForVariant('NL', 'physical', 2000)).toBe(8);
  });

  it('returns null for countries without configured costs', async () => {
    await svc.loadShippingCosts();
    expect(svc.getShippingCostForVariant('JP', 'physical', 100)).toBeNull();
  });

  it('falls back to the next larger size, then the largest available', () => {
    svc.shippingCostsByCountry = new Map([
      ['NL', [{ size: 500, cost: 9 }]],
      ['BE', [{ size: 80, cost: 3 }]],
    ]);
    // no exact 405 tier → smallest size >= 405
    expect(svc.getShippingCostForVariant('NL', 'physical', 100)).toBe(9);
    // nothing >= 405 → largest available
    expect(svc.getShippingCostForVariant('BE', 'physical', 100)).toBe(3);
  });

  it('clears the map (so lookups return null) when Shipping fails', async () => {
    h.getShippingInfoByCountry.mockRejectedValue(new Error('db down'));
    await svc.loadShippingCosts();
    expect(svc.getShippingCostForVariant('NL', 'physical', 100)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createMerchantProduct — feed payload building
// ---------------------------------------------------------------------------
describe('createMerchantProduct', () => {
  beforeEach(async () => {
    await putAIImage();
    svc.shippingCostsByCountry = new Map(
      ALL_COUNTRIES.map((c) => [c, SHIPPING_TIERS])
    );
  });

  it('builds the complete physical-card payload for nl/NL in EUR', async () => {
    const product = await svc.createMerchantProduct(makeVariant());
    expect(product).toEqual({
      id: 'online:nl:NL:7_3_2',
      offerId: '7_3_2',
      title: 'QR Muziekspel (kaarten) - Top Hits - 100 kaarten',
      description: 'NL beschrijving Bevat 100 muzieknummers',
      link: 'https://www.qrsong.io/nl/product/top-hits?orderType=physical',
      imageLink: AI_IMAGE_URL,
      availability: 'in_stock',
      condition: 'new',
      price: { value: '21.95', currency: 'EUR' },
      brand: 'QRSong!',
      contentLanguage: 'nl',
      targetCountry: 'NL',
      channel: 'online',
      productTypes: ['Music', 'QR Codes', 'Pop', 'Physical Product'],
      googleProductCategory: '5030',
      shipping: [
        {
          country: 'NL',
          service: 'Standard Shipping',
          price: { value: '5.00', currency: 'EUR' },
          minHandlingTime: 1,
          maxHandlingTime: 2,
          minTransitTime: 2,
          maxTransitTime: 5,
        },
      ],
      shippingLabel: 'standard_shipping',
      customAttributes: [
        { name: 'number_of_tracks', value: '100' },
        { name: 'product_variant', value: 'physical' },
        { name: 'playlist_slug', value: 'top-hits' },
        { name: 'custom_label_0', value: 'physical' },
        { name: 'custom_label_1', value: 'pop_hits' },
        { name: 'custom_label_2', value: 'pop' },
        { name: 'custom_label_3', value: 'medium' },
        { name: 'custom_label_4', value: '' },
      ],
    });
    // Price and shipping were converted through Fx with the country currency
    // resolved by the real currency-map module.
    expect(h.fxConvertAndFormat).toHaveBeenCalledWith(21.95, 'EUR');
    expect(h.fxConvertAndFormat).toHaveBeenCalledWith(5, 'EUR');
  });

  it('converts price and shipping into the target-country currency (en/US → USD)', async () => {
    const product = await svc.createMerchantProduct(
      makeVariant({ locale: 'en', country: 'US', description: 'EN description' })
    );
    expect(product.id).toBe('online:en:US:7_3_1');
    expect(product.contentLanguage).toBe('en');
    expect(product.targetCountry).toBe('US');
    expect(product.price).toEqual({ value: '43.90', currency: 'USD' });
    expect(product.shipping).toEqual([
      expect.objectContaining({
        country: 'US',
        service: 'Standard Shipping',
        price: { value: '10.00', currency: 'USD' },
      }),
    ]);
    expect(product.title).toBe('QR Music Game (cards) - Top Hits - 100 cards');
    expect(product.description).toBe('EN description Contains 100 music tracks');
    expect(h.fxConvertAndFormat).toHaveBeenCalledWith(21.95, 'USD');
    expect(h.fxConvertAndFormat).toHaveBeenCalledWith(5, 'USD');
  });

  it('keeps value and currency consistent when FX falls back to EUR', async () => {
    // Simulate the Fx fallback: CHF rate unavailable → EUR comes back.
    h.fxConvertAndFormat.mockImplementation(async (amountEur: number) => ({
      value: amountEur.toFixed(2),
      currency: 'EUR',
    }));
    const product = await svc.createMerchantProduct(
      makeVariant({ locale: 'de', country: 'CH', description: 'DE Beschreibung' })
    );
    // We trust the returned currency, not the requested one.
    expect(h.fxConvertAndFormat).toHaveBeenCalledWith(21.95, 'CHF');
    expect(product.price).toEqual({ value: '21.95', currency: 'EUR' });
    expect(product.shipping[0].price).toEqual({
      value: '5.00',
      currency: 'EUR',
    });
  });

  it('marks digital products as free instant delivery with category 839', async () => {
    const product = await svc.createMerchantProduct(
      makeVariant({ type: 'digital', locale: 'en', country: 'US' })
    );
    expect(product.id).toBe('online:en:US:7_1_1');
    expect(product.offerId).toBe('7_1_1');
    expect(product.googleProductCategory).toBe('839');
    expect(product.shippingLabel).toBe('digital_delivery');
    expect(product.shipping).toEqual([
      {
        country: 'US',
        service: 'Digital Delivery',
        price: { value: '0', currency: 'USD' },
        minHandlingTime: 0,
        maxHandlingTime: 0,
        minTransitTime: 0,
        maxTransitTime: 0,
      },
    ]);
    expect(product.title).toBe('QR Music Game (PDF) - Top Hits - 100 cards');
    expect(
      product.customAttributes.find((a: any) => a.name === 'custom_label_0')
        ?.value
    ).toBe('digital');
  });

  it('uses the smallest shipping tier for sheets and the sheets title suffix', async () => {
    const product = await svc.createMerchantProduct(
      makeVariant({ type: 'sheets' })
    );
    expect(product.id).toBe('online:nl:NL:7_2_2');
    expect(product.title).toBe('QR Muziekspel (vellen) - Top Hits - 100 kaarten');
    expect(product.googleProductCategory).toBe('5030');
    expect(product.shipping[0].price).toEqual({
      value: '3.00',
      currency: 'EUR',
    });
    expect(product.shippingLabel).toBe('standard_shipping');
  });

  it('falls back to 4.95 EUR shipping when the country has no configured cost', async () => {
    svc.shippingCostsByCountry = new Map();
    const product = await svc.createMerchantProduct(makeVariant());
    expect(product.shipping[0].price).toEqual({
      value: '4.95',
      currency: 'EUR',
    });
    expect(h.fxConvertAndFormat).toHaveBeenCalledWith(4.95, 'EUR');
  });

  it('uses English defaults when merchant translations are unavailable', async () => {
    h.translationsByPrefix.mockResolvedValueOnce(null);
    const product = await svc.createMerchantProduct(makeVariant());
    // With the translation table unavailable, both the title and the unit
    // label fall back to English.
    expect(product.title).toBe('QR Music Game (cards) - Top Hits - 100 cards');
  });

  it('truncates the description to 5000 characters', async () => {
    const product = await svc.createMerchantProduct(
      makeVariant({ description: 'x'.repeat(5100) })
    );
    expect(product.description).toHaveLength(5000);
    expect(product.description.startsWith('xxx')).toBe(true);
  });

  it('keeps the (oddly leading-spaced) track label when the description is empty', async () => {
    const product = await svc.createMerchantProduct(
      makeVariant({ description: undefined, locale: 'en', country: 'US' })
    );
    expect(product.description).toBe(' Contains 100 music tracks');
  });
});

// ---------------------------------------------------------------------------
// generateProductImage
// ---------------------------------------------------------------------------
describe('generateProductImage', () => {
  it('prefers the most recent AI product image when one exists on disk', async () => {
    await putAIImage('PL7', 1000);
    await putAIImage('PL7', 2000);
    const url = await svc.generateProductImage(
      'https://i.scdn.co/image/abc',
      'PL7_physical_nl',
      'physical'
    );
    expect(url).toBe(
      'https://api.qrsong.io/public/products/merchant_ai_PL7_2000.jpg'
    );
    expect(h.axiosGet).not.toHaveBeenCalled();
  });

  it('reuses an existing composite image outside development', async () => {
    await fsp.mkdir(PRODUCTS_DIR, { recursive: true });
    await fsp.writeFile(
      path.join(PRODUCTS_DIR, 'merchant_PL9_physical_en_123.jpg'),
      'jpg'
    );
    const url = await svc.generateProductImage(
      'https://i.scdn.co/image/abc',
      'PL9_physical_en',
      'physical'
    );
    expect(url).toBe(
      'https://api.qrsong.io/public/products/merchant_PL9_physical_en_123.jpg'
    );
    expect(h.axiosGet).not.toHaveBeenCalled();
  });

  it('composes a fresh versioned image when none exists', async () => {
    h.axiosGet.mockResolvedValue({ data: Buffer.from('cover-bytes') });
    const url = await svc.generateProductImage(
      'https://i.scdn.co/image/abc',
      'PL9_physical_en',
      'physical'
    );
    expect(url).toMatch(
      /^https:\/\/api\.qrsong\.io\/public\/products\/merchant_PL9_physical_en_\d+\.jpg$/
    );
    expect(h.axiosGet).toHaveBeenCalledWith(
      'https://i.scdn.co/image/abc',
      expect.objectContaining({ responseType: 'arraybuffer' })
    );
  });

  it('falls back to the original Spotify URL when the download fails', async () => {
    h.axiosGet.mockRejectedValue(new Error('403 from CDN'));
    const url = await svc.generateProductImage(
      'https://i.scdn.co/image/abc',
      'PL9_physical_en',
      'physical'
    );
    expect(url).toBe('https://i.scdn.co/image/abc');
  });
});

// ---------------------------------------------------------------------------
// uploadFeaturedPlaylists — country × language × currency fan-out
// ---------------------------------------------------------------------------
describe('uploadFeaturedPlaylists', () => {
  it('inserts one product per locale-country pair with localized payloads and currencies', async () => {
    const playlist = makePlaylist();
    await putAIImage();
    h.prisma.playlist.findMany
      .mockResolvedValueOnce([{ id: 7 }]) // sorted IDs
      .mockResolvedValueOnce([playlist]) // full records
      .mockResolvedValueOnce([{ id: 7, featuredLocale: null }]); // cleanup set
    h.products.list.mockResolvedValue({
      data: {
        resources: [
          { id: 'online:nl:NL:7_3_2' }, // expected → kept
          { id: 'online:en:US:999_3_1' }, // stale → deleted
        ],
      },
    });

    await merchantCenter.uploadFeaturedPlaylists();

    // Query shape for the sync candidates.
    expect(h.prisma.playlist.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        featured: true,
        slug: { not: '' },
        markedForMerchantCenter: true,
        promotionalActive: true,
      },
      orderBy: { score: 'desc' },
      select: { id: true },
      take: undefined,
    });
    expect(h.prisma.playlist.findMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: [7] } },
      include: { genre: true },
    });

    // Price lookup mirrors the summary component.
    expect(h.getOrderType).toHaveBeenCalledWith(100, false, 'cards', 'PL7', 'none');

    // 12 inserts: en×4 countries, nl×2, de×3, es/sv/no ×1.
    expect(h.products.insert).toHaveBeenCalledTimes(12);
    const calls = h.products.insert.mock.calls;
    for (const call of calls) {
      expect(call[0].merchantId).toBe('merchant-test-1');
    }
    const byCountry = new Map(
      calls.map((c: any[]) => [c[0].requestBody.targetCountry, c[0].requestBody])
    );

    const rows: Array<[string, string, string, string, string, string]> = [
      // country, language, price, currency, shipping price, product id
      ['US', 'en', '43.90', 'USD', '10.00', 'online:en:US:7_3_1'],
      ['GB', 'en', '17.56', 'GBP', '4.00', 'online:en:GB:7_3_1'],
      ['AU', 'en', '35.12', 'AUD', '8.00', 'online:en:AU:7_3_1'],
      ['CA', 'en', '30.73', 'CAD', '7.00', 'online:en:CA:7_3_1'],
      ['NL', 'nl', '21.95', 'EUR', '5.00', 'online:nl:NL:7_3_2'],
      ['BE', 'nl', '21.95', 'EUR', '5.00', 'online:nl:BE:7_3_2'],
      ['DE', 'de', '21.95', 'EUR', '5.00', 'online:de:DE:7_3_3'],
      ['AT', 'de', '21.95', 'EUR', '5.00', 'online:de:AT:7_3_3'],
      ['CH', 'de', '26.34', 'CHF', '6.00', 'online:de:CH:7_3_3'],
      ['ES', 'es', '21.95', 'EUR', '5.00', 'online:es:ES:7_3_4'],
      ['SE', 'sv', '219.50', 'SEK', '50.00', 'online:sv:SE:7_3_5'],
      ['NO', 'no', '263.40', 'NOK', '60.00', 'online:no:NO:7_3_6'],
    ];
    for (const [country, lang, value, currency, shipValue, id] of rows) {
      const body: any = byCountry.get(country);
      expect(body, `payload for ${country}`).toBeDefined();
      expect(body.id).toBe(id);
      expect(body.contentLanguage).toBe(lang);
      expect(body.targetCountry).toBe(country);
      expect(body.channel).toBe('online');
      expect(body.price).toEqual({ value, currency });
      expect(body.shipping).toEqual([
        {
          country,
          service: 'Standard Shipping',
          price: { value: shipValue, currency },
          minHandlingTime: 1,
          maxHandlingTime: 2,
          minTransitTime: 2,
          maxTransitTime: 5,
        },
      ]);
      expect(body.link).toBe(
        `https://www.qrsong.io/${lang}/product/top-hits?orderType=physical`
      );
      expect(body.imageLink).toBe(AI_IMAGE_URL);
    }

    // Same English content for all four English-speaking targets.
    expect((byCountry.get('US') as any).title).toBe(
      'QR Music Game (cards) - Top Hits - 100 cards'
    );
    expect((byCountry.get('GB') as any).title).toBe(
      'QR Music Game (cards) - Top Hits - 100 cards'
    );
    // Localized Dutch content for NL/BE.
    expect((byCountry.get('BE') as any).description).toBe(
      'NL beschrijving Bevat 100 muzieknummers'
    );
    // sv has no description_sv → falls back to English text + Swedish label.
    expect((byCountry.get('SE') as any).description).toBe(
      'EN description Innehåller 100 musikspår'
    );

    // The sync flag is cleared after upload (non-development).
    expect(h.prisma.playlist.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { markedForMerchantCenter: false },
    });

    // Cleanup pass removed only the stale product.
    expect(h.products.delete).toHaveBeenCalledTimes(1);
    expect(h.products.delete).toHaveBeenCalledWith({
      merchantId: 'merchant-test-1',
      productId: 'online:en:US:999_3_1',
    });
  });

  it('returns early without touching the API when no playlist is marked', async () => {
    h.prisma.playlist.findMany.mockResolvedValue([]);
    await merchantCenter.uploadFeaturedPlaylists();
    expect(h.products.insert).not.toHaveBeenCalled();
    expect(h.products.list).not.toHaveBeenCalled();
    expect(h.prisma.playlist.update).not.toHaveBeenCalled();
  });

  it('skips the cleanup pass when the full featured list cannot be loaded', async () => {
    await putAIImage();
    h.prisma.playlist.findMany
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce([makePlaylist()])
      .mockRejectedValueOnce(new Error('db hiccup'));

    await expect(merchantCenter.uploadFeaturedPlaylists()).resolves.toBeUndefined();
    expect(h.products.insert).toHaveBeenCalledTimes(12);
    // No list/delete: cleanup was skipped to avoid deleting valid products.
    expect(h.products.list).not.toHaveBeenCalled();
    expect(h.products.delete).not.toHaveBeenCalled();
  });

  it('rethrows when the initial playlist query fails', async () => {
    h.prisma.playlist.findMany.mockRejectedValue(new Error('db down'));
    await expect(merchantCenter.uploadFeaturedPlaylists()).rejects.toThrow(
      'db down'
    );
  });
});

// ---------------------------------------------------------------------------
// uploadPlaylist — gating and price fallbacks
// ---------------------------------------------------------------------------
describe('uploadPlaylist', () => {
  beforeEach(async () => {
    await putAIImage();
  });

  it('only uploads the featured locale when featuredLocale is set', async () => {
    const ids = await svc.uploadPlaylist(makePlaylist({ featuredLocale: 'de' }));
    expect(ids).toEqual([
      'online:de:DE:7_3_3',
      'online:de:AT:7_3_3',
      'online:de:CH:7_3_3',
    ]);
    expect(h.products.insert).toHaveBeenCalledTimes(3);
  });

  it('uploads nothing for an unsupported featured locale', async () => {
    const ids = await svc.uploadPlaylist(makePlaylist({ featuredLocale: 'fr' }));
    expect(ids).toEqual([]);
    expect(h.products.insert).not.toHaveBeenCalled();
  });

  it('stops after the first variant in debug mode', async () => {
    process.env['DEBUG_MERCHANT_CENTER'] = 'true';
    const ids = await svc.uploadPlaylist(makePlaylist());
    expect(ids).toEqual(['online:en:US:7_3_1']);
    expect(h.products.insert).toHaveBeenCalledTimes(1);
  });

  it('falls back to the playlist price when no order type matches', async () => {
    h.getOrderType.mockResolvedValue(null);
    await svc.uploadPlaylist(makePlaylist({ featuredLocale: 'nl', price: 25 }));
    const bodies = h.products.insert.mock.calls.map(
      (c: any[]) => c[0].requestBody
    );
    expect(bodies.map((b: any) => b.targetCountry)).toEqual(['NL', 'BE']);
    expect(bodies[0].price).toEqual({ value: '25.00', currency: 'EUR' });
  });

  it('falls back to 29.99 when neither order type nor playlist price exist', async () => {
    h.getOrderType.mockResolvedValue(null);
    await svc.uploadPlaylist(
      makePlaylist({ featuredLocale: 'nl', price: null })
    );
    expect(
      h.products.insert.mock.calls[0][0].requestBody.price
    ).toEqual({ value: '29.99', currency: 'EUR' });
  });
});

// ---------------------------------------------------------------------------
// uploadProductVariant — insert vs update vs failure
// ---------------------------------------------------------------------------
describe('uploadProductVariant', () => {
  beforeEach(async () => {
    await putAIImage();
  });

  it('PATCHes the existing product when Google already has it', async () => {
    h.products.get.mockResolvedValue({ data: { id: 'google-side-id' } });
    const id = await svc.uploadProductVariant(makeVariant());
    expect(id).toBe('online:nl:NL:7_3_2');
    expect(h.products.insert).not.toHaveBeenCalled();
    expect(h.products.update).toHaveBeenCalledTimes(1);

    const call = h.products.update.mock.calls[0][0];
    expect(call.merchantId).toBe('merchant-test-1');
    expect(call.productId).toBe('google-side-id');
    expect(call.updateMask).toBe(
      'title,description,link,imageLink,price,availability,brand,googleProductCategory,productTypes,shipping,shippingLabel'
    );
    // PATCH body: condition included, customAttributes excluded (cannot be
    // updated via PATCH), identity fields not resent.
    expect(call.requestBody).toEqual({
      title: 'QR Muziekspel (kaarten) - Top Hits - 100 kaarten',
      description: 'NL beschrijving Bevat 100 muzieknummers',
      link: 'https://www.qrsong.io/nl/product/top-hits?orderType=physical',
      imageLink: AI_IMAGE_URL,
      price: { value: '21.95', currency: 'EUR' },
      availability: 'in_stock',
      brand: 'QRSong!',
      googleProductCategory: '5030',
      productTypes: ['Music', 'QR Codes', 'Pop', 'Physical Product'],
      shipping: [
        expect.objectContaining({
          country: 'NL',
          price: { value: '4.95', currency: 'EUR' }, // no costs loaded → fallback
        }),
      ],
      shippingLabel: 'standard_shipping',
      condition: 'new',
    });
  });

  it('retries the update with the bare offerId when the composite ID is rejected', async () => {
    h.products.get.mockResolvedValue({ data: { id: 'google-side-id' } });
    h.products.update
      .mockRejectedValueOnce(new Error('invalid id'))
      .mockResolvedValueOnce({});
    const id = await svc.uploadProductVariant(makeVariant());
    expect(id).toBe('online:nl:NL:7_3_2');
    expect(h.products.update).toHaveBeenCalledTimes(2);
    expect(h.products.update.mock.calls[1][0].productId).toBe('7_3_2');
  });

  it('returns null instead of throwing when the insert fails', async () => {
    h.products.insert.mockRejectedValue(new Error('quota exceeded'));
    const id = await svc.uploadProductVariant(makeVariant());
    expect(id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Thin Content API wrappers
// ---------------------------------------------------------------------------
describe('Content API wrappers', () => {
  it('getProduct returns null on 404 and rethrows other errors', async () => {
    expect(await svc.getProduct('online:nl:NL:7_3_2')).toBeNull();

    h.products.get.mockResolvedValue({ data: { id: 'x', title: 't' } });
    expect(await svc.getProduct('online:nl:NL:7_3_2')).toEqual({
      id: 'x',
      title: 't',
    });

    const boom: any = new Error('server error');
    boom.code = 500;
    h.products.get.mockRejectedValue(boom);
    await expect(svc.getProduct('online:nl:NL:7_3_2')).rejects.toThrow(
      'server error'
    );
  });

  it('deleteProduct forwards the merchant and product IDs', async () => {
    await merchantCenter.deleteProduct('online:nl:NL:7_3_2');
    expect(h.products.delete).toHaveBeenCalledWith({
      merchantId: 'merchant-test-1',
      productId: 'online:nl:NL:7_3_2',
    });
  });

  it('deleteProduct rethrows API errors', async () => {
    h.products.delete.mockRejectedValue(new Error('forbidden'));
    await expect(merchantCenter.deleteProduct('x')).rejects.toThrow('forbidden');
  });

  it('listProducts returns [] when Google sends no resources and throws on failure', async () => {
    h.products.list.mockResolvedValue({ data: {} });
    expect(await merchantCenter.listProducts()).toEqual([]);

    h.products.list.mockRejectedValue(new Error('rate limited'));
    await expect(merchantCenter.listProducts()).rejects.toThrow('rate limited');
  });
});

describe('clearAllProducts', () => {
  it('refuses to run outside development', async () => {
    await expect(merchantCenter.clearAllProducts()).rejects.toThrow(
      'clearAllProducts() is only available in development mode'
    );
    expect(h.products.delete).not.toHaveBeenCalled();
  });

  it('deletes every listed product in development, tolerating individual failures', async () => {
    process.env['ENVIRONMENT'] = 'development';
    try {
      h.products.list.mockResolvedValue({
        data: { resources: [{ id: 'a' }, { id: 'b' }, { noId: true }] },
      });
      h.products.delete
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('gone already'));

      await expect(merchantCenter.clearAllProducts()).resolves.toBeUndefined();
      expect(h.products.delete).toHaveBeenCalledTimes(2);
      expect(h.products.delete).toHaveBeenCalledWith({
        merchantId: 'merchant-test-1',
        productId: 'a',
      });
      expect(h.products.delete).toHaveBeenCalledWith({
        merchantId: 'merchant-test-1',
        productId: 'b',
      });
    } finally {
      process.env['ENVIRONMENT'] = 'test';
    }
  });
});

// ---------------------------------------------------------------------------
// AI product images
// ---------------------------------------------------------------------------
describe('generateAIProductImage', () => {
  it('returns the existing image and re-flags the playlist without regenerating', async () => {
    await putAIImage('PL7', 1000);
    const url = await merchantCenter.generateAIProductImage('PL7');
    expect(url).toBe(AI_IMAGE_URL);
    expect(h.openaiImagesEdit).not.toHaveBeenCalled();
    expect(h.prisma.playlist.findUnique).not.toHaveBeenCalled();
    expect(h.prisma.playlist.updateMany).toHaveBeenCalledWith({
      where: { playlistId: 'PL7' },
      data: { markedForMerchantCenter: true },
    });
  });

  it('returns null when the playlist does not exist', async () => {
    h.prisma.playlist.findUnique.mockResolvedValue(null);
    expect(await merchantCenter.generateAIProductImage('ghost')).toBeNull();
    expect(h.openaiImagesEdit).not.toHaveBeenCalled();
  });

  it('returns null when no sample payment with a qrSubDir exists', async () => {
    h.prisma.playlist.findUnique.mockResolvedValue(makePlaylist());
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue(null);
    expect(await merchantCenter.generateAIProductImage('PL7')).toBeNull();
    expect(h.prisma.paymentHasPlaylist.findFirst).toHaveBeenCalledWith({
      where: { playlistId: 7, payment: { qrSubDir: { not: null } } },
      include: { payment: true },
      orderBy: { id: 'asc' },
    });
  });

  it('renders the printer view, asks OpenAI for the composite and saves a fresh image (force=true)', async () => {
    await putAIImage('PL7', 1000); // force must bypass this
    await fsp.mkdir(path.join(ASSETS_DIR, 'images'), { recursive: true });
    await fsp.writeFile(
      path.join(ASSETS_DIR, 'images', 'product_base.png'),
      'png-bytes'
    );
    h.prisma.playlist.findUnique.mockResolvedValue(makePlaylist());
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      payment: { paymentId: 'pay-1', qrSubDir: 'sub1' },
    });

    const url = await merchantCenter.generateAIProductImage('PL7', {
      force: true,
    });

    expect(url).toMatch(
      /^https:\/\/api\.qrsong\.io\/public\/products\/merchant_ai_PL7_\d+\.jpg$/
    );
    expect(url).not.toBe(AI_IMAGE_URL);
    expect(h.pdfRenderUrlToPdfBuffer).toHaveBeenCalledWith(
      'https://api.qrsong.io/qr/pdf/PL7/pay-1/printer/0/0/sub1/0/0/0',
      {
        width: 60,
        height: 60,
        marginTop: 0,
        marginRight: 0,
        marginBottom: 0,
        marginLeft: 0,
        pageRanges: '1-2',
      }
    );
    expect(h.openaiImagesEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-image-2',
        n: 1,
        size: '1024x1024',
        quality: 'high',
      })
    );
    expect(h.prisma.playlist.updateMany).toHaveBeenCalledWith({
      where: { playlistId: 'PL7' },
      data: { markedForMerchantCenter: true },
    });
  });

  it('returns null when OpenAI sends back no image data', async () => {
    await fsp.mkdir(path.join(ASSETS_DIR, 'images'), { recursive: true });
    await fsp.writeFile(
      path.join(ASSETS_DIR, 'images', 'product_base.png'),
      'png-bytes'
    );
    h.prisma.playlist.findUnique.mockResolvedValue(makePlaylist());
    h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue({
      payment: { paymentId: 'pay-1', qrSubDir: 'sub1' },
    });
    h.openaiImagesEdit.mockResolvedValue({ data: [] });

    expect(await merchantCenter.generateAIProductImage('PL7')).toBeNull();
    expect(h.prisma.playlist.updateMany).not.toHaveBeenCalled();
  });
});

describe('generateAllFeaturedAIProductImages', () => {
  it('tallies generated / skipped / failed across the featured playlists', async () => {
    h.prisma.playlist.findMany.mockResolvedValue([
      { id: 1, playlistId: 'A', name: 'A' },
      { id: 2, playlistId: 'B', name: 'B' },
      { id: 3, playlistId: 'C', name: 'C' },
    ]);
    const spy = vi
      .spyOn(merchantCenter, 'generateAIProductImage')
      .mockResolvedValueOnce('https://api.qrsong.io/x.jpg')
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('boom'));
    try {
      const result = await merchantCenter.generateAllFeaturedAIProductImages();
      expect(result).toEqual({
        total: 3,
        generated: 1,
        skipped: 1,
        failed: 1,
      });
      expect(h.prisma.playlist.findMany).toHaveBeenCalledWith({
        where: { featured: true, slug: { not: '' }, promotionalActive: true },
        select: { id: true, playlistId: true, name: true },
        orderBy: { score: 'desc' },
      });
      expect(spy).toHaveBeenCalledTimes(3);
      expect(spy).toHaveBeenCalledWith('A');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('markPlaylistForMerchantCenter', () => {
  it('swallows database errors instead of breaking image generation', async () => {
    h.prisma.playlist.updateMany.mockRejectedValue(new Error('locked'));
    await expect(
      svc.markPlaylistForMerchantCenter('PL7')
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// syncAllFeaturedPlaylists
// ---------------------------------------------------------------------------
describe('syncAllFeaturedPlaylists', () => {
  it('uploads every featured playlist (no markedForMerchantCenter filter)', async () => {
    const p1 = makePlaylist({ id: 1 });
    const p2 = makePlaylist({ id: 2 });
    h.prisma.playlist.findMany.mockResolvedValue([p1, p2]);
    const spy = vi
      .spyOn(svc, 'uploadPlaylist')
      .mockResolvedValue([] as any);
    try {
      await merchantCenter.syncAllFeaturedPlaylists();
      expect(h.prisma.playlist.findMany).toHaveBeenCalledWith({
        where: { featured: true, slug: { not: '' } },
        include: { genre: true },
      });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledWith(p1);
      expect(spy).toHaveBeenCalledWith(p2);
    } finally {
      spy.mockRestore();
    }
  });

  it('rethrows query failures', async () => {
    h.prisma.playlist.findMany.mockRejectedValue(new Error('db down'));
    await expect(merchantCenter.syncAllFeaturedPlaylists()).rejects.toThrow(
      'db down'
    );
  });
});
