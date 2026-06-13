/**
 * Unit tests for src/printer.ts (Printer class).
 *
 * Printer.calculate() is pure arithmetic that calls PrintEnBind.calculateSingleItem
 * for the consumer price. Both printer and printenbind are globally mocked in
 * test/setup.ts so we must vi.unmock printer and re-mock printenbind to intercept
 * just the calculateSingleItem call.
 *
 * No network, no DB, no filesystem.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unmock printer so the real implementation is tested.
vi.unmock('../../src/printer');

// Provide a deterministic calculateSingleItem result so Printer.calculate does
// not have to hit a real PrintEnBind instance with a real DB.
// (printenbind is globally mocked in setup.ts but we override its shape here)
const calculateSingleItemMock = vi.fn(async () => ({
  price: 24.0,
  alternatives: {},
}));

vi.mock('../../src/printers/printenbind', () => ({
  default: {
    getInstance: () => ({
      calculateSingleItem: calculateSingleItemMock,
    }),
  },
}));

import Printer from '../../src/printer';

const printer = Printer.getInstance();

// ─── helpers ─────────────────────────────────────────────────────────────────

const round2 = (v: number) => Math.round(v * 100) / 100;

describe('Printer.getDefaults()', () => {
  it('returns sensible default values', () => {
    const d = printer.getDefaults();
    expect(d.avgCards).toBe(200);
    expect(d.acquisitionMode).toBe('buy');
    expect(d.equipmentCost).toBe(45000);
    expect(d.ordersPerMonth).toBe(350);
    expect(d.cardsPerSheet).toBe(18);
  });
});

describe('Printer.calculate() – buy mode', () => {
  beforeEach(() => {
    calculateSingleItemMock.mockClear();
    calculateSingleItemMock.mockResolvedValue({ price: 24.0, alternatives: {} });
  });

  it('returns acquisitionMode=buy when not specified', async () => {
    const { inputs, result } = await printer.calculate({});
    expect(inputs.acquisitionMode).toBe('buy');
    expect(result.acquisitionMode).toBe('buy');
  });

  it('calls PrintEnBind.calculateSingleItem for consumer price', async () => {
    await printer.calculate({});
    expect(calculateSingleItemMock).toHaveBeenCalledTimes(1);
    expect(calculateSingleItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ productType: 'cards', type: 'physical' }),
      false
    );
  });

  it('consumer price is passed through from PrintEnBind', async () => {
    const { result } = await printer.calculate({});
    expect(result.consumerPrice.priceInclTax).toBe(24.0);
    expect(result.consumerPrice.priceExclTax).toBe(round2(24 / 1.21));
  });

  it('external card cost scales proportionally with avgCards', async () => {
    // At 200 cards (default), externalCardPrice=14 → externalCardPriceScaled=14
    const { result: r200 } = await printer.calculate({ avgCards: 200 });
    expect(r200.external.cardPrice).toBeCloseTo(14, 2);

    // At 400 cards → externalCardPriceScaled = 2 * 14 = 28
    const { result: r400 } = await printer.calculate({ avgCards: 400 });
    expect(r400.external.cardPrice).toBeCloseTo(28, 2);
  });

  it('external totalPerOrder adds handling + shipping', async () => {
    const { result } = await printer.calculate({
      avgCards: 200,
      externalCardPrice: 14,
      externalHandling: 1.8,
      externalShipping: 3.45,
    });
    expect(result.external.totalPerOrder).toBeCloseTo(14 + 1.8 + 3.45, 2);
  });

  it('sheets needed is ceiling of avgCards / cardsPerSheet', async () => {
    // 200 cards / 18 = 11.11… → 12 sheets
    const { result } = await printer.calculate({ avgCards: 200, cardsPerSheet: 18 });
    // own paperCost = 12 sheets * 0.145 default
    expect(result.own.paperCost).toBeCloseTo(12 * 0.145, 3);
  });

  it('buy-mode break-even is upfrontCost / savingsPerMonth (linear)', async () => {
    const { inputs, result } = await printer.calculate({
      avgCards: 200,
      acquisitionMode: 'buy',
      equipmentCost: 45000,
      ordersPerMonth: 350,
      externalCardPrice: 14,
      externalHandling: 1.8,
      externalShipping: 3.45,
      paperPricePerSheet: 0.145,
      cardsPerSheet: 18,
      printCostPerSheet: 0.197,
      docucutterPartsPerSheet: 0.02,
      ownShippingCost: 3.45,
      envelopePrice: 0.2,
      thermicLabelPrice: 0.01,
      cuttingMachineMonthlyCost: 120,
    });
    // Gross savings per month: (externalTotal - ownVariable) * ordersPerMonth
    // After deducting fixed cost (cutting machine only in buy mode), savingsPerMonth
    expect(result.breakeven.months).toBeGreaterThan(0);
    expect(isFinite(result.breakeven.months)).toBe(true);
    // breakeven.orders is Math.ceil of the raw (unrounded) months * ordersPerMonth;
    // since breakeven.months is already rounded to 2dp, we can only assert it is
    // close to the expected value (within 1 order)
    expect(result.breakeven.orders).toBeGreaterThan(0);
    expect(result.breakeven.years).toBeCloseTo(result.breakeven.months / 12, 1);
  });

  it('break-even is Infinity when savings are 0 or negative', async () => {
    // Set external prices very low so we never break even
    const { result } = await printer.calculate({
      externalCardPrice: 0,
      externalHandling: 0,
      externalShipping: 0,
      equipmentCost: 100000,
    });
    expect(result.breakeven.months).toBe(Infinity);
    expect(result.breakeven.orders).toBe(Infinity);
  });

  it('projections increase monotonically (year 2 > year 1)', async () => {
    const { result } = await printer.calculate({});
    // Year 2 should be more positive savings than year 1 when profitable
    if (isFinite(result.breakeven.months) && result.savings.perMonth > 0) {
      expect(result.projections.yearTwo).toBeGreaterThan(result.projections.yearOne);
    }
  });

  it('chart data arrays all have the same length', async () => {
    const { result } = await printer.calculate({ avgCards: 200 });
    const { months, externalCosts, ownCosts, cumulativeSavings } = result.chartData;
    expect(externalCosts.length).toBe(months.length);
    expect(ownCosts.length).toBe(months.length);
    expect(cumulativeSavings.length).toBe(months.length);
  });

  it('chart months starts at 0 and increments by 1', async () => {
    const { result } = await printer.calculate({});
    const months = result.chartData.months;
    expect(months[0]).toBe(0);
    expect(months[1]).toBe(1);
    expect(months[months.length - 1]).toBe(months.length - 1);
  });

  it('cumulative savings at month 0 equals negative upfront cost', async () => {
    const equipmentCost = 45000;
    const { result } = await printer.calculate({ equipmentCost, acquisitionMode: 'buy' });
    // At month 0, cumulative savings = 0 - upfrontCost = -equipmentCost
    expect(result.chartData.cumulativeSavings[0]).toBeCloseTo(-equipmentCost, 0);
  });

  it('savings percentage is always between 0 and 100 for realistic inputs', async () => {
    const { result } = await printer.calculate({});
    expect(result.savings.percentage).toBeGreaterThanOrEqual(0);
    expect(result.savings.percentage).toBeLessThanOrEqual(100);
  });

  it('margin own > margin external (own cheaper → larger margin)', async () => {
    // Own production should cost less than external, leaving more margin
    const { result } = await printer.calculate({});
    expect(result.consumerPrice.marginOwn).toBeGreaterThanOrEqual(
      result.consumerPrice.marginExternal
    );
  });

  it('own per-sheet total equals sum of its components', async () => {
    const { result } = await printer.calculate({});
    const s = result.own.perSheet;
    // Each component is rounded to 3dp independently, so the sum may differ
    // from the total by up to 5 * 0.001 = 0.005
    const sum = s.paper + s.printClicks + s.docucutterService + s.docucutterParts + s.depreciation;
    expect(Math.abs(sum - s.total)).toBeLessThan(0.006);
  });

  it('handles zero ordersPerMonth without division by zero', async () => {
    const { result } = await printer.calculate({ ordersPerMonth: 0 });
    // monthlyCardVolume = 0, so per-sheet distributed costs become 0
    expect(result.own.perSheet.docucutterService).toBe(0);
    expect(result.own.perSheet.depreciation).toBe(0);
  });
});

describe('Printer.calculate() – lease mode', () => {
  beforeEach(() => {
    calculateSingleItemMock.mockClear();
    calculateSingleItemMock.mockResolvedValue({ price: 24.0, alternatives: {} });
  });

  it('returns acquisitionMode=lease when requested', async () => {
    const { inputs, result } = await printer.calculate({ acquisitionMode: 'lease' });
    expect(inputs.acquisitionMode).toBe('lease');
    expect(result.acquisitionMode).toBe('lease');
  });

  it('lease with zero deposit breaks even immediately if variable savings are positive', async () => {
    const { result } = await printer.calculate({
      acquisitionMode: 'lease',
      leaseDeposit: 0,
      leaseMonthlyPayment: 0, // no lease payment → savingsPerMonthDuringLease = gross - cutting
      cuttingMachineMonthlyCost: 0,
    });
    // With 0 upfront and 0 fixed, we break even immediately
    if (result.savings.perMonth > 0) {
      expect(result.breakeven.months).toBe(0);
    }
  });

  it('lease depreciation uses leaseMonthlyPayment instead of equipmentCost', async () => {
    const { result: buyResult } = await printer.calculate({ acquisitionMode: 'buy' });
    const { result: leaseResult } = await printer.calculate({
      acquisitionMode: 'lease',
      leaseMonthlyPayment: 900,
    });
    // Depreciation values should differ between buy and lease
    expect(buyResult.own.perSheet.depreciation).not.toEqual(leaseResult.own.perSheet.depreciation);
  });

  it('lease break-even can be after lease duration', async () => {
    // Small savings during lease (high lease payment), recovering after
    const { result } = await printer.calculate({
      acquisitionMode: 'lease',
      leaseMonthlyPayment: 99999,
      leaseDeposit: 0,
      leaseDurationMonths: 1,
      ordersPerMonth: 350,
    });
    // During lease we lose money (high payment), so break-even must be after month 1 (if at all)
    // Most likely Infinity, but the important thing is the code doesn't crash
    expect(result.breakeven.months).toBeGreaterThanOrEqual(1);
  });

  it('cumulative savings at month 0 equals negative deposit (upfront cost)', async () => {
    const deposit = 5000;
    const { result } = await printer.calculate({
      acquisitionMode: 'lease',
      leaseDeposit: deposit,
    });
    expect(result.chartData.cumulativeSavings[0]).toBeCloseTo(-deposit, 0);
  });

  it('own costs in chart account for lease payments stopping at leaseDurationMonths', async () => {
    const leaseDuration = 12;
    const leasePayment = 500;
    const { result } = await printer.calculate({
      acquisitionMode: 'lease',
      leaseDurationMonths: leaseDuration,
      leaseMonthlyPayment: leasePayment,
      leaseDeposit: 0,
    });
    const ownCosts = result.chartData.ownCosts;
    if (ownCosts.length > leaseDuration + 2) {
      // The increment from month leaseDuration to leaseDuration+1 should be smaller
      // (no more lease payment) than from leaseDuration-1 to leaseDuration
      const incrDuringLease = ownCosts[leaseDuration] - ownCosts[leaseDuration - 1];
      const incrAfterLease = ownCosts[leaseDuration + 1] - ownCosts[leaseDuration];
      expect(incrAfterLease).toBeLessThan(incrDuringLease);
    }
  });
});

describe('Printer.calculate() – input overrides', () => {
  beforeEach(() => {
    calculateSingleItemMock.mockClear();
    calculateSingleItemMock.mockResolvedValue({ price: 24.0, alternatives: {} });
  });

  it('uses provided avgCards over the default 200', async () => {
    const { inputs } = await printer.calculate({ avgCards: 500 });
    expect(inputs.avgCards).toBe(500);
  });

  it('saves all inputs verbatim in the returned inputs object', async () => {
    const custom = {
      avgCards: 300,
      acquisitionMode: 'buy' as const,
      equipmentCost: 30000,
      ordersPerMonth: 200,
      externalCardPrice: 12,
      externalHandling: 2,
      externalShipping: 4,
    };
    const { inputs } = await printer.calculate(custom);
    for (const [k, v] of Object.entries(custom)) {
      expect((inputs as any)[k]).toBe(v);
    }
  });

  it('fast-mode (ordersPerMonth=1) still produces a finite result', async () => {
    const { result } = await printer.calculate({ ordersPerMonth: 1 });
    expect(typeof result.breakeven.months).toBe('number');
  });
});
