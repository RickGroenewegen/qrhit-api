/**
 * Unit tests for src/printers/printenbind.ts (the REAL module — the global
 * recording mock from test/setup.ts is removed via vi.unmock below).
 *
 * Collaborators are mocked at the module boundary:
 *  - ../../../src/prisma   → in-memory prisma stub (no DB)
 *  - ../../../src/cache    → get/set stub (no Redis)
 *  - ../../../src/data     → getTaxRate / resolveTaxContext / euCountryCodes
 *  - ../../../src/discount → calculateVolumeDiscount stub
 *  - ../../../src/shipping → createShipment stub
 *  - ../../../src/pdf      → countPDFPages / mergeLocalPdfs stubs
 *  - ../../../src/spotify, src/utils, src/logger, src/game, cron → inert stubs
 * Mail stays on the global recording proxy (asserted via `outbound`).
 * Print&Bind HTTP calls go through globalThis.fetch which is replaced with a
 * per-test routing mock (the setup.ts fetch guard is restored afterwards).
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from 'vitest';
import fs from 'fs';
import path from 'path';
import { outbound } from '../../helpers/recording-mock';

vi.unmock('../../../src/printers/printenbind');

// ---------------------------------------------------------------------------
// Module-boundary mocks (hoisted)
// ---------------------------------------------------------------------------
const prismaMock = vi.hoisted(() => ({
  orderType: { findFirst: vi.fn(), findMany: vi.fn() },
  shippingCostNew: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  payment: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  paymentHasPlaylist: { findUnique: vi.fn(), findMany: vi.fn() },
  paymentHasPlaylistItem: { findMany: vi.fn() },
}));
vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

const cacheMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  rateLimit: vi.fn(),
  executeCommand: vi.fn(),
}));
vi.mock('../../../src/cache', () => ({
  default: { getInstance: () => cacheMock },
}));

const dataMock = vi.hoisted(() => ({
  getTaxRate: vi.fn(),
  resolveTaxContext: vi.fn(),
  euCountryCodes: ['NL', 'BE', 'DE', 'FR', 'ES', 'IT', 'SE'],
}));
vi.mock('../../../src/data', () => ({
  default: { getInstance: () => dataMock },
}));

const discountMock = vi.hoisted(() => ({
  calculateVolumeDiscount: vi.fn(),
}));
vi.mock('../../../src/discount', () => ({
  default: class {
    calculateVolumeDiscount = discountMock.calculateVolumeDiscount;
  },
}));

const shippingMock = vi.hoisted(() => ({
  createShipment: vi.fn(async () => undefined),
}));
vi.mock('../../../src/shipping', () => ({
  default: { getInstance: () => shippingMock },
}));

const pdfMock = vi.hoisted(() => ({
  countPDFPages: vi.fn(async () => 2),
  mergeLocalPdfs: vi.fn(async () => 4),
  generateFromUrl: vi.fn(async () => undefined),
  resizePDFPages: vi.fn(async () => undefined),
}));
vi.mock('../../../src/pdf', () => ({
  default: class {
    countPDFPages = pdfMock.countPDFPages;
    mergeLocalPdfs = pdfMock.mergeLocalPdfs;
    generateFromUrl = pdfMock.generateFromUrl;
    resizePDFPages = pdfMock.resizePDFPages;
  },
}));

vi.mock('../../../src/spotify', () => ({
  default: { getInstance: () => ({}) },
}));

vi.mock('../../../src/utils', () => ({
  default: class {
    isMainServer = async () => false;
  },
}));

// Keep test output clean — Log only console.logs.
vi.mock('../../../src/logger', () => ({
  default: class {
    init = async () => {};
    log(_m: string) {}
    logDev(_m: string) {}
  },
}));

vi.mock('../../../src/game', () => ({
  QRGAMES_UPGRADE_PRICE: 5.0,
}));

vi.mock('cron', () => ({
  CronJob: class {
    constructor(..._args: any[]) {}
    start() {}
  },
}));

import PrintEnBind from '../../../src/printers/printenbind';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------
const PB = 'https://printenbind.test/api';
const API_KEY = 'test-pb-key';
const savedFetch = globalThis.fetch;
const fetchMock = vi.fn();

let peb: PrintEnBind;

function jsonResponse(
  body: any,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

/** Route fetch calls by (method, exact url). Unknown requests throw. */
function routeFetch(
  routes: Array<{ method: string; url: string; response: () => Response }>
) {
  fetchMock.mockImplementation(async (url: any, init: any = {}) => {
    const method = (init?.method || 'GET').toUpperCase();
    for (const r of routes) {
      if (r.url === String(url) && r.method === method) return r.response();
    }
    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  });
}

/** Return [url, init] pairs sent to fetch matching method + url substring. */
function sentRequests(method: string, urlPart: string): any[][] {
  return fetchMock.mock.calls.filter(
    ([u, i]: any[]) =>
      ((i?.method || 'GET') as string).toUpperCase() === method &&
      String(u).includes(urlPart)
  );
}

function body(call: any[]): any {
  return JSON.parse(call[1].body);
}

beforeAll(() => {
  process.env['PRINTENBIND_API_URL'] = PB;
  process.env['PRINTENBIND_API_KEY'] = API_KEY;
  peb = PrintEnBind.getInstance();
});

beforeEach(() => {
  vi.clearAllMocks();
  outbound.reset();
  cacheMock.get.mockResolvedValue(null);
  cacheMock.set.mockResolvedValue(undefined);
  dataMock.getTaxRate.mockResolvedValue(21);
  dataMock.resolveTaxContext.mockResolvedValue({
    taxRate: 21,
    reverseCharge: false,
    vatIdChecked: null,
    vatIdStatus: 'skipped',
  });
  discountMock.calculateVolumeDiscount.mockResolvedValue(0);
  prismaMock.shippingCostNew.findFirst.mockResolvedValue({ cost: 5.95 });
  fetchMock.mockImplementation(async (url: any, init: any = {}) => {
    throw new Error(
      `Unexpected fetch in test: ${init?.method || 'GET'} ${url}`
    );
  });
  globalThis.fetch = fetchMock as any;
});

afterAll(() => {
  globalThis.fetch = savedFetch;
});

