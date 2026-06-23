/**
 * Unit tests for src/vibe.ts — pricing calculators (OnzeVibe/HappiBox,
 * Tromp, Schneider) and buildInvoiceLineItems. Pure math; prisma only
 * needed for buildInvoiceLineItems lookups.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, resetAll } from './vibe-mocks';

vi.mock('../../../src/prisma', async () => (await import('./vibe-mocks')).prismaModule());
vi.mock('../../../src/cache', async () => (await import('./vibe-mocks')).cacheModule());
vi.mock('../../../src/utils', async () => (await import('./vibe-mocks')).utilsModule());
vi.mock('../../../src/auth', async () => (await import('./vibe-mocks')).authModule());
vi.mock('../../../src/mollie', async () => (await import('./vibe-mocks')).mollieModule());
vi.mock('../../../src/discount', async () => (await import('./vibe-mocks')).discountModule());
vi.mock('../../../src/data', async () => (await import('./vibe-mocks')).dataModule());
vi.mock('../../../src/spotify', async () => (await import('./vibe-mocks')).spotifyModule());
vi.mock('../../../src/generator', async () => (await import('./vibe-mocks')).generatorModule());
vi.mock('../../../src/translation', async () => (await import('./vibe-mocks')).translationModule());
vi.mock('../../../src/logger', async () => (await import('./vibe-mocks')).loggerModule());
vi.mock('sharp', async () => (await import('./vibe-mocks')).sharpModule());
vi.mock('fs/promises', async () => (await import('./vibe-mocks')).fsModule());

import Vibe from '../../../src/vibe';

const vibe = Vibe.getInstance();

beforeEach(() => {
  resetAll();
});

const baseParams = {
  quantity: 100,
  includePersonalization: true,
  shipmentOnLocation: false,
  soldBy: 'happibox' as const,
  isReseller: false,
  manualDiscount: 0,
};

describe('calculatePricing (OnzeVibe/HappiBox)', () => {
  it('rejects invalid quantity', async () => {
    expect(await vibe.calculatePricing({ ...baseParams, quantity: 0 })).toMatchObject({
      success: false,
      error: 'Invalid quantity',
    });
  });

  it('tier 100, sold by happibox: half reseller discount goes to us', async () => {
    const res = await vibe.calculatePricing(baseParams);
    expect(res.success).toBe(true);
    const c = res.calculation;
    expect(c.tierKey).toBe(100);
    expect(c.pricing.commercialPricePerBox).toBe(44.95);
    // kickBack 3 + half of reseller discount 3.079/2 = 4.5395 -> 4.54
    expect(c.pricing.profitPerBox).toBe(4.54);
    expect(c.pricing.clientPrice).toBe(4495);
    expect(c.pricing.ourProfit).toBe(454);
    expect(c.pricing.resellerProfit).toBe(0);
    expect(c.pricing.happiBoxPayment).toBe(4041);
  });

  it('sold by onzevibe: project management waived, full reseller discount for us', async () => {
    const res = await vibe.calculatePricing({ ...baseParams, soldBy: 'onzevibe' });
    const c = res.calculation;
    expect(c.adjustments.adjustedProjectManagement).toBe(0);
    expect(c.adjustments.projectManagementDifference).toBe(5);
    expect(c.pricing.commercialPricePerBox).toBe(39.95); // 44.95 - 5
    expect(c.pricing.profitPerBox).toBe(6.08); // 3 + 3.079
  });

  it('removes the personalization component when not included', async () => {
    const res = await vibe.calculatePricing({
      ...baseParams,
      includePersonalization: false,
    });
    expect(res.calculation.pricing.commercialPricePerBox).toBe(39.95); // 44.95 - 5
  });

  it('shipment on location reduces shipping to 0.35 per box', async () => {
    const res = await vibe.calculatePricing({ ...baseParams, shipmentOnLocation: true });
    const c = res.calculation;
    expect(c.adjustments.adjustedShipping).toBe(0.35);
    expect(c.adjustments.shippingDifference).toBeCloseTo(2.6, 10);
    expect(c.pricing.commercialPricePerBox).toBe(42.35); // 44.95 - 2.60
  });

  it('reseller orders move the reseller discount out of our profit', async () => {
    const res = await vibe.calculatePricing({ ...baseParams, isReseller: true });
    const c = res.calculation;
    expect(c.pricing.profitPerBox).toBe(3); // kickback only
    expect(c.pricing.resellerProfit).toBe(307.9); // 3.079 * 100
    expect(c.pricing.happiBoxPayment).toBe(3887.1); // 4495 - 300 - 307.9
  });

  it('manual discount lowers both the client price and our profit', async () => {
    const res = await vibe.calculatePricing({ ...baseParams, manualDiscount: 2 });
    const c = res.calculation;
    expect(c.pricing.commercialPricePerBox).toBe(42.95);
    expect(c.pricing.profitPerBox).toBe(2.54); // 4.54 - 2
  });

  it.each([
    [100, 100],
    [249, 100],
    [250, 250],
    [999, 500],
    [1000, 1000],
    [2500, 2500],
    [4999, 2500],
    [5000, 5000],
    [9000, 5000],
  ])('standard mode maps quantity %i to tier %i', async (quantity, tierKey) => {
    const res = await vibe.calculatePricing({ ...baseParams, quantity });
    expect(res.calculation.tierKey).toBe(tierKey);
  });

  it('fluid mode interpolates linearly between tiers', async () => {
    // 175 sits exactly halfway between the 100 and 250 tiers
    const res = await vibe.calculatePricing({
      ...baseParams,
      quantity: 175,
      fluidMode: true,
    });
    const c = res.calculation;
    expect(c.tierKey).toBe(100); // lower tier shown as reference
    expect(c.pricing.commercialPricePerBox).toBe(37.95); // (44.95+30.95)/2
    expect(c.tierData.personalization).toBeCloseTo(3.5, 10); // (5+2)/2
    expect(c.tierData.kickBackFee).toBeCloseTo(3.75, 10); // (3+4.5)/2
    expect(c.pricing.clientPrice).toBeCloseTo(6641.25, 2);
  });

  it('fluid mode clamps to the 5000 tier for huge quantities', async () => {
    const res = await vibe.calculatePricing({
      ...baseParams,
      quantity: 6000,
      fluidMode: true,
    });
    expect(res.calculation.tierKey).toBe(5000);
    expect(res.calculation.pricing.commercialPricePerBox).toBe(16.95);
  });

  it('fluid mode at exactly 100 falls back to standard brackets', async () => {
    const res = await vibe.calculatePricing({
      ...baseParams,
      quantity: 100,
      fluidMode: true,
    });
    expect(res.calculation.tierKey).toBe(100);
    expect(res.calculation.pricing.commercialPricePerBox).toBe(44.95);
  });

  it('adds one-time app and voting portal fees to client price and our profit', async () => {
    const res = await vibe.calculatePricing({
      ...baseParams,
      includeCustomApp: true,
      includeVotingPortal: true,
    });
    const p = res.calculation.pricing;
    expect(p.customAppFee).toBe(350);
    expect(p.votingPortalFee).toBe(500);
    expect(p.clientPrice).toBe(5345); // 4495 + 850
    expect(p.ourProfit).toBe(1304); // 454 + 850
  });
});

describe('calculateTrompPricing', () => {
  const tromp = (over: Record<string, any> = {}) =>
    vibe.calculateTrompPricing({
      quantity: 1000,
      includeStansmestekening: false,
      includeStansvorm: false,
      profitMargin: 2,
      ...over,
    } as any);

  it('rejects invalid quantity', async () => {
    expect(await tromp({ quantity: 0 })).toMatchObject({
      success: false,
      error: 'Invalid quantity',
    });
  });

  it('eigen bedrukking: linear box and card formulas plus margin', async () => {
    const res = await tromp();
    const c = res.calculation;
    expect(c.printingType).toBe('eigen');
    expect(c.boxTypeName).toBe('Volledig eigen bedrukking');
    expect(c.cardsPerSet).toBe(200);
    expect(c.boxPrice).toBeCloseTo(1165, 6); // 1000*0.335 + 830
    expect(c.cardPrice).toBeCloseTo(6150, 6); // 1000*5.9 + 250
    expect(c.boxPricePerUnit).toBe(1.17);
    expect(c.cardPricePerUnit).toBe(6.15);
    expect(c.pricePerSet).toBe(9.32); // 7.315 + 2 rounded
    expect(c.clientPrice).toBe(9320); // derived from rounded per-set price
    expect(c.ourProfit).toBe(2000);
    expect(c.trompCost).toBe(7320);
    expect(c.extras).toEqual([]);
  });

  it('voorbedrukt doosje: per-box 1.165 and one-time extras', async () => {
    const res = await tromp({
      quantity: 100,
      profitMargin: 0.5,
      printingType: 'voorbedrukt',
      includeStansmestekening: true,
      includeStansvorm: true,
    });
    const c = res.calculation;
    expect(c.boxTypeName).toBe('Voorbedrukt met venster');
    expect(c.boxPrice).toBeCloseTo(116.5, 6);
    expect(c.cardPrice).toBeCloseTo(840, 6);
    expect(c.extras).toEqual([
      { name: 'Stansmestekening + dummy', price: 150 },
      { name: 'Stansvorm', price: 425 },
    ]);
    expect(c.extrasTotal).toBe(575);
    expect(c.pricePerSet).toBe(10.07);
    expect(c.clientPrice).toBe(1582); // 1007 + 575 extras
    expect(c.trompCost).toBe(1532); // 1007 - 50 profit + 575
  });

  it('klein doosje: 100 cards per set, halved card surcharge', async () => {
    const res = await tromp({ quantity: 100, profitMargin: 0, printingType: 'klein' });
    const c = res.calculation;
    expect(c.boxTypeName).toBe('Klein voorbedrukt met venster');
    expect(c.cardsPerSet).toBe(100);
    expect(c.cardPrice).toBeCloseTo(470, 6); // ((840-100)*0.5)+100
    expect(c.pricePerSet).toBe(5.87);
    expect(c.clientPrice).toBe(587);
  });

  it('luxe doos: setup 3850 + 10.50 per box, no separate card cost, one-time fees', async () => {
    const res = await tromp({
      quantity: 100,
      profitMargin: 1,
      printingType: 'luxe',
      includeCustomApp: true,
      includeVotingPortal: true,
    });
    const c = res.calculation;
    expect(c.boxTypeName).toBe('Luxe doos (200 kaarten + bedrukte chips)');
    expect(c.boxPrice).toBe(4900);
    expect(c.cardPrice).toBe(0);
    expect(c.pricePerSet).toBe(50); // 49 cost + 1 margin
    expect(c.customAppFee).toBe(350);
    expect(c.votingPortalFee).toBe(500);
    expect(c.clientPrice).toBe(5850); // 5000 + 850 fees
    expect(c.ourProfit).toBe(950); // 100 margin + 850 fees
  });
});

describe('calculateSchneiderPricing', () => {
  const schneider = (over: Record<string, any> = {}) =>
    vibe.calculateSchneiderPricing({
      quantity: 100,
      cardCount: 48,
      includeStansmes: false,
      profitMargin: 1,
      ...over,
    } as any);

  it('rejects invalid quantity and card counts', async () => {
    expect(await schneider({ quantity: 0 })).toMatchObject({ success: false });
    expect(await schneider({ cardCount: 100 })).toMatchObject({
      success: false,
      error: 'Invalid card count. Must be 48, 96, 144, or 192',
    });
  });

  it('48 cards: tier price with 30% reseller discount, no fixed cost', async () => {
    const res = await schneider();
    const c = res.calculation;
    expect(c.boxType).toBe('1-vaks luxe dekseldoosje');
    expect(c.fixedCost).toBe(0);
    expect(c.pricePerPiece).toBe(3.72); // 5.31 * 0.7
    expect(c.subtotal).toBeCloseTo(372, 6);
    expect(c.pricePerBox).toBe(4.72);
    expect(c.clientPrice).toBe(472);
    expect(c.schneiderCost).toBe(372);
    expect(c.ourProfit).toBe(100);
  });

  it('48 cards: quantity between tiers uses the highest qualifying tier', async () => {
    const res = await schneider({ quantity: 600 });
    expect(res.calculation.pricePerPiece).toBe(1.55); // 500-tier 2.21 * 0.7
  });

  it('48 cards: quantities above the top tier use the 10000 tier', async () => {
    const res = await schneider({ quantity: 20000 });
    expect(res.calculation.pricePerPiece).toBe(0.58); // 0.83 * 0.7
  });

  it('48/96 cards never get a stansmes even when requested', async () => {
    const res48 = await schneider({ includeStansmes: true });
    expect(res48.calculation.extras).toEqual([]);
    const res96 = await schneider({
      cardCount: 96,
      quantity: 10,
      profitMargin: 0,
      includeStansmes: true,
    });
    expect(res96.calculation.extras).toEqual([]);
    expect(res96.calculation.fixedCost).toBe(790);
    expect(res96.calculation.pricePerPiece).toBe(2.16);
    expect(res96.calculation.subtotal).toBeCloseTo(811.6, 6);
    expect(res96.calculation.clientPrice).toBeCloseTo(811.6, 2);
  });

  it('144 cards with stansmes: fixed 1000 + 2.65/piece + 325 one-time', async () => {
    const res = await schneider({
      cardCount: 144,
      quantity: 10,
      profitMargin: 5,
      includeStansmes: true,
    });
    const c = res.calculation;
    expect(c.boxType).toBe('2-vaks luxe dekseldoosje');
    expect(c.extras).toEqual([{ name: 'Stansmes 2-vaks doosje', price: 325 }]);
    expect(c.pricePerBox).toBe(107.65);
    expect(c.clientPrice).toBe(1401.5);
    expect(c.schneiderCost).toBe(1351.5);
    expect(c.ourProfit).toBe(50);
  });

  it('192 cards: 4-vaks box with 375 stansmes', async () => {
    const res = await schneider({
      cardCount: 192,
      quantity: 10,
      profitMargin: 0,
      includeStansmes: true,
    });
    const c = res.calculation;
    expect(c.boxType).toBe('4-vaks luxe dekseldoosje');
    expect(c.fixedCost).toBe(1350);
    expect(c.pricePerPiece).toBe(3.73);
    expect(c.extras).toEqual([{ name: 'Stansmes 4-vaks doosje', price: 375 }]);
  });

  it('lists app/voting portal fees as extras and counts them in totals', async () => {
    const res = await schneider({
      includeCustomApp: true,
      includeVotingPortal: true,
    });
    const c = res.calculation;
    expect(c.extras).toEqual([
      { name: 'App in eigen stijl', price: 350 },
      { name: 'Voting Portal', price: 500 },
    ]);
    expect(c.extrasTotal).toBe(850);
    expect(c.clientPrice).toBe(1322); // 472 + 850
    expect(c.ourProfit).toBe(950); // 100 + 850
  });
});

describe('buildInvoiceLineItems', () => {
  it('rejects unknown lists and company mismatches', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(null);
    expect(await vibe.buildInvoiceLineItems(1, 2, 'qrsong', 'full')).toMatchObject({
      success: false,
      error: 'List not found',
    });
    h.prisma.companyList.findUnique.mockResolvedValue({ id: 2, companyId: 99 });
    expect(await vibe.buildInvoiceLineItems(1, 2, 'qrsong', 'full')).toMatchObject({
      success: false,
      error: 'List not found',
    });
  });

  it('rejects when the company is missing', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({ id: 2, companyId: 1 });
    h.prisma.company.findUnique.mockResolvedValue(null);
    expect(await vibe.buildInvoiceLineItems(1, 2, 'qrsong', 'full')).toMatchObject({
      success: false,
      error: 'Company not found',
    });
  });

  it('qrsong: builds set line + app fee + percentage discount line', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 2,
      companyId: 1,
      name: 'Feest 2026',
      calculationTromp: JSON.stringify({
        quantity: 1000,
        printingType: 'eigen',
        profitMargin: 2,
        includeCustomApp: true,
        manualDiscountPercent: 10,
      }),
    });
    h.prisma.company.findUnique.mockResolvedValue({ id: 1, name: 'Acme' });

    const res = await vibe.buildInvoiceLineItems(1, 2, 'qrsong', 'full');
    expect(res.success).toBe(true);
    expect(res.reference).toBe('Feest 2026');
    expect(res.items).toEqual([
      {
        description:
          'QRSong! muziekkaarten set — Een doos met 2 kleinere doosjes met ieder 100 kaarten (totaal 200 kaarten)',
        amount: '1000',
        price: '9.32',
      },
      {
        description:
          'App in eigen stijl — eenmalige kosten, maatwerk app ontwikkeling',
        amount: '1',
        price: '350.00',
      },
      { description: 'Korting (10%)', amount: '1', price: '-967.00' },
    ]);
    expect(res.totals!.subtotalExclVat).toBeCloseTo(9670, 2);
    expect(res.totals!.discountAmount).toBeCloseTo(967, 2);
    expect(res.totals!.totalAfterDiscount).toBeCloseTo(8703, 2);
  });

  it('qrsong: down payment collapses to a single 30% line', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 2,
      companyId: 1,
      name: 'Feest 2026',
      calculationTromp: JSON.stringify({
        quantity: 1000,
        printingType: 'eigen',
        profitMargin: 2,
        includeCustomApp: true,
        manualDiscountPercent: 10,
      }),
    });
    h.prisma.company.findUnique.mockResolvedValue({ id: 1, name: 'Acme' });

    const res = await vibe.buildInvoiceLineItems(1, 2, 'qrsong', 'down');
    expect(res.items).toEqual([
      {
        description: 'Aanbetaling 30% — Feest 2026',
        amount: '1',
        price: '2610.90',
      },
    ]);
    expect(res.totals!.totalAfterDiscount).toBeCloseTo(2610.9, 2);
  });

  it('remaining payment collapses to a single 70% line', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 2,
      companyId: 1,
      name: 'Feest 2026',
      calculationTromp: JSON.stringify({
        quantity: 1000,
        printingType: 'eigen',
        profitMargin: 2,
      }),
    });
    h.prisma.company.findUnique.mockResolvedValue({ id: 1, name: 'Acme' });
    const res = await vibe.buildInvoiceLineItems(1, 2, 'qrsong', 'remaining');
    expect(res.items![0].description).toBe('Slottermijn 70% — Feest 2026');
    expect(res.items![0].price).toBe('6524.00'); // 9320 * 0.7, no discount
  });

  it('schneider: box line plus stansmes as a one-time line', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 2,
      companyId: 1,
      name: 'Lijst',
      calculationSchneider: JSON.stringify({
        quantity: 10,
        cardCount: 144,
        includeStansmes: true,
        profitMargin: 5,
      }),
    });
    h.prisma.company.findUnique.mockResolvedValue({ id: 1, name: 'Acme' });

    const res = await vibe.buildInvoiceLineItems(1, 2, 'schneider', 'full');
    expect(res.items).toEqual([
      { description: 'QRSong! Box - 144 kaarten', amount: '10', price: '107.65' },
      {
        description: 'Stansmes 2-vaks doosje (eenmalige kosten)',
        amount: '1',
        price: '325.00',
      },
    ]);
    expect(res.totals!.subtotalExclVat).toBeCloseTo(1401.5, 2);
  });

  it('onzevibe: falls back to the company-level calculation when the list has none', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 2,
      companyId: 1,
      name: 'Lijst',
      calculation: null,
    });
    h.prisma.company.findUnique.mockResolvedValue({
      id: 1,
      name: 'Acme',
      calculation: JSON.stringify({
        quantity: 100,
        includePersonalization: true,
        soldBy: 'onzevibe',
        includeVotingPortal: true,
      }),
    });

    const res = await vibe.buildInvoiceLineItems(1, 2, 'onzevibe', 'full');
    expect(res.items).toEqual([
      {
        description:
          'OnzeVibe box met 200 QR muziekkaarten (inclusief personalisatie)',
        amount: '100',
        price: '39.95',
      },
      {
        description: 'Voting Portal — eenmalige kosten, gebruik stemportaal',
        amount: '1',
        price: '500.00',
      },
    ]);
    expect(res.totals!.subtotalExclVat).toBeCloseTo(4495, 2);
    expect(res.totals!.discountAmount).toBe(0);
  });

  it('onzevibe without personalization mentions it in the description', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 2,
      companyId: 1,
      name: 'Lijst',
      calculation: JSON.stringify({
        quantity: 100,
        includePersonalization: false,
        shipmentOnLocation: true,
      }),
    });
    h.prisma.company.findUnique.mockResolvedValue({ id: 1, name: 'Acme' });
    const res = await vibe.buildInvoiceLineItems(1, 2, 'onzevibe', 'full');
    expect(res.items![0].description).toBe(
      'OnzeVibe box met 200 QR muziekkaarten (geen personalisatie, levering op één locatie)'
    );
  });

  it('surfaces thrown errors', async () => {
    h.prisma.companyList.findUnique.mockRejectedValue(new Error('db sad'));
    expect(await vibe.buildInvoiceLineItems(1, 2, 'qrsong', 'full')).toMatchObject({
      success: false,
      error: 'db sad',
    });
  });
});
