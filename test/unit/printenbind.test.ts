/**
 * Unit tests for src/printers/printenbind.ts (PrintEnBind class).
 *
 * This module is globally mocked as a recording proxy in test/setup.ts.
 * We vi.unmock it here and re-mock all its heavy dependencies so the real
 * business logic executes against in-memory stubs.
 *
 * Dependencies mocked:
 *  - src/prisma                → in-memory stubs
 *  - src/cache                 → in-memory Map
 *  - src/mail                  → recording proxy (already global)
 *  - src/data                  → stub getTaxRate / resolveTaxContext / euCountryCodes
 *  - src/pdf                   → no-op
 *  - src/spotify               → no-op singleton
 *  - src/utils                 → isMainServer=false
 *  - src/discount              → calculateVolumeDiscount=0
 *  - src/shipping              → stub
 *  - cron                      → no-op CronJob
 *  - cluster                   → isPrimary=false (suppress cron scheduling)
 *
 * No network, no DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.unmock('../../src/printers/printenbind');

// ─── cluster: suppress the primary-worker cron scheduling ─────────────────
vi.mock('cluster', () => ({ default: { isPrimary: false }, isPrimary: false }));

// ─── cron: no-op ──────────────────────────────────────────────────────────
vi.mock('cron', () => ({
  CronJob: class {
    constructor() {}
    start() {}
  },
}));

// ─── Cache (in-memory) ─────────────────────────────────────────────────────
const cacheStore = new Map<string, string>();
vi.mock('../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string) => cacheStore.get(key) ?? null,
      set: async (key: string, value: string) => { cacheStore.set(key, value); },
      delPattern: async () => {},
    }),
  },
}));

// ─── Prisma (in-memory) ────────────────────────────────────────────────────
const prismaMock = {
  orderType: {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => null),
  },
  shippingCostNew: {
    findFirst: vi.fn(async () => null),
  },
  paymentHasPlaylist: {
    findMany: vi.fn(async () => []),
    findUnique: vi.fn(async () => null),
  },
  paymentHasPlaylistItem: {
    findMany: vi.fn(async () => []),
  },
  payment: {
    findMany: vi.fn(async () => []),
    update: vi.fn(async () => ({})),
  },
};
vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

// ─── Data ─────────────────────────────────────────────────────────────────
const dataMock = {
  getTaxRate: vi.fn(async () => 21),
  resolveTaxContext: vi.fn(async () => ({
    taxRate: 21,
    reverseCharge: false,
    vatIdChecked: false,
    vatIdStatus: null,
  })),
  euCountryCodes: ['NL', 'DE', 'BE', 'FR', 'ES', 'IT', 'AT', 'PL'],
};
vi.mock('../../src/data', () => ({
  default: { getInstance: () => dataMock },
}));

// ─── PDF ──────────────────────────────────────────────────────────────────
vi.mock('../../src/pdf', () => ({
  default: class {
    countPDFPages = vi.fn(async () => 4);
    mergeLocalPdfs = vi.fn(async () => 4);
    renderUrlToPdfBuffer = vi.fn(async () => Buffer.from('pdf'));
  },
}));

// ─── Spotify ──────────────────────────────────────────────────────────────
vi.mock('../../src/spotify', () => ({
  default: { getInstance: () => ({}) },
}));

// ─── Utils ────────────────────────────────────────────────────────────────
vi.mock('../../src/utils', () => ({
  default: class {
    isMainServer = vi.fn(async () => false);
    replaceBrandTerms = (s: string) => s;
    cleanTrackName = (s: string) => s;
  },
}));

// ─── Discount ─────────────────────────────────────────────────────────────
vi.mock('../../src/discount', () => ({
  default: class {
    calculateVolumeDiscount = vi.fn(async () => 0);
  },
}));

// ─── Shipping ─────────────────────────────────────────────────────────────
vi.mock('../../src/shipping', () => ({
  default: { getInstance: () => ({}) },
}));

// ─── game (QRGAMES_UPGRADE_PRICE constant) ────────────────────────────────
vi.mock('../../src/game', () => ({ QRGAMES_UPGRADE_PRICE: 9.99 }));

// ─── logger ────────────────────────────────────────────────────────────────
vi.mock('../../src/logger', () => ({
  default: class {
    log = vi.fn();
  },
}));

import PrintEnBind from '../../src/printers/printenbind';

const pnb = PrintEnBind.getInstance();

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('PrintEnBind.calculateCardPrice', () => {
  it('returns totalPrice=basePrice for quantity below minimum (500)', async () => {
    const result = await pnb.calculateCardPrice(13, 200);
    // 200 < 500 → no discount; totalPrice = 200 * (13/500) = 5.2 → Math.ceil(5.2)=6
    // but 6 < 13 → roundedTotalPrice = 13
    expect(result.totalPrice).toBe(13);
    expect(result.discountPercentage).toBe(0);
  });

  it('applies linear discount between 500 and 2500 cards', async () => {
    // At 1500 cards: discount = (1500 - 500) * (0.5 / (2500 - 500)) = 1000 * 0.00025 = 0.25 (25%)
    const result = await pnb.calculateCardPrice(13, 1500);
    expect(result.discountPercentage).toBeCloseTo(25, 1);
    expect(result.pricePerCard).toBeLessThan(13 / 500);
  });

  it('caps discount at 50% for quantity >= 2500', async () => {
    const result = await pnb.calculateCardPrice(13, 2500);
    expect(result.discountPercentage).toBeCloseTo(50, 1);
  });

  it('discount stays at 50% for quantity > 2500', async () => {
    const r2500 = await pnb.calculateCardPrice(13, 2500);
    const r3000 = await pnb.calculateCardPrice(13, 3000);
    expect(r3000.discountPercentage).toBe(r2500.discountPercentage);
  });

  it('totalPrice is never below basePrice', async () => {
    // Small quantities: 10 cards → totalPrice = ceil(10 * 13/500) = ceil(0.26) = 1 → clamped to 13
    const result = await pnb.calculateCardPrice(13, 10);
    expect(result.totalPrice).toBeGreaterThanOrEqual(13);
  });
});

describe('PrintEnBind.calculateSingleItem', () => {
  beforeEach(() => {
    cacheStore.clear();
    dataMock.getTaxRate.mockResolvedValue(21);
  });

  it('physical non-sheet: price includes 1.8 handling + 50% margin + 21% VAT (minimum 50 cards)', async () => {
    const result = await pnb.calculateSingleItem(
      { productType: 'cards', type: 'physical', subType: 'none', quantity: 10, alternatives: {} },
      false
    );
    // useCardAmount = max(10, 50) = 50
    // cardPrice = 0.018*2 + 0.034 = 0.07
    // price = 50 * 0.07 + 1.8 = 3.5 + 1.8 = 5.3
    // margin = max(5.3*1.5, 5.3+12) = max(7.95, 17.3) = 17.3
    // final = Math.ceil(17.3 * 1.21) = Math.ceil(20.933) = 21
    expect(result.price).toBe(21);
    expect(result.alternatives).toEqual({});
  });

  it('physical sheet subType: price computed on sheets × A4Price', async () => {
    const result = await pnb.calculateSingleItem(
      { productType: 'cards', type: 'physical', subType: 'sheets', quantity: 60, alternatives: {} },
      false
    );
    // useCardAmount = 60, numberOfSheets = ceil(60/12) = 5
    // A4Price = 0.09*2 + 0.104 = 0.284
    // price = 5 * 0.284 + 1.8 = 1.42 + 1.8 = 3.22
    // margin = max(3.22*1.5=4.83, 3.22+12=15.22) = 15.22
    // final = Math.ceil(15.22 * 1.21) = Math.ceil(18.4162) = 19
    expect(result.price).toBe(19);
  });

  it('digital type calls calculateCardPrice and applies no VAT scaling', async () => {
    // calculateCardPrice(13, 50) → for quantity < 500, totalPrice = 13 (base)
    const result = await pnb.calculateSingleItem(
      { productType: 'cards', type: 'digital', subType: 'none', quantity: 10, alternatives: {} },
      false
    );
    expect(result.price).toBe(13);
  });

  it('with recurse=true returns alternatives for physical/digital/sheets', async () => {
    const result = await pnb.calculateSingleItem(
      { productType: 'cards', type: 'physical', subType: 'none', quantity: 100, alternatives: {} },
      true
    );
    expect(result.alternatives).toHaveProperty('type.physical');
    expect(result.alternatives).toHaveProperty('type.digital');
    expect(result.alternatives).toHaveProperty('type.sheets');
  });

  it('getRawCardCostEur returns color*2 + paper', () => {
    const cost = pnb.getRawCardCostEur();
    expect(cost).toBeCloseTo(0.018 * 2 + 0.034, 5);
    expect(cost).toBeCloseTo(0.07, 5);
  });
});

describe('PrintEnBind.getShippingCosts', () => {
  beforeEach(() => {
    cacheStore.clear();
    prismaMock.shippingCostNew.findFirst.mockReset();
  });

  it('returns null when not found in DB', async () => {
    prismaMock.shippingCostNew.findFirst.mockResolvedValue(null);
    const result = await pnb.getShippingCosts('ZZ', 100);
    expect(result).toBeNull();
  });

  it('returns DB result and caches it', async () => {
    prismaMock.shippingCostNew.findFirst.mockResolvedValue({ cost: 4.99 });
    const result = await pnb.getShippingCosts('NL', 100);
    expect(result).toEqual({ cost: 4.99 });
    // Second call should use cache
    prismaMock.shippingCostNew.findFirst.mockResolvedValue({ cost: 99.99 });
    const cached = await pnb.getShippingCosts('NL', 100);
    expect(cached).toEqual({ cost: 4.99 });
    expect(prismaMock.shippingCostNew.findFirst).toHaveBeenCalledTimes(1);
  });

  it('maps amountTracks ≤ 80 to size=80', async () => {
    prismaMock.shippingCostNew.findFirst.mockResolvedValue({ cost: 3.5 });
    await pnb.getShippingCosts('NL', 50);
    expect(prismaMock.shippingCostNew.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { country: 'NL', size: 80 } })
    );
  });

  it('maps amountTracks ≤ 405 to size=405', async () => {
    prismaMock.shippingCostNew.findFirst.mockResolvedValue({ cost: 5.0 });
    await pnb.getShippingCosts('DE', 200);
    expect(prismaMock.shippingCostNew.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { country: 'DE', size: 405 } })
    );
  });

  it('maps amountTracks > 1000 to size=1000', async () => {
    prismaMock.shippingCostNew.findFirst.mockResolvedValue({ cost: 8.0 });
    await pnb.getShippingCosts('BE', 1500);
    expect(prismaMock.shippingCostNew.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { country: 'BE', size: 1000 } })
    );
  });

  it('sheets subType always maps to size=80', async () => {
    prismaMock.shippingCostNew.findFirst.mockResolvedValue({ cost: 3.0 });
    await pnb.getShippingCosts('FR', 800, 'sheets');
    expect(prismaMock.shippingCostNew.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { country: 'FR', size: 80 } })
    );
  });
});

describe('PrintEnBind.getOrderTypes', () => {
  beforeEach(() => {
    cacheStore.clear();
    prismaMock.orderType.findMany.mockReset();
  });

  it('returns order types from DB and caches them', async () => {
    prismaMock.orderType.findMany.mockResolvedValue([
      { id: 1, name: 'Small', maxCards: 100, amountWithMargin: 25 },
    ]);
    const result = await pnb.getOrderTypes('cards');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Small');

    // Second call → cache hit
    prismaMock.orderType.findMany.mockResolvedValue([]);
    const cached = await pnb.getOrderTypes('cards');
    expect(cached).toHaveLength(1);
    expect(prismaMock.orderType.findMany).toHaveBeenCalledTimes(1);
  });

  it('uses the type parameter as a filter', async () => {
    prismaMock.orderType.findMany.mockResolvedValue([]);
    await pnb.getOrderTypes('giftcard');
    expect(prismaMock.orderType.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: 'giftcard' }),
      })
    );
  });
});

describe('PrintEnBind.calculateOrder', () => {
  beforeEach(() => {
    cacheStore.clear();
    prismaMock.shippingCostNew.findFirst.mockResolvedValue({ cost: 3.45 });
    dataMock.resolveTaxContext.mockResolvedValue({
      taxRate: 21,
      reverseCharge: false,
      vatIdChecked: false,
      vatIdStatus: null,
    });
  });

  it('defaults countrycode to NL when not provided', async () => {
    const result = await pnb.calculateOrder({
      cart: { items: [] },
    });
    expect(result.success).toBe(true);
    expect(dataMock.resolveTaxContext).toHaveBeenCalledWith(
      expect.objectContaining({ buyerCountry: 'NL' })
    );
  });

  it('includes reverseCharge in result', async () => {
    dataMock.resolveTaxContext.mockResolvedValue({
      taxRate: 0,
      reverseCharge: true,
      vatIdChecked: true,
      vatIdStatus: 'valid',
    });
    const result = await pnb.calculateOrder({
      cart: { items: [] },
      countrycode: 'DE',
      isBusinessOrder: true,
      vatId: 'DE123456789',
    });
    expect(result.data.reverseCharge).toBe(true);
  });

  it('adds 20% for fast-track orders', async () => {
    const normalResult = await pnb.calculateOrder({
      cart: {
        items: [
          { productType: 'cards', type: 'physical', price: 21, amount: 1, numberOfTracks: 50 },
        ],
      },
      countrycode: 'NL',
    });
    const fastResult = await pnb.calculateOrder({
      cart: {
        items: [
          { productType: 'cards', type: 'physical', price: 21, amount: 1, numberOfTracks: 50 },
        ],
      },
      countrycode: 'NL',
      fast: true,
    });
    // Fast orders cost 1.2x the base product price
    expect(fastResult.data.total).toBeGreaterThan(normalResult.data.total);
  });

  it('handles giftcard item type in cart', async () => {
    const result = await pnb.calculateOrder({
      cart: {
        items: [
          { productType: 'giftcard', type: 'digital', price: 15, amount: 1, numberOfTracks: 0 },
        ],
      },
      countrycode: 'NL',
    });
    expect(result.success).toBe(true);
  });

  it('includes gamesFee when gamesEnabled=true', async () => {
    const withGames = await pnb.calculateOrder({
      cart: {
        items: [
          {
            productType: 'cards',
            type: 'physical',
            price: 21,
            amount: 1,
            numberOfTracks: 50,
            gamesEnabled: true,
          },
        ],
      },
      countrycode: 'NL',
    });
    const withoutGames = await pnb.calculateOrder({
      cart: {
        items: [
          {
            productType: 'cards',
            type: 'physical',
            price: 21,
            amount: 1,
            numberOfTracks: 50,
            gamesEnabled: false,
          },
        ],
      },
      countrycode: 'NL',
    });
    expect(withGames.data.gamesFee).toBe(9.99);
    expect(withoutGames.data.gamesFee).toBe(0);
    expect(withGames.data.total).toBeCloseTo(withoutGames.data.total + 9.99, 2);
  });

  it('NL with 1 playlist: uses standard shipping', async () => {
    prismaMock.shippingCostNew.findFirst.mockResolvedValue({ cost: 3.45 });
    const result = await pnb.calculateOrder({
      cart: {
        items: [
          { productType: 'cards', type: 'physical', price: 21, amount: 1, numberOfTracks: 50 },
        ],
      },
      countrycode: 'NL',
    });
    // For NL + 1 playlist, shipping should be 2.99 (the fixed NL single-playlist rate)
    expect(result.data.shipping).toBeCloseTo(2.99, 2);
  });

  it('NL, DE, BE with >= 2 playlists: free shipping', async () => {
    for (const cc of ['NL', 'DE', 'BE']) {
      const result = await pnb.calculateOrder({
        cart: {
          items: [
            { productType: 'cards', type: 'physical', price: 21, amount: 2, numberOfTracks: 50 },
          ],
        },
        countrycode: cc,
      });
      expect(result.data.shipping).toBe(0);
    }
  });
});

describe('PrintEnBind.finishOrder', () => {
  beforeEach(() => {
    process.env['PRINTENBIND_API_URL'] = 'https://api.printenbind.nl';
    process.env['PRINTENBIND_API_KEY'] = 'test-key';
  });

  it('returns success=true when fetch responds 200', async () => {
    global.fetch = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        clone: () => ({
          json: async () => ({ status: 'ok' }),
        }),
        json: async () => ({ status: 'ok' }),
      } as any)
    );
    const result = await pnb.finishOrder('order-123');
    expect(result.success).toBe(true);
    expect(result.data?.orderId).toBe('order-123');
  });

  it('returns success=false when fetch responds non-ok', async () => {
    global.fetch = vi.fn(async () =>
      ({
        ok: false,
        status: 400,
        clone: () => ({
          json: async () => ({ error: 'bad request' }),
        }),
        json: async () => ({ error: 'bad request' }),
      } as any)
    );
    const result = await pnb.finishOrder('order-456');
    expect(result.success).toBe(false);
  });
});