// ---------------------------------------------------------------------------
// calculateCardPrice — digital per-card price with linear volume discount
// ---------------------------------------------------------------------------
describe('calculateCardPrice', () => {
  it('charges the flat base per-card price at exactly 500 cards (no discount)', async () => {
    expect(await peb.calculateCardPrice(13, 500)).toEqual({
      totalPrice: 13,
      pricePerCard: 0.026,
      discountPercentage: 0,
    });
  });

  it('floors the total at the base price for small quantities', async () => {
    // 400 × 0.026 = 10.4 → ceil 11, but never below basePrice (13)
    expect(await peb.calculateCardPrice(13, 400)).toEqual({
      totalPrice: 13,
      pricePerCard: 0.026,
      discountPercentage: 0,
    });
  });

  it('interpolates the discount linearly between 500 and 2500 cards', async () => {
    // 1500 cards → (1500-500) × (0.5/2000) = 25% off → 0.0195/card → 29.25 → ceil 30
    expect(await peb.calculateCardPrice(13, 1500)).toEqual({
      totalPrice: 30,
      pricePerCard: 0.0195,
      discountPercentage: 25,
    });
  });

  it('caps the discount at 50% from 2500 cards', async () => {
    // 2500 × 0.013 = 32.5 → ceil 33
    expect(await peb.calculateCardPrice(13, 2500)).toEqual({
      totalPrice: 33,
      pricePerCard: 0.013,
      discountPercentage: 50,
    });
    // 3000 stays at the 50% cap: 3000 × 0.013 = 39
    expect((await peb.calculateCardPrice(13, 3000)).totalPrice).toBe(39);
  });

  it('rounds the total up to a whole euro', async () => {
    // 1000 cards → 12.5% discount → 0.02275/card → 22.75 → ceil 23
    expect(await peb.calculateCardPrice(13, 1000)).toEqual({
      totalPrice: 23,
      pricePerCard: 0.0227, // 0.02275 truncates to 0.0227 via toFixed(4) float repr
      discountPercentage: 12.5,
    });
  });

  it('starts discounting only above 500 cards', async () => {
    // 501 cards costs MORE than 500 (14 vs 13) because the discount at 501
    // is negligible while ceil() rounds 13.02 up. Documents actual behavior.
    const r = await peb.calculateCardPrice(13, 501);
    expect(r.totalPrice).toBe(14);
    expect(r.discountPercentage).toBe(0.03);
  });
});

// ---------------------------------------------------------------------------
// getRawCardCostEur
// ---------------------------------------------------------------------------
describe('getRawCardCostEur', () => {
  it('returns raw print cost: 2× color (0.018) + paper (0.034) = 0.07', () => {
    expect(peb.getRawCardCostEur()).toBe(0.07);
  });
});

// ---------------------------------------------------------------------------
// calculateSingleItem — sticker price incl. NL VAT and margin model
// ---------------------------------------------------------------------------
describe('calculateSingleItem', () => {
  it('prices 100 physical cards: cost 8.80, +€12 min profit, +21% VAT, ceil → 26', async () => {
    const r = await peb.calculateSingleItem(
      { productType: 'cards', type: 'physical', subType: 'none', quantity: 100, alternatives: {} },
      false
    );
    // (100 × 0.07 + 1.8) = 8.8 → margin 1.5 gives only 4.4 profit < 12
    // → 8.8 + 12 = 20.8 → × 1.21 = 25.168 → ceil 26
    expect(r).toEqual({ price: 26, alternatives: {} });
    expect(dataMock.getTaxRate).toHaveBeenCalledWith('NL');
  });

  it('applies the 50-card minimum to small physical quantities', async () => {
    // quantity 10 → billed as 50: (50 × 0.07 + 1.8) = 5.3 → +12 → 17.3 → ×1.21 → ceil 21
    const r = await peb.calculateSingleItem(
      { productType: 'cards', type: 'physical', subType: 'none', quantity: 10, alternatives: {} },
      false
    );
    expect(r.price).toBe(21);
  });

  it('uses the 50% margin once it beats the €12 minimum profit', async () => {
    // 500 × 0.07 + 1.8 = 36.8 → ×1.5 = 55.2 (profit 18.4 ≥ 12) → ×1.21 = 66.792 → 67
    const r = await peb.calculateSingleItem(
      { productType: 'cards', type: 'physical', subType: 'none', quantity: 500, alternatives: {} },
      false
    );
    expect(r.price).toBe(67);
  });

  it('prices A4 sheets at 12 cards per sheet', async () => {
    // ceil(100/12)=9 sheets × 0.284 + 1.8 = 4.36 → +12 → 16.36 → ×1.21 = 19.7956 → 20
    const r = await peb.calculateSingleItem(
      { productType: 'cards', type: 'physical', subType: 'sheets', quantity: 100, alternatives: {} },
      false
    );
    expect(r.price).toBe(20);
  });

  it('prices digital cards via calculateCardPrice (no margin/VAT applied)', async () => {
    const r100 = await peb.calculateSingleItem(
      { productType: 'cards', type: 'digital', subType: 'none', quantity: 100, alternatives: {} },
      false
    );
    expect(r100.price).toBe(13); // base price floor
    const r1000 = await peb.calculateSingleItem(
      { productType: 'cards', type: 'digital', subType: 'none', quantity: 1000, alternatives: {} },
      false
    );
    expect(r1000.price).toBe(23);
  });

  it('computes alternatives as deltas relative to the requested type', async () => {
    const r = await peb.calculateSingleItem({
      productType: 'cards',
      type: 'physical',
      subType: 'none',
      quantity: 100,
      alternatives: {},
    });
    expect(r.price).toBe(26);
    expect(r.alternatives).toEqual({
      type: { physical: 0, digital: -13, sheets: -6 },
    });
  });

  it('computes alternatives for a digital item', async () => {
    const r = await peb.calculateSingleItem({
      productType: 'cards',
      type: 'digital',
      subType: 'none',
      quantity: 100,
      alternatives: {},
    });
    expect(r.price).toBe(13);
    expect(r.alternatives).toEqual({
      type: { physical: 13, digital: 0, sheets: 7 },
    });
  });
});

// ---------------------------------------------------------------------------
// getShippingCosts — track-count tier mapping + cache
// ---------------------------------------------------------------------------
describe('getShippingCosts', () => {
  it('maps track counts to size tiers 80 / 405 / 1000', async () => {
    await peb.getShippingCosts('NL', 50);
    expect(prismaMock.shippingCostNew.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { country: 'NL', size: 80 } })
    );
    await peb.getShippingCosts('NL', 100);
    expect(prismaMock.shippingCostNew.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { country: 'NL', size: 405 } })
    );
    await peb.getShippingCosts('NL', 406);
    expect(prismaMock.shippingCostNew.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { country: 'NL', size: 1000 } })
    );
    await peb.getShippingCosts('NL', 1500);
    expect(prismaMock.shippingCostNew.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { country: 'NL', size: 1000 } })
    );
  });

  it('always uses the smallest tier (80) for sheets', async () => {
    await peb.getShippingCosts('DE', 900, 'sheets');
    expect(prismaMock.shippingCostNew.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { country: 'DE', size: 80 } })
    );
  });

  it('returns the DB cost and caches it for 1 day', async () => {
    const r = await peb.getShippingCosts('NL', 100);
    expect(r).toEqual({ cost: 5.95 });
    expect(cacheMock.set).toHaveBeenCalledWith(
      'shipping_costs_NL_405',
      JSON.stringify({ cost: 5.95 }),
      86400
    );
  });

  it('serves from cache without touching the database', async () => {
    cacheMock.get.mockResolvedValue(JSON.stringify({ cost: 4.5 }));
    const r = await peb.getShippingCosts('BE', 100);
    expect(r).toEqual({ cost: 4.5 });
    expect(prismaMock.shippingCostNew.findFirst).not.toHaveBeenCalled();
  });

  it('returns null when no shipping cost record exists', async () => {
    prismaMock.shippingCostNew.findFirst.mockResolvedValue(null);
    expect(await peb.getShippingCosts('XX', 100)).toBeNull();
    expect(cacheMock.set).not.toHaveBeenCalled();
  });

  it('returns null on database errors', async () => {
    prismaMock.shippingCostNew.findFirst.mockRejectedValue(new Error('boom'));
    expect(await peb.getShippingCosts('NL', 100)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getOrderTypes / getOrderType
// ---------------------------------------------------------------------------
describe('getOrderTypes', () => {
  it('queries visible order types of the requested type and caches them', async () => {
    const rows = [{ id: 1, name: 'Digital', maxCards: 3000, amountWithMargin: 13 }];
    prismaMock.orderType.findMany.mockResolvedValue(rows);
    const r = await peb.getOrderTypes('cards');
    expect(r).toEqual(rows);
    expect(prismaMock.orderType.findMany).toHaveBeenCalledWith({
      select: { id: true, name: true, maxCards: true, amountWithMargin: true },
      where: { visible: true, type: 'cards' },
      orderBy: [{ digital: 'desc' }, { maxCards: 'asc' }],
    });
    expect(cacheMock.set).toHaveBeenCalledWith(
      'orderTypes_cards',
      JSON.stringify(rows)
    );
  });

  it('serves order types from cache', async () => {
    cacheMock.get.mockResolvedValue(JSON.stringify([{ id: 7 }]));
    expect(await peb.getOrderTypes('giftcard')).toEqual([{ id: 7 }]);
    expect(prismaMock.orderType.findMany).not.toHaveBeenCalled();
  });
});

describe('getOrderType', () => {
  it('looks up the smallest physical tier covering the track count and computes the price', async () => {
    prismaMock.orderType.findFirst.mockResolvedValue({
      id: 2,
      maxCards: 500,
      amountWithMargin: 26,
    });
    const r = await peb.getOrderType(100, false, 'cards', 'pl1');
    expect(prismaMock.orderType.findFirst).toHaveBeenCalledWith({
      where: { type: 'cards', maxCards: { gte: 100 }, digital: false },
      orderBy: [{ maxCards: 'asc' }],
    });
    // amount comes from calculateSingleItem(physical, 100) = 26
    expect(r.amount).toBe(26);
    expect(r.alternatives).toEqual({
      type: { physical: 0, digital: -13, sheets: -6 },
    });
    expect(cacheMock.set).toHaveBeenCalledWith(
      'orderType_100_0_cards',
      expect.any(String)
    );
  });

  it('uses a track-count-independent cache key for the digital product', async () => {
    prismaMock.orderType.findFirst.mockResolvedValue({
      id: 1,
      maxCards: 3000,
      amountWithMargin: 13,
    });
    const r = await peb.getOrderType(100, true, 'cards', 'pl1');
    expect(prismaMock.orderType.findFirst).toHaveBeenCalledWith({
      where: { type: 'cards', digital: true },
      orderBy: [{ maxCards: 'asc' }],
    });
    expect(r.amount).toBe(13);
    expect(cacheMock.set).toHaveBeenCalledWith(
      'orderType_1_cards',
      expect.any(String)
    );
  });

  it('clamps digital track counts to MAX_CARDS (3000) for the price calculation', async () => {
    prismaMock.orderType.findFirst.mockResolvedValue({
      id: 1,
      maxCards: 3000,
      amountWithMargin: 13,
    });
    const r = await peb.getOrderType(5000, true, 'cards', 'pl1');
    // calculateCardPrice(13, 3000) at the 50% cap → 39
    expect(r.amount).toBe(39);
  });

  it('serves the order type from cache but still recomputes the amount', async () => {
    cacheMock.get.mockResolvedValue(
      JSON.stringify({ id: 2, maxCards: 500, amountWithMargin: 26 })
    );
    const r = await peb.getOrderType(100, false, 'cards', 'pl1');
    expect(prismaMock.orderType.findFirst).not.toHaveBeenCalled();
    expect(r.amount).toBe(26);
  });

  it('does not attach a computed amount for non-cards product types', async () => {
    prismaMock.orderType.findFirst.mockResolvedValue({ id: 5, maxCards: 1 });
    const r = await peb.getOrderType(1, true, 'giftcard', 'pl1');
    expect(r).toEqual({ id: 5, maxCards: 1 });
  });
});

// ---------------------------------------------------------------------------
// calculateOrder — checkout totals
// ---------------------------------------------------------------------------
describe('calculateOrder', () => {
  function cardsItem(overrides: Record<string, any> = {}): any {
    return {
      productType: 'cards',
      type: 'physical',
      numberOfTracks: 100,
      amount: 1,
      price: 49,
      ...overrides,
    };
  }

  it('computes the full breakdown for one physical NL order', async () => {
    const r = await peb.calculateOrder({
      countrycode: 'NL',
      cart: { items: [cardsItem()] },
    });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      orderId: '',
      total: 49 + 2.99, // 51.99: product + flat NL shipping
      shipping: 2.99,
      handling: 0,
      taxRateShipping: 21,
      taxRate: 21,
      price: 40.5, // 49 / 1.21 rounded to 2 decimals
      payment: 2.99,
      volumeDiscount: 0,
      gamesFee: 0,
      qrgamesUnitPrice: 5,
      boxFee: 0,
      boxUnitPrice: 6.99,
      totalBoxCount: 0,
      reverseCharge: false,
      vatIdChecked: null,
      vatIdStatus: 'skipped',
    });
    expect(dataMock.resolveTaxContext).toHaveBeenCalledWith({
      buyerCountry: 'NL',
      isBusinessOrder: false,
      vatId: null,
    });
  });

  it('defaults to NL but excludes shipping from the total until a country is selected', async () => {
    const r = await peb.calculateOrder({ cart: { items: [cardsItem()] } });
    expect(r.data.total).toBe(49); // shipping computed but not added
    expect(r.data.shipping).toBe(2.99);
    expect(r.data.payment).toBe(2.99);
  });

  it('gives free shipping to NL/DE/BE from 2 playlists', async () => {
    const r = await peb.calculateOrder({
      countrycode: 'NL',
      cart: { items: [cardsItem({ amount: 2 })] },
    });
    expect(r.data.shipping).toBe(0);
    expect(r.data.total).toBe(98);
  });

  it('uses the database shipping cost for other countries (DE, 1 playlist)', async () => {
    const r = await peb.calculateOrder({
      countrycode: 'DE',
      cart: { items: [cardsItem()] },
    });
    expect(r.data.shipping).toBe(5.95);
    expect(r.data.total).toBe(49 + 5.95);
  });

  it('overrides shipping to €3.90 for ES/NO/SE', async () => {
    const r = await peb.calculateOrder({
      countrycode: 'ES',
      cart: { items: [cardsItem()] },
    });
    expect(r.data.shipping).toBe(3.9);
    expect(r.data.total).toBeCloseTo(49 + 3.9, 10);
  });

  it('adds 20% for fast track before shipping is added', async () => {
    const r = await peb.calculateOrder({
      countrycode: 'NL',
      fast: true,
      cart: { items: [cardsItem()] },
    });
    expect(r.data.total).toBe(49 * 1.2 + 2.99); // 61.79
    expect(r.data.price).toBe(40.5 * 1.2); // 48.6 ex-VAT product price
  });

  it('subtracts the volume discount from the total', async () => {
    discountMock.calculateVolumeDiscount.mockResolvedValue(10);
    const r = await peb.calculateOrder({
      countrycode: 'NL',
      cart: { items: [cardsItem()] },
    });
    expect(r.data.volumeDiscount).toBe(10);
    expect(r.data.total).toBe(49 + 2.99 - 10);
  });

  it('charges the QRGames fee once per cart item, ignoring item amount', async () => {
    // SUSPECTED BUG: a cards item with amount=2 (two copies) and games
    // enabled is charged the €5 games fee only once — the loop adds
    // GAMES_FEE per item, not per item.amount. Documented actual behavior.
    const r = await peb.calculateOrder({
      countrycode: 'NL',
      cart: { items: [cardsItem({ amount: 2, gamesEnabled: true })] },
    });
    expect(r.data.gamesFee).toBe(5);
    expect(r.data.total).toBe(98 + 5); // free shipping (2 playlists)
  });

  it('prices boxes with the per-item quantity tier (3 boxes → €5.00 each)', async () => {
    const r = await peb.calculateOrder({
      countrycode: 'NL',
      cart: { items: [cardsItem({ boxEnabled: true, boxQuantity: 3 })] },
    });
    expect(r.data.totalBoxCount).toBe(3);
    expect(r.data.boxFee).toBe(15); // 3 × 5.00
    expect(r.data.boxUnitPrice).toBe(6.99);
    expect(r.data.total).toBeCloseTo(49 + 2.99 + 15, 10);
  });

  it('computes the box tier per cart item from boxQuantity × playlist amount', async () => {
    const r = await peb.calculateOrder({
      countrycode: 'NL',
      cart: {
        items: [
          cardsItem({ boxEnabled: true, boxQuantity: 1 }), // 1 box → 6.99
          cardsItem({ price: 30, boxEnabled: true, boxQuantity: 5 }), // 5 boxes → 5×4.00
        ],
      },
    });
    expect(r.data.totalBoxCount).toBe(6);
    expect(r.data.boxFee).toBeCloseTo(26.99, 10);
    // 2 playlists → free NL shipping; 49 + 30 + 26.99
    expect(r.data.shipping).toBe(0);
    expect(r.data.total).toBeCloseTo(105.99, 10);
  });

  it('zeroes the total when physical items have no shipping data for the country', async () => {
    prismaMock.shippingCostNew.findFirst.mockResolvedValue(null);
    const r = await peb.calculateOrder({
      countrycode: 'US',
      cart: { items: [cardsItem()] },
    });
    expect(r.data.total).toBe(0);
    expect(r.data.shipping).toBe(0);
  });

  it('skips shipping entirely for digital-only carts (giftcard)', async () => {
    const r = await peb.calculateOrder({
      countrycode: 'NL',
      cart: {
        items: [
          { productType: 'giftcard', type: 'digital', amount: 1, price: 25 },
        ],
      },
    });
    expect(r.data.shipping).toBe(0);
    expect(r.data.total).toBe(25);
    expect(r.data.price).toBe(20.66); // 25 / 1.21
  });

  it('requests sheet-tier shipping when every item is a sheets item', async () => {
    const r = await peb.calculateOrder({
      countrycode: 'NL',
      cart: {
        items: [cardsItem({ type: 'sheets', numberOfTracks: 500, price: 20 })],
      },
    });
    // 500 tracks would normally hit tier 1000; sheets forces tier 80
    expect(prismaMock.shippingCostNew.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { country: 'NL', size: 80 } })
    );
    expect(r.data.shipping).toBe(2.99);
    expect(r.data.total).toBeCloseTo(22.99, 10);
    expect(r.data.price).toBe(16.53);
  });

  it('returns success:false when a collaborator throws', async () => {
    discountMock.calculateVolumeDiscount.mockRejectedValue(new Error('redis down'));
    const r = await peb.calculateOrder({
      countrycode: 'NL',
      cart: { items: [cardsItem()] },
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('Error calculating order');
  });
});

// ---------------------------------------------------------------------------
// createOrderItem — Print&Bind article payload for game cards
// ---------------------------------------------------------------------------
describe('createOrderItem', () => {
  const baseItem = () => ({
    type: 'physical',
    amount: 2,
    paymentHasPlaylistId: 55,
  });

  it('builds the full losbladig 60×60 article payload', async () => {
    const item = await (peb as any).createOrderItem(
      100,
      'https://api.qrsong.io/public/pdf/file.pdf',
      baseItem(),
      null
    );
    expect(item).toEqual({
      type: 'physical',
      amount: 2, // playlistItem null → keeps original amount
      product: 'losbladig',
      number: '1',
      copies: '200', // 100 tracks × 2 sides
      color: 'all',
      size: 'custom',
      printside: 'double',
      finishing: 'loose',
      finishing2: 'none',
      finishing_extra: 'none',
      accessory_item: 'none',
      papertype: 'card',
      size_custom_width: '60',
      size_custom_height: '60',
      check_doc: 'standard',
      delivery_method: 'post',
      add_file_method: 'url',
      file_overwrite: true,
      file_url: 'https://api.qrsong.io/public/pdf/file.pdf',
      comment:
        'Batch nummer op de kaartjes (rechts onderin op kant met titel/artiest/jaar) moet #55 zijn',
    });
  });

  it('adds 2 pages for the how-to card and caps copies at 2000', async () => {
    const withHowTo = await (peb as any).createOrderItem(
      100,
      'u',
      { ...baseItem(), addHowToCard: true },
      null
    );
    expect(withHowTo.copies).toBe('202');

    const capped = await (peb as any).createOrderItem(1500, 'u', baseItem(), null);
    expect(capped.copies).toBe('2000'); // 3000 pages capped
  });

  it('uses amount 1 and an indexed batch number per playlist item', async () => {
    const item = await (peb as any).createOrderItem(100, 'u', baseItem(), {
      index: 3,
    });
    expect(item.amount).toBe(1);
    expect(item.comment).toContain('#55-3');
  });

  it('switches to A4 sheets: 12 cards per sheet, double-sided', async () => {
    const item = await (peb as any).createOrderItem(
      100,
      'u',
      { ...baseItem(), subType: 'sheets' },
      null
    );
    expect(item.copies).toBe('18'); // ceil(100/12)=9 sheets × 2 sides
    expect(item.size).toBe('a4');
    expect(item.size_custom_width).toBeUndefined();
    expect(item.size_custom_height).toBeUndefined();
    expect(item.comment).toContain('door de klant zelf uitgeknipt');
  });

  it('attaches the box packaging accessory when boxEnabled', async () => {
    const item = await (peb as any).createOrderItem(
      100,
      'u',
      { ...baseItem(), boxEnabled: true },
      null
    );
    expect(item.accessory_group).toBe('packaging');
    expect(item.accessory_item).toBe('box_qrsong');
  });

  it('returns digital items unchanged', async () => {
    const digital = { type: 'digital', amount: 1, productType: 'cards' };
    expect(await (peb as any).createOrderItem(100, '', digital, null)).toBe(
      digital
    );
  });
});

// ---------------------------------------------------------------------------
// describeArticle / box article builders
// ---------------------------------------------------------------------------
describe('describeArticle', () => {
  it('labels game card articles with their batch number', () => {
    expect(
      (peb as any).describeArticle({
        type: 'physical',
        product: 'losbladig',
        comment: 'Batch nummer ... moet #55-2 zijn',
      })
    ).toBe('game cards (Batch #55-2)');
  });

  it('labels werkblad articles without packaging as insert cards', () => {
    expect(
      (peb as any).describeArticle({
        type: 'physical',
        product: 'werkblad',
        copies: '8',
      })
    ).toBe('insert cards (8 pages)');
  });

  it('falls back to the raw type for non-physical articles', () => {
    expect((peb as any).describeArticle({ type: 'digital' })).toBe(
      'article (digital)'
    );
  });
});

describe('box order article builders', () => {
  it('createBoxOrderCardItem builds a 120×120 werkblad article with packaging accessory', () => {
    const item = (peb as any).createBoxOrderCardItem(
      'https://x/box.pdf',
      { name: 'Hits' },
      6
    );
    expect(item).toEqual({
      type: 'physical',
      amount: 1,
      product: 'werkblad',
      number: '1',
      copies: '6',
      color: 'all',
      size: 'custom',
      printside: 'double',
      finishing: 'loose',
      finishing2: 'none',
      finishing_extra: 'none',
      papertype: 'card',
      size_custom_width: '120',
      size_custom_height: '120',
      check_doc: 'standard',
      delivery_method: 'post',
      add_file_method: 'url',
      file_overwrite: true,
      file_url: 'https://x/box.pdf',
      accessory_group: 'packaging',
      accessory_item: 'box_qrsong',
      comment: 'Box insert for playlist Hits',
    });
  });

  it('createBoxOrderInsertItem builds the same article without the accessory', () => {
    const item = (peb as any).createBoxOrderInsertItem('https://x/i.pdf', 4, 'c');
    expect(item.accessory_group).toBeUndefined();
    expect(item.accessory_item).toBe('none');
    expect(item.copies).toBe('4');
    expect(item.size_custom_width).toBe('120');
    expect(item.comment).toBe('c');
  });
});

// ---------------------------------------------------------------------------
// processOrderRequest — Print&Bind order creation request shapes + price math
// ---------------------------------------------------------------------------
describe('processOrderRequest', () => {
  const customerNL = {
    fullname: 'Jane Buyer',
    email: 'jane@example.com',
    address: 'Mainstreet',
    housenumber: '12',
    zipcode: '1234AB',
    city: 'Amsterdam',
    countrycode: 'NL',
  };

  function physicalItem(): any {
    return {
      type: 'physical',
      amount: 1,
      product: 'losbladig',
      number: '1',
      copies: '200',
      color: 'all',
      size: 'custom',
      printside: 'double',
      finishing: 'loose',
      finishing2: 'none',
      finishing_extra: 'none',
      accessory_item: 'none',
      papertype: 'card',
      size_custom_width: '60',
      size_custom_height: '60',
      check_doc: 'standard',
      delivery_method: 'post',
      add_file_method: 'url',
      file_overwrite: true,
      file_url: 'https://api.qrsong.io/public/pdf/file.pdf',
      comment: 'Batch nummer ... moet #55 zijn',
    };
  }

  function happyRoutes(orderId = '7989-1') {
    routeFetch([
      {
        method: 'POST',
        url: `${PB}/v1/orders/articles`,
        response: () =>
          jsonResponse({}, { headers: { location: `orders/${orderId}` } }),
      },
      {
        method: 'POST',
        url: `${PB}/v1/delivery/${orderId}`,
        response: () => jsonResponse({}),
      },
      {
        method: 'GET',
        url: `${PB}/v1/orders/${orderId}`,
        response: () =>
          jsonResponse({ amount: '20.00', price_startup: '2.25' }),
      },
      {
        method: 'GET',
        url: `${PB}/v1/delivery/${orderId}`,
        response: () => jsonResponse({ amount: '5.95' }),
      },
    ]);
    prismaMock.orderType.findFirst.mockResolvedValue({
      id: 2,
      maxCards: 500,
      amountWithMargin: 26,
    });
  }

  it('creates the order, sets delivery, and returns VAT-adjusted totals (NL)', async () => {
    happyRoutes();
    const result = await (peb as any).processOrderRequest(
      [physicalItem()],
      customerNL,
      true
    );

    // --- article request shape ---
    const [articleCall] = sentRequests('POST', '/v1/orders/articles');
    expect(articleCall[1].headers).toEqual({
      Authorization: API_KEY,
      'Content-Type': 'application/json',
    });
    const articleBody = body(articleCall);
    expect(articleBody).toEqual({
      ...(() => {
        const { type: _t, ...rest } = physicalItem();
        return rest;
      })(),
      payment_method: 'bundled', // NL is EU → bundled payment
    });
    expect(articleBody.type).toBeUndefined();

    // --- delivery request shape ---
    const [deliveryCall] = sentRequests('POST', '/v1/delivery/7989-1');
    expect(body(deliveryCall)).toEqual({
      name_contact: 'Jane Buyer',
      street: 'Mainstreet',
      city: 'Amsterdam',
      streetnumber: '12',
      zipcode: '1234AB',
      country: 'NL',
      delivery_method: 'post', // NL ships via post
      blanco: '1',
      email: 'jane@example.com',
    });

    // --- price math (taxModifier 1.21) ---
    // product ex VAT: 26 / 1.21 = 21.49
    // total  = (21.49 + 5.95 + 2.25) × 1.21 = 35.92
    // shipping = 5.95 × 1.21 = 7.20 · handling = 2.25 × 1.21 = 2.72
    // price = 21.49 × 1.21 = 26.00 · payment = (5.95 + 2.25) × 1.21 = 9.92
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      orderId: '7989-1',
      total: 35.92,
      shipping: 7.2,
      handling: 2.72,
      taxRateShipping: 21,
      taxRate: 21,
      price: 26,
      payment: 9.92,
    });
    // Only the two POSTs are logged into apiCalls; the final GET order/
    // delivery detail calls are not recorded.
    expect(result.apiCalls).toHaveLength(2);
    expect(result.apiCalls.map((c: any) => [c.method, c.url])).toEqual([
      ['POST', `${PB}/v1/orders/articles`],
      ['POST', `${PB}/v1/delivery/7989-1`],
    ]);

    // Successful result is cached for an hour
    expect(cacheMock.set).toHaveBeenCalledWith(
      expect.stringMatching(/^order_request_[0-9a-f]{32}$/),
      JSON.stringify(result),
      3600
    );
  });

  it('uses account payment and international delivery for non-EU countries', async () => {
    dataMock.getTaxRate.mockImplementation(async (c: string) =>
      c === 'NL' ? 21 : 0
    );
    happyRoutes();
    const result = await (peb as any).processOrderRequest(
      [physicalItem()],
      { ...customerNL, countrycode: 'US' },
      false
    );

    const [articleCall] = sentRequests('POST', '/v1/orders/articles');
    expect(body(articleCall).payment_method).toBe('account');

    const [deliveryCall] = sentRequests('POST', '/v1/delivery/7989-1');
    expect(body(deliveryCall).delivery_method).toBe('international');
    expect(body(deliveryCall).country).toBe('US');

    // taxRate 0 → taxModifier 1, product ex VAT = 26.00
    expect(result.data).toEqual({
      orderId: '7989-1',
      total: 34.2, // 26 + 5.95 + 2.25
      shipping: 5.95,
      handling: 2.25,
      taxRateShipping: 0,
      taxRate: 0,
      price: 26,
      payment: 8.2,
    });
  });

  it('creates the order via POST /v1/orders first when an order comment is given', async () => {
    routeFetch([
      {
        method: 'POST',
        url: `${PB}/v1/orders`,
        response: () =>
          jsonResponse({}, { headers: { location: 'orders/123' } }),
      },
      {
        method: 'POST',
        url: `${PB}/v1/orders/123/articles`,
        response: () => jsonResponse({}),
      },
      {
        method: 'POST',
        url: `${PB}/v1/delivery/123`,
        response: () => jsonResponse({}),
      },
      {
        method: 'GET',
        url: `${PB}/v1/orders/123`,
        response: () => jsonResponse({ amount: '20.00', price_startup: '2.25' }),
      },
      {
        method: 'GET',
        url: `${PB}/v1/delivery/123`,
        response: () => jsonResponse({ amount: '5.95' }),
      },
    ]);
    prismaMock.orderType.findFirst.mockResolvedValue({
      id: 2,
      maxCards: 500,
      amountWithMargin: 26,
    });

    const result = await (peb as any).processOrderRequest(
      [physicalItem()],
      customerNL,
      true,
      true,
      false,
      'LET OP: Deze order moet verpakt worden met in totaal 2 QRSong! dozen'
    );

    const [orderCall] = sentRequests('POST', `${PB}/v1/orders`).filter(
      ([u]) => String(u) === `${PB}/v1/orders`
    );
    expect(body(orderCall)).toEqual({
      comment:
        'LET OP: Deze order moet verpakt worden met in totaal 2 QRSong! dozen',
    });
    // Article was appended to the pre-created order, not POST /orders/articles
    expect(sentRequests('POST', '/v1/orders/articles')).toHaveLength(0);
    expect(sentRequests('POST', '/v1/orders/123/articles')).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.data.orderId).toBe('123');
  });

  it('totals digital items from the order type margin without any HTTP calls', async () => {
    prismaMock.orderType.findFirst.mockResolvedValue({
      id: 1,
      maxCards: 3000,
      amountWithMargin: 15,
    });
    const result = await (peb as any).processOrderRequest(
      [
        {
          type: 'digital',
          productType: 'cards',
          numberOfTracks: 100,
          amount: 2,
          playlistId: 'pl1',
        },
      ],
      customerNL,
      false
    );
    expect(fetchMock).not.toHaveBeenCalled();
    // itemPrice = 15 × 2 = 30 · ex VAT = 30 / 1.21 = 24.79
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      orderId: null,
      total: 30,
      shipping: 0,
      handling: 0,
      taxRateShipping: 21,
      taxRate: 21,
      price: 24.79,
      payment: 0,
    });
  });

  it('uses the item price directly for digital giftcards', async () => {
    prismaMock.orderType.findFirst.mockResolvedValue({ id: 9, maxCards: 1 });
    const result = await (peb as any).processOrderRequest(
      [
        {
          type: 'digital',
          productType: 'giftcard',
          numberOfTracks: 0,
          amount: 1,
          price: 25,
          playlistId: null,
        },
      ],
      customerNL,
      false
    );
    expect(result.data.total).toBe(25);
    expect(result.data.price).toBe(20.66);
  });

  it('does not extract an order id from a rejected first article (400)', async () => {
    routeFetch([
      {
        method: 'POST',
        url: `${PB}/v1/orders/articles`,
        // A 400 still carries a location-style path; the guard must ignore it
        response: () =>
          jsonResponse(
            { location: '/orders/55/article', error: 'invalid' },
            { status: 400 }
          ),
      },
    ]);
    prismaMock.orderType.findFirst.mockResolvedValue({
      id: 2,
      maxCards: 500,
      amountWithMargin: 26,
    });
    const result = await (peb as any).processOrderRequest(
      [physicalItem()],
      customerNL,
      true
    );
    expect(result.success).toBe(false);
    expect(result.data).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1); // no delivery / detail calls
    // The failed result must not be cached (getOrderType caches its own key)
    expect(
      cacheMock.set.mock.calls.filter(([k]: any[]) =>
        String(k).startsWith('order_request_')
      )
    ).toHaveLength(0);
  });

  it('reports failure when a follow-up article is rejected', async () => {
    routeFetch([
      {
        method: 'POST',
        url: `${PB}/v1/orders/articles`,
        response: () =>
          jsonResponse({}, { headers: { location: 'orders/7989-1' } }),
      },
      {
        method: 'POST',
        url: `${PB}/v1/orders/7989-1/articles`,
        response: () => jsonResponse({ error: 'too big' }, { status: 400 }),
      },
      {
        method: 'POST',
        url: `${PB}/v1/delivery/7989-1`,
        response: () => jsonResponse({}),
      },
      {
        method: 'GET',
        url: `${PB}/v1/orders/7989-1`,
        response: () => jsonResponse({ amount: '20.00', price_startup: '2.25' }),
      },
      {
        method: 'GET',
        url: `${PB}/v1/delivery/7989-1`,
        response: () => jsonResponse({ amount: '5.95' }),
      },
    ]);
    prismaMock.orderType.findFirst.mockResolvedValue({
      id: 2,
      maxCards: 500,
      amountWithMargin: 26,
    });
    const result = await (peb as any).processOrderRequest(
      [physicalItem(), physicalItem()],
      customerNL,
      true
    );
    expect(result.success).toBe(false);
    expect(
      cacheMock.set.mock.calls.filter(([k]: any[]) =>
        String(k).startsWith('order_request_')
      )
    ).toHaveLength(0);
  });

  it('returns the cached result without calling Print&Bind', async () => {
    const cached = { success: true, data: { orderId: 'cached-1', total: 1 } };
    cacheMock.get.mockResolvedValueOnce(JSON.stringify(cached));
    const result = await (peb as any).processOrderRequest(
      [physicalItem()],
      customerNL,
      false
    );
    expect(result).toEqual(cached);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// finishOrder
// ---------------------------------------------------------------------------
describe('finishOrder', () => {
  it('POSTs an empty body to /finish with the API key and merges apiCalls', async () => {
    routeFetch([
      {
        method: 'POST',
        url: `${PB}/v1/orders/42/finish`,
        response: () => jsonResponse({ ok: true }),
      },
    ]);
    const prior = [
      { method: 'POST', url: 'x', statusCode: 201, responseBody: {} },
    ];
    const result = await peb.finishOrder('42', prior as any);

    const [call] = sentRequests('POST', '/v1/orders/42/finish');
    expect(call[1].headers).toEqual({
      Authorization: API_KEY,
      'Content-Type': 'application/json',
    });
    expect(call[1].body).toBe('{}');

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ orderId: '42' });
    expect(result.apiCalls).toEqual([
      prior[0],
      {
        method: 'POST',
        url: `${PB}/v1/orders/42/finish`,
        statusCode: 200,
        responseBody: { ok: true },
      },
    ]);
  });

  it('returns success:false (still with apiCalls) on a non-OK response', async () => {
    routeFetch([
      {
        method: 'POST',
        url: `${PB}/v1/orders/42/finish`,
        response: () => jsonResponse({ error: 'cart empty' }, { status: 400 }),
      },
    ]);
    const result = await peb.finishOrder('42');
    expect(result.success).toBe(false);
    expect(result.data).toEqual({ orderId: '42' });
    expect(result.apiCalls).toEqual([
      {
        method: 'POST',
        url: `${PB}/v1/orders/42/finish`,
        statusCode: 400,
        responseBody: { error: 'cart empty' },
      },
    ]);
  });

  it('catches network errors and returns an error result', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const result = await peb.finishOrder('42');
    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNRESET');
  });
});

// ---------------------------------------------------------------------------
// updateProductionMethod
// ---------------------------------------------------------------------------
describe('updateProductionMethod', () => {
  it('PUTs the production method to the order endpoint', async () => {
    routeFetch([
      {
        method: 'PUT',
        url: `${PB}/v1/orders/42`,
        response: () => jsonResponse({}),
      },
    ]);
    const result = await peb.updateProductionMethod('42', 'fast');
    expect(result).toEqual({ success: true });
    const [call] = sentRequests('PUT', '/v1/orders/42');
    expect(call[1].headers.Authorization).toBe(API_KEY);
    expect(body(call)).toEqual({ production_method: 'fast' });
  });

  it('returns the status text on a failed update', async () => {
    routeFetch([
      {
        method: 'PUT',
        url: `${PB}/v1/orders/42`,
        response: () =>
          new Response('nope', { status: 400, statusText: 'Bad Request' }),
      },
    ]);
    const result = await peb.updateProductionMethod('42', 'standard');
    expect(result).toEqual({
      success: false,
      error: 'Failed to update production method: Bad Request',
    });
  });

  it('returns the error message when the request throws', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const result = await peb.updateProductionMethod('42', 'fast');
    expect(result).toEqual({ success: false, error: 'offline' });
  });
});

// ---------------------------------------------------------------------------
// checkDeliveryForOrder
// ---------------------------------------------------------------------------
describe('checkDeliveryForOrder', () => {
  it('maps delivery data into the shipment-check row', async () => {
    routeFetch([
      {
        method: 'GET',
        url: `${PB}/v1/delivery/42`,
        response: () =>
          jsonResponse({
            delivery_method: 'post',
            amount: '5.95',
            tracktrace_url: 'https://track.example/1',
          }),
      },
    ]);
    expect(await peb.checkDeliveryForOrder('42')).toEqual({
      printApiOrderId: '42',
      deliveryStatus: 'ok',
      deliveryError: null,
      deliveryMethod: 'post',
      amount: '5.95',
      trackingUrl: 'https://track.example/1',
    });
  });

  it('reports missing when the delivery object is empty', async () => {
    routeFetch([
      {
        method: 'GET',
        url: `${PB}/v1/delivery/42`,
        response: () => jsonResponse({}),
      },
    ]);
    const r = await peb.checkDeliveryForOrder('42');
    expect(r.deliveryStatus).toBe('missing');
    expect(r.deliveryError).toBe('No delivery data found');
  });

  it('reports error with the HTTP status on a non-OK response', async () => {
    routeFetch([
      {
        method: 'GET',
        url: `${PB}/v1/delivery/42`,
        response: () =>
          new Response('x', { status: 500, statusText: 'Internal Server Error' }),
      },
    ]);
    const r = await peb.checkDeliveryForOrder('42');
    expect(r.deliveryStatus).toBe('error');
    expect(r.deliveryError).toBe('HTTP 500 Internal Server Error');
  });

  it('reports error with the exception message when fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('DNS fail'));
    const r = await peb.checkDeliveryForOrder('42');
    expect(r.deliveryStatus).toBe('error');
    expect(r.deliveryError).toBe('DNS fail');
  });
});

// ---------------------------------------------------------------------------
// getInvoice
// ---------------------------------------------------------------------------
describe('getInvoice', () => {
  it('returns the invoice path when the PDF exists', async () => {
    const dir = path.join(process.env['PRIVATE_DIR']!, 'invoice');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'pb-test-invoice.pdf');
    fs.writeFileSync(file, '%PDF-1.4');
    expect(await peb.getInvoice('pb-test-invoice')).toBe(file);
  });

  it('throws "Invoice not found" when the PDF is missing', async () => {
    await expect(peb.getInvoice('pb-test-nope')).rejects.toThrow(
      'Invoice not found'
    );
  });
});

// ---------------------------------------------------------------------------
// getSubmittedOrders
// ---------------------------------------------------------------------------
describe('getSubmittedOrders', () => {
  it('lists submitted payments and strips the tracking link from the row', async () => {
    const created = new Date('2026-06-01T10:00:00Z');
    prismaMock.payment.findMany.mockResolvedValue([
      {
        paymentId: 'pay_1',
        printApiOrderId: '7989',
        fullname: 'Jane',
        email: 'j@x.nl',
        countrycode: 'NL',
        printApiTrackingLink: 'https://track.example/1',
        createdAt: created,
      },
    ]);
    const rows = await peb.getSubmittedOrders();
    expect(prismaMock.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { printApiStatus: 'Submitted', printApiOrderId: { notIn: [''] } },
        orderBy: { createdAt: 'desc' },
      })
    );
    expect(rows).toEqual([
      {
        paymentId: 'pay_1',
        printApiOrderId: '7989',
        fullname: 'Jane',
        email: 'j@x.nl',
        countrycode: 'NL',
        createdAt: created,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// handleTrackingMails
// ---------------------------------------------------------------------------
describe('handleTrackingMails', () => {
  const orderRow = {
    id: 1,
    paymentId: 'pay_1',
    printApiOrderId: '7989',
    fullname: 'Jane',
    email: 'j@x.nl',
    createdAt: new Date(),
  };
  const payment = {
    id: 1,
    paymentId: 'pay_1',
    printApiTrackingLink: 'old-link',
  };

  it('marks shipped orders, stores the tracking link, mails it, and creates a shipment', async () => {
    prismaMock.payment.findMany.mockResolvedValue([orderRow]);
    prismaMock.payment.findUnique.mockResolvedValue(payment);
    prismaMock.payment.update.mockResolvedValue({});
    routeFetch([
      {
        method: 'GET',
        url: `${PB}/v1/orders/7989`,
        response: () => jsonResponse({ status: 'Verzonden' }),
      },
      {
        method: 'GET',
        url: `${PB}/v1/delivery/7989`,
        response: () =>
          jsonResponse({ tracktrace_url: 'https://track.example/new' }),
      },
    ]);

    await peb.handleTrackingMails();

    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        printApiShipped: true,
        printApiShippedAt: expect.any(Date),
        printApiStatus: 'Shipped',
        printApiTrackingLink: 'https://track.example/new',
      },
    });
    const mails = outbound.calls('Mail', 'sendTrackingEmail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args).toEqual([payment, 'https://track.example/new', '']);
    expect(shippingMock.createShipment).toHaveBeenCalledWith('pay_1');
  });

  it('leaves orders untouched while Print&Bind has not shipped them', async () => {
    prismaMock.payment.findMany.mockResolvedValue([orderRow]);
    prismaMock.payment.findUnique.mockResolvedValue(payment);
    routeFetch([
      {
        method: 'GET',
        url: `${PB}/v1/orders/7989`,
        response: () => jsonResponse({ status: 'In productie' }),
      },
    ]);

    await peb.handleTrackingMails();

    expect(prismaMock.payment.update).not.toHaveBeenCalled();
    expect(outbound.calls('Mail', 'sendTrackingEmail')).toHaveLength(0);
  });

  it('skips orders whose status lookup fails', async () => {
    prismaMock.payment.findMany.mockResolvedValue([orderRow]);
    prismaMock.payment.findUnique.mockResolvedValue(payment);
    routeFetch([
      {
        method: 'GET',
        url: `${PB}/v1/orders/7989`,
        response: () => jsonResponse({}, { status: 500 }),
      },
    ]);

    await peb.handleTrackingMails();

    expect(prismaMock.payment.update).not.toHaveBeenCalled();
    expect(outbound.calls('Mail', 'sendTrackingEmail')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleBoxInstructionMails
// ---------------------------------------------------------------------------
describe('handleBoxInstructionMails', () => {
  it('flags the payment before sending the gift box instructions email', async () => {
    const payment = { id: 5, orderId: 'QR1', email: 'j@x.nl' };
    prismaMock.payment.findMany.mockResolvedValue([payment]);
    prismaMock.payment.update.mockResolvedValue({});

    await peb.handleBoxInstructionMails();

    expect(prismaMock.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'paid',
          test: false,
          printApiShipped: true,
          boxInstructionsMailSent: false,
          PaymentHasPlaylist: {
            some: { boxEnabled: true, boxQuantity: { gt: 0 } },
          },
        }),
      })
    );
    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { boxInstructionsMailSent: true },
    });
    const mails = outbound.calls('Mail', 'sendBoxInstructionsEmail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args).toEqual([payment]);
  });

  it('sends nothing when no eligible payments exist', async () => {
    prismaMock.payment.findMany.mockResolvedValue([]);
    await peb.handleBoxInstructionMails();
    expect(prismaMock.payment.update).not.toHaveBeenCalled();
    expect(outbound.calls('Mail', 'sendBoxInstructionsEmail')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createOrder — end-to-end article building (backward-compatible path)
// ---------------------------------------------------------------------------
describe('createOrder', () => {
  it('builds the game card article from the playlist and submits the full order', async () => {
    const payment = {
      id: 9,
      paymentId: 'pay_9',
      fullname: 'Jane Buyer',
      email: 'jane@example.com',
      address: 'Mainstreet',
      housenumber: '12',
      zipcode: '1234AB',
      city: 'Amsterdam',
      countrycode: 'NL',
      fast: false,
      totalPrice: 60,
    };
    const playlists = [
      {
        filename: 'qr_test.pdf',
        playlist: {
          paymentHasPlaylistId: 55,
          numberOfTracks: 100,
          amount: 1,
          name: 'Hits',
          boxEnabled: false,
          boxQuantity: 0,
          boxFilename: null,
        },
      },
    ];
    prismaMock.paymentHasPlaylistItem.findMany.mockResolvedValue([]);
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([]);
    prismaMock.payment.update.mockResolvedValue({});
    prismaMock.orderType.findFirst.mockResolvedValue({
      id: 2,
      maxCards: 500,
      amountWithMargin: 26,
    });
    routeFetch([
      {
        method: 'POST',
        url: `${PB}/v1/orders/articles`,
        response: () =>
          jsonResponse({}, { headers: { location: 'orders/7989-1' } }),
      },
      {
        method: 'POST',
        url: `${PB}/v1/delivery/7989-1`,
        response: () => jsonResponse({}),
      },
      {
        method: 'GET',
        url: `${PB}/v1/orders/7989-1`,
        response: () =>
          jsonResponse({
            amount: '20.00',
            price_startup: '2.25',
            amount_tax_standard: '4.20',
          }),
      },
      {
        method: 'GET',
        url: `${PB}/v1/delivery/7989-1`,
        response: () => jsonResponse({ amount: '5.95' }),
      },
    ]);

    const result = await peb.createOrder(payment, playlists, 'cards');

    // ENVIRONMENT=test → finishOrder must NOT run
    expect(sentRequests('POST', '/finish')).toHaveLength(0);

    const [articleCall] = sentRequests('POST', '/v1/orders/articles');
    expect(body(articleCall)).toEqual({
      amount: 1,
      product: 'losbladig',
      number: '1',
      copies: '200',
      color: 'all',
      size: 'custom',
      printside: 'double',
      finishing: 'loose',
      finishing2: 'none',
      finishing_extra: 'none',
      accessory_item: 'none',
      papertype: 'card',
      size_custom_width: '60',
      size_custom_height: '60',
      check_doc: 'standard',
      delivery_method: 'post',
      add_file_method: 'url',
      file_overwrite: true,
      file_url: `${process.env['API_URI']}/public/pdf/qr_test.pdf`,
      comment:
        'Batch nummer op de kaartjes (rechts onderin op kant met titel/artiest/jaar) moet #55 zijn',
      payment_method: 'bundled',
    });

    expect(result.success).toBe(true);
    expect(result.response.id).toBe('7989-1');
    // article POST + delivery POST (detail GETs are not logged)
    expect(result.response.apiCalls).toHaveLength(2);

    // setPaymentInfo is fire-and-forget — let it settle, then verify the
    // profit bookkeeping: 60/1.21=49.59 ex VAT − 20.00 print cost − 0 boxes.
    await new Promise((resolve) => setImmediate(resolve));
    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { paymentId: 'pay_9' },
      data: {
        printApiPrice: 20,
        printApiPriceInclVat: 24.2,
        totalPriceWithoutTax: 49.59,
        profit: 29.59,
        printApiStatus: 'Submitted',
      },
    });
  });
});
