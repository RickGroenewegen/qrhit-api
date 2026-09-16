import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/discount.ts covering validation and calculation
 * branches with a fake prisma client (the RDS-backed integration suites
 * cover the persistence side). Redis locking goes through a mocked cache
 * and the recaptcha check through a mocked Utils.
 */

const h = vi.hoisted(() => ({
  verifyRecaptcha: vi.fn(async () => ({ isHuman: true, score: 0.9 })),
  executeCommand: vi.fn(async () => 'OK' as any),
  calculateDigitalCardPrice: vi.fn(),
  prisma: {
    discountCode: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    discountCodedUses: {
      aggregate: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    payment: {
      findMany: vi.fn(),
    },
    playlist: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

// $transaction(fn) runs the callback against the same fake client.
h.prisma.$transaction.mockImplementation(async (fn: any) => fn(h.prisma));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prisma },
}));

vi.mock('../../../src/cache', () => ({
  default: {
    getInstance: () => ({ executeCommand: h.executeCommand }),
  },
}));

vi.mock('../../../src/utils', () => ({
  default: class {
    verifyRecaptcha = h.verifyRecaptcha;
  },
}));

vi.mock('../../../src/order', () => ({
  default: {
    getInstance: () => ({
      calculateDigitalCardPrice: h.calculateDigitalCardPrice,
    }),
  },
}));

import Discount from '../../../src/discount';

const discount = new Discount();

function setAmountUsed(amount: number | null, count = amount ? 1 : 0) {
  h.prisma.discountCodedUses.aggregate.mockResolvedValue({
    _sum: { amount },
    _count: { _all: count },
  });
}

/** A €-based order: €25 goods incl. 21%, optional shipping / add-ons. */
function makeBase(over: Partial<Record<string, number>> = {}) {
  return {
    productsGross: 25,
    addonsGross: 0,
    volumeDiscount: 0,
    shippingGross: 0,
    total: 25,
    taxRate: 21,
    taxRateShipping: 21,
    ...over,
  };
}

const fixedCode = (over: Record<string, any> = {}) => ({
  id: 7,
  code: 'V',
  type: 'fixed',
  amount: 50,
  percent: null,
  maxDiscountAmount: null,
  maxUses: null,
  oncePerCustomer: false,
  general: false,
  digital: false,
  playlistId: null,
  startDate: null,
  endDate: null,
  ...over,
});

const percentCode = (over: Record<string, any> = {}) => ({
  id: 9,
  code: 'SUMMER10',
  type: 'percent',
  amount: 0,
  percent: 10,
  maxDiscountAmount: null,
  maxUses: null,
  oncePerCustomer: false,
  general: false,
  digital: false,
  playlistId: null,
  startDate: null,
  endDate: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.$transaction.mockImplementation(async (fn: any) => fn(h.prisma));
  h.executeCommand.mockResolvedValue('OK');
  h.verifyRecaptcha.mockResolvedValue({ isHuman: true, score: 0.9 });
  h.prisma.discountCodedUses.count.mockResolvedValue(0);
  h.prisma.discountCodedUses.create.mockImplementation(async ({ data }: any) => ({
    id: 100 + Math.round(data.amount),
    ...data,
  }));
  h.prisma.discountCodedUses.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.discountCodedUses.findMany.mockResolvedValue([]);
  h.prisma.payment.findMany.mockResolvedValue([]);
  h.prisma.playlist.findFirst.mockResolvedValue(null);
  setAmountUsed(null);
});

describe('createAdminDiscountCode', () => {
  it('rejects non-positive or non-numeric amounts', async () => {
    expect(await discount.createAdminDiscountCode({ amount: 0 })).toEqual({
      success: false,
      error: 'Invalid amount',
    });
    expect(await discount.createAdminDiscountCode({ amount: -5 })).toEqual({
      success: false,
      error: 'Invalid amount',
    });
    expect(
      await discount.createAdminDiscountCode({ amount: NaN })
    ).toEqual({ success: false, error: 'Invalid amount' });
    expect(
      await discount.createAdminDiscountCode({ amount: '10' as any })
    ).toEqual({ success: false, error: 'Invalid amount' });
    expect(h.prisma.discountCode.create).not.toHaveBeenCalled();
  });

  it('uppercases manual codes and rejects duplicates', async () => {
    h.prisma.discountCode.findUnique.mockResolvedValueOnce({ id: 1 });
    const result = await discount.createAdminDiscountCode({
      amount: 10,
      code: '  promo-x ',
    });
    expect(h.prisma.discountCode.findUnique).toHaveBeenCalledWith({
      where: { code: 'PROMO-X' },
    });
    expect(result).toEqual({
      success: false,
      error: 'Discount code already exists',
    });
  });

  it('creates a manual code with normalized flags and unix-second dates', async () => {
    h.prisma.discountCode.findUnique.mockResolvedValueOnce(null);
    h.prisma.discountCode.create.mockImplementationOnce(async (args: any) => ({
      id: 2,
      ...args.data,
    }));

    const result = await discount.createAdminDiscountCode({
      amount: 25,
      code: 'summer',
      description: 'Summer sale',
      startDate: 1750000000,
      endDate: 1760000000,
      general: '1',
      digital: 1,
      playlistId: 'pl-1',
    });

    expect(result).toEqual({ success: true, code: 'SUMMER' });
    const data = h.prisma.discountCode.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      code: 'SUMMER',
      amount: 25,
      description: 'Summer sale',
      general: true,
      digital: true,
      playlistId: 'pl-1',
    });
    expect(data.startDate).toEqual(new Date(1750000000 * 1000));
    expect(data.endDate).toEqual(new Date(1760000000 * 1000));
  });

  it('generates a XXXX-XXXX-XXXX-XXXX code when none is provided', async () => {
    h.prisma.discountCode.create.mockImplementationOnce(async (args: any) => ({
      id: 3,
      ...args.data,
    }));

    const result = await discount.createAdminDiscountCode({ amount: 5 });
    expect(result.success).toBe(true);
    expect(result.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    // No duplicate lookup for generated codes
    expect(h.prisma.discountCode.findUnique).not.toHaveBeenCalled();
    const data = h.prisma.discountCode.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      general: false,
      digital: false,
      description: null,
      startDate: null,
      endDate: null,
      playlistId: null,
    });
  });

  it('maps database failures to a generic error', async () => {
    h.prisma.discountCode.create.mockRejectedValueOnce(new Error('boom'));
    expect(await discount.createAdminDiscountCode({ amount: 5 })).toEqual({
      success: false,
      error: 'Failed to create discount code',
    });
  });
});

describe('updateDiscountCode', () => {
  it('rejects invalid amounts', async () => {
    expect(await discount.updateDiscountCode(1, { amount: 0 })).toEqual({
      success: false,
      error: 'Invalid amount',
    });
  });

  it('rejects a new code that belongs to a different discount', async () => {
    h.prisma.discountCode.findUnique.mockResolvedValueOnce({ id: 99 });
    const result = await discount.updateDiscountCode(1, {
      amount: 10,
      code: 'taken',
    });
    expect(result).toEqual({
      success: false,
      error: 'Discount code already exists',
    });
    expect(h.prisma.discountCode.update).not.toHaveBeenCalled();
  });

  it('allows keeping the same code on the same discount', async () => {
    h.prisma.discountCode.findUnique.mockResolvedValueOnce({ id: 1 });
    h.prisma.discountCode.update.mockResolvedValueOnce({ code: 'SAME' });
    const result = await discount.updateDiscountCode(1, {
      amount: 10,
      code: 'same',
    });
    expect(result).toEqual({ success: true, code: 'SAME' });
    expect(h.prisma.discountCode.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({ code: 'SAME', amount: 10 }),
    });
  });
});

describe('getAllDiscounts / deleteDiscountCode', () => {
  it('annotates each discount with totalSpent and amountLeft', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([
      { id: 1, amount: 50 },
      { id: 2, amount: 20 },
    ]);
    h.prisma.discountCodedUses.aggregate
      .mockResolvedValueOnce({ _sum: { amount: 12.5 } })
      .mockResolvedValueOnce({ _sum: { amount: null } });

    const result = await discount.getAllDiscounts();
    expect(result.success).toBe(true);
    expect(result.discounts).toEqual([
      { id: 1, amount: 50, totalSpent: 12.5, amountLeft: 37.5, usesCount: 0 },
      { id: 2, amount: 20, totalSpent: 0, amountLeft: 20, usesCount: 0 },
    ]);
  });

  it('reports delete failures without throwing', async () => {
    h.prisma.discountCode.delete.mockRejectedValueOnce(new Error('missing'));
    expect(await discount.deleteDiscountCode(1)).toEqual({
      success: false,
      error: 'Failed to delete discount code',
    });
  });
});

describe('searchDiscounts', () => {
  it('builds OR text search and type filter, returns pagination metadata', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([{ id: 1, amount: 10 }]);
    h.prisma.discountCode.count.mockResolvedValueOnce(25);
    setAmountUsed(0);

    const result = await discount.searchDiscounts({
      searchTerm: ' gift ',
      filter: 'digital',
      page: 2,
      limit: 10,
    });

    expect(h.prisma.discountCode.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { code: { contains: 'gift' } },
          { description: { contains: 'gift' } },
        ],
        digital: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: 10,
      take: 10,
    });
    expect(result).toMatchObject({
      success: true,
      total: 25,
      page: 2,
      totalPages: 3,
    });
  });

  it('filters by balance state across the full result set and repaginates', async () => {
    // Balance filtering needs the full result set, so only one (unpaged)
    // query is made.
    h.prisma.discountCode.findMany.mockResolvedValueOnce([
      { id: 1, amount: 10 }, // unused
      { id: 2, amount: 10 }, // partially used
      { id: 3, amount: 10 }, // exhausted
      { id: 4, type: 'percent', amount: 0, maxUses: 4 }, // 2 of 4 uses
    ]);
    h.prisma.discountCodedUses.aggregate
      .mockResolvedValueOnce({ _sum: { amount: null }, _count: { _all: 0 } })
      .mockResolvedValueOnce({ _sum: { amount: 4 }, _count: { _all: 1 } })
      .mockResolvedValueOnce({ _sum: { amount: 10 }, _count: { _all: 1 } })
      .mockResolvedValueOnce({ _sum: { amount: 5 }, _count: { _all: 2 } });

    const result = await discount.searchDiscounts({
      balanceFilter: 'partial',
      page: 1,
      limit: 12,
    });

    expect(result.success).toBe(true);
    expect(result.total).toBe(2);
    expect(result.discounts).toEqual([
      { id: 2, amount: 10, totalSpent: 4, amountLeft: 6, usesCount: 1 },
      {
        id: 4,
        type: 'percent',
        amount: 0,
        maxUses: 4,
        totalSpent: 5,
        amountLeft: -5,
        usesCount: 2,
      },
    ]);
    expect(result.totalPages).toBe(1);
    expect(h.prisma.discountCode.count).not.toHaveBeenCalled();
  });

  it('filters percent codes by type', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([]);
    h.prisma.discountCode.count.mockResolvedValueOnce(0);
    await discount.searchDiscounts({ filter: 'percent' });
    expect(h.prisma.discountCode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { type: 'percent' } })
    );
  });
});

describe('checkDiscount', () => {
  const baseDiscount = {
    id: 7,
    code: 'CODE',
    amount: 50,
    digital: false,
    startDate: null,
    endDate: null,
  };

  it('reports a recaptcha failure instead of throwing', async () => {
    // Throwing escaped the route (which has no try/catch) as a raw 500, and
    // verifyRecaptcha fails closed — so an unreachable Google turned every
    // coupon attempt into an opaque error.
    h.verifyRecaptcha.mockResolvedValueOnce({ isHuman: false, score: 0.1 });
    expect(await discount.checkDiscount('CODE', 'tok', false)).toEqual({
      success: false,
      message: 'recaptchaFailed',
    });
    expect(h.prisma.discountCode.findUnique).not.toHaveBeenCalled();
  });

  it('reports unknown codes', async () => {
    h.prisma.discountCode.findUnique.mockResolvedValueOnce(null);
    expect(await discount.checkDiscount('NOPE', 'tok', false)).toEqual({
      success: false,
      message: 'discountCodeNotFound',
    });
  });

  it('blocks digital-only codes on physical orders', async () => {
    h.prisma.discountCode.findUnique.mockResolvedValueOnce({
      ...baseDiscount,
      digital: true,
    });
    expect(await discount.checkDiscount('CODE', 'tok', false)).toEqual({
      success: false,
      message: 'notApplicableForRealOrders',
    });
  });

  it('rejects codes outside their validity window', async () => {
    const future = new Date(Date.now() + 86400000);
    h.prisma.discountCode.findUnique.mockResolvedValueOnce({
      ...baseDiscount,
      startDate: future,
    });
    expect(await discount.checkDiscount('CODE', 'tok', false)).toEqual({
      success: false,
      message: 'discountNotActive',
    });

    const past = new Date(Date.now() - 86400000);
    h.prisma.discountCode.findUnique.mockResolvedValueOnce({
      ...baseDiscount,
      endDate: past,
    });
    expect(await discount.checkDiscount('CODE', 'tok', false)).toEqual({
      success: false,
      message: 'discountNotActive',
    });
  });

  it('reports exhausted codes with the rounded remaining amount', async () => {
    h.prisma.discountCode.findUnique.mockResolvedValueOnce(baseDiscount);
    setAmountUsed(50.001);
    expect(await discount.checkDiscount('CODE', 'tok', false)).toEqual({
      success: false,
      message: 'discountCodeExhausted',
      fullAmount: 50,
      amountLeft: -0,
    });
  });

  it('returns the remaining balance for a valid code', async () => {
    h.prisma.discountCode.findUnique.mockResolvedValueOnce(baseDiscount);
    setAmountUsed(12.5);
    expect(await discount.checkDiscount('CODE', 'tok', true)).toEqual({
      success: true,
      kind: 'fixed',
      percent: null,
      label: 'CODE',
      fullAmount: 50,
      amountLeft: 37.5,
    });
  });

  it('upper-cases and trims the code before the lookup', async () => {
    h.prisma.discountCode.findUnique.mockResolvedValueOnce(null);
    await discount.checkDiscount('  code ', 'tok', false);
    expect(h.prisma.discountCode.findUnique).toHaveBeenCalledWith({
      where: { code: 'CODE' },
    });
  });

  it('describes a percent code in the legacy (cart-less) check', async () => {
    h.prisma.discountCode.findUnique.mockResolvedValueOnce(percentCode());
    setAmountUsed(null);
    expect(await discount.checkDiscount('SUMMER10', 'tok', false)).toMatchObject({
      success: true,
      kind: 'percent',
      percent: 10,
      label: 'SUMMER10 (10%)',
    });
  });

  it('evaluates the whole cart when one is supplied', async () => {
    // Order calculation fails → falls back to the plain item total (25).
    h.prisma.discountCode.findMany.mockResolvedValueOnce([percentCode()]);
    const result = await discount.checkDiscount('summer10', 'tok', false, {
      cart: { items: [{ price: 25, amount: 1, type: 'physical' }], discounts: [] },
      countrycode: 'NL',
    });
    expect(result).toMatchObject({
      success: true,
      kind: 'percent',
      percent: 10,
      amount: 2.5,
      label: 'SUMMER10 (10%)',
    });
    // Check mode never writes a reservation.
    expect(h.prisma.discountCodedUses.create).not.toHaveBeenCalled();
  });
});

describe('evaluateDiscounts', () => {
  const cartWith = (...codes: string[]) => ({
    items: [{ playlistId: 'pl', type: 'physical', productType: 'cards', price: 25, amount: 1 }],
    discounts: codes.map((code) => ({ code, amountLeft: 9999 })),
  });

  it('returns an empty, ok evaluation for a cart without codes', async () => {
    const ev = await discount.evaluateDiscounts({ items: [] }, makeBase(), {}, 'redeem');
    expect(ev).toMatchObject({ ok: true, totalDiscount: 0, remainingTotal: 25 });
    expect(h.executeCommand).not.toHaveBeenCalled();
  });

  it('bails out when the Redis lock is already held (redeem only)', async () => {
    h.executeCommand.mockResolvedValueOnce(null);
    const ev = await discount.evaluateDiscounts(cartWith('V'), makeBase(), {}, 'redeem');
    expect(ev.ok).toBe(false);
    expect(ev.failed).toEqual([{ code: 'V', message: 'discountCodeInUse' }]);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.executeCommand).toHaveBeenCalledTimes(1);
  });

  it('locks every code in sorted order and releases the locks afterwards', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([
      fixedCode({ id: 1, code: 'B' }),
      fixedCode({ id: 2, code: 'A', amount: 5 }),
    ]);
    await discount.evaluateDiscounts(cartWith('B', 'A'), makeBase(), {}, 'redeem');
    expect(h.executeCommand).toHaveBeenNthCalledWith(1, 'set', 'lock:discount:A', 'locked', 'NX', 'PX', 5000);
    expect(h.executeCommand).toHaveBeenNthCalledWith(2, 'set', 'lock:discount:B', 'locked', 'NX', 'PX', 5000);
    expect(h.executeCommand).toHaveBeenCalledWith('del', 'lock:discount:A');
    expect(h.executeCommand).toHaveBeenLastCalledWith('del', 'lock:discount:B');
  });

  it('check mode neither locks nor writes', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([fixedCode()]);
    const ev = await discount.evaluateDiscounts(cartWith('V'), makeBase(), {}, 'check');
    expect(ev.ok).toBe(true);
    expect(ev.totalDiscount).toBe(25);
    expect(h.executeCommand).not.toHaveBeenCalled();
    expect(h.prisma.discountCodedUses.create).not.toHaveBeenCalled();
    expect(ev.discountUseIds).toEqual([]);
  });

  it('ignores the client-sent amountLeft and uses the live balance', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([fixedCode({ amount: 50 })]);
    setAmountUsed(45); // €5 left in the DB, client claims 9999
    const ev = await discount.evaluateDiscounts(cartWith('V'), makeBase(), {}, 'redeem');
    expect(ev.ok).toBe(true);
    expect(ev.applied[0]).toMatchObject({
      code: 'V',
      kind: 'fixed',
      amount: 5,
      fullAmount: 50,
      amountLeft: 5,
      amountLeftAfter: 0,
    });
    expect(ev.remainingTotal).toBe(20);
  });

  it('writes a reserved row per applied code with the customer email and a TTL', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([fixedCode({ amount: 50 })]);
    setAmountUsed(10);
    const ev = await discount.evaluateDiscounts(
      cartWith('V'),
      makeBase(),
      { email: ' Buyer@Example.com ' },
      'redeem'
    );
    expect(ev.ok).toBe(true);
    const data = h.prisma.discountCodedUses.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      amount: 25,
      discountCodeId: 7,
      email: 'buyer@example.com',
      status: 'reserved',
    });
    expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
    expect(ev.discountUseIds).toEqual([125]);
  });

  it('counts only paid rows and unexpired reservations as live usage', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([fixedCode()]);
    await discount.evaluateDiscounts(cartWith('V'), makeBase(), {}, 'check');
    const where = h.prisma.discountCodedUses.aggregate.mock.calls[0][0].where;
    expect(where.discountCodeId).toBe(7);
    expect(where.OR[0]).toEqual({ status: 'paid' });
    expect(where.OR[1]).toMatchObject({ status: 'reserved' });
    expect(where.OR[1].expiresAt.gt).toBeInstanceOf(Date);
  });

  it('reports an exhausted voucher', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([fixedCode({ amount: 50 })]);
    setAmountUsed(50);
    const ev = await discount.evaluateDiscounts(cartWith('V'), makeBase(), {}, 'redeem');
    expect(ev.ok).toBe(false);
    expect(ev.failed).toEqual([
      { code: 'V', message: 'discountCodeExhausted', fullAmount: 50, amountLeft: 0 },
    ]);
    expect(h.prisma.discountCodedUses.create).not.toHaveBeenCalled();
  });

  it('refuses every code when the cart holds a gift card', async () => {
    const cart = { items: [{ productType: 'giftcard' }], discounts: [{ code: 'V' }] };
    const ev = await discount.evaluateDiscounts(cart, makeBase(), {}, 'check');
    expect(ev.failed).toEqual([{ code: 'V', message: 'cannotAddDiscountWithGiftcard' }]);
  });

  it('reports unknown and inactive codes', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([
      fixedCode({ code: 'OLD', endDate: new Date(Date.now() - 86400000) }),
    ]);
    const ev = await discount.evaluateDiscounts(cartWith('OLD', 'NOPE'), makeBase(), {}, 'check');
    expect(ev.failed).toEqual([
      { code: 'OLD', message: 'discountNotActive' },
      { code: 'NOPE', message: 'discountCodeNotFound' },
    ]);
  });

  it('applies the digital-only rule to every kind of code', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([percentCode({ digital: true })]);
    const ev = await discount.evaluateDiscounts(cartWith('SUMMER10'), makeBase(), {}, 'check');
    expect(ev.failed).toEqual([{ code: 'SUMMER10', message: 'notApplicableForRealOrders' }]);
  });

  it('scopes playlist-bound codes to the matching single-item cart (slug lookup)', async () => {
    h.prisma.discountCode.findMany.mockResolvedValue([
      fixedCode({ general: true, playlistId: 'spotify-pl-1' }),
    ]);
    h.prisma.playlist.findFirst.mockResolvedValueOnce({ playlistId: 'spotify-pl-1' });

    const ok = await discount.evaluateDiscounts(
      { items: [{ playlistId: 'party-mix', type: 'physical' }], discounts: [{ code: 'V' }] },
      makeBase(),
      {},
      'redeem'
    );
    expect(h.prisma.playlist.findFirst).toHaveBeenCalledWith({ where: { slug: 'party-mix' } });
    expect(ok.ok).toBe(true);
    // General codes are not balance-limited but still get a usage row.
    expect(ok.applied[0]).toMatchObject({ amount: 25, amountLeft: null });
    expect(h.prisma.discountCodedUses.create).toHaveBeenCalledTimes(1);

    const wrong = await discount.evaluateDiscounts(
      { items: [{ playlistId: 'other', type: 'physical' }], discounts: [{ code: 'V' }] },
      makeBase(),
      {},
      'check'
    );
    expect(wrong.failed).toEqual([{ code: 'V', message: 'notApplicable' }]);

    const multi = await discount.evaluateDiscounts(
      { items: [{}, {}], discounts: [{ code: 'V' }] },
      makeBase(),
      {},
      'check'
    );
    expect(multi.failed).toEqual([{ code: 'V', message: 'notApplicable' }]);
  });

  it('takes the percent off products + add-ons only, never shipping', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([percentCode()]);
    const ev = await discount.evaluateDiscounts(
      cartWith('SUMMER10'),
      makeBase({ productsGross: 25, addonsGross: 10, shippingGross: 2.99, total: 37.99 }),
      {},
      'check'
    );
    expect(ev.applied[0]).toMatchObject({ kind: 'percent', percent: 10, amount: 3.5 });
    expect(ev.percentDiscount).toBe(3.5);
    expect(ev.remainingTotal).toBe(34.49);
  });

  it('caps a percent code at its maximum EUR amount', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([
      percentCode({ percent: 50, maxDiscountAmount: 5 }),
    ]);
    const ev = await discount.evaluateDiscounts(cartWith('SUMMER10'), makeBase(), {}, 'check');
    expect(ev.applied[0].amount).toBe(5);
  });

  it('allows only one percent code per order', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([
      percentCode(),
      percentCode({ id: 10, code: 'WINTER20', percent: 20 }),
    ]);
    const ev = await discount.evaluateDiscounts(
      cartWith('SUMMER10', 'WINTER20'),
      makeBase(),
      {},
      'check'
    );
    expect(ev.failed).toEqual([{ code: 'WINTER20', message: 'onlyOnePercentCode' }]);
  });

  it('applies the percent code first, then vouchers on the remainder', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([
      fixedCode({ id: 7, code: 'GIFT', amount: 5 }),
      percentCode(),
    ]);
    const ev = await discount.evaluateDiscounts(
      cartWith('GIFT', 'SUMMER10'),
      makeBase({ shippingGross: 2.99, total: 27.99 }),
      {},
      'redeem'
    );
    expect(ev.ok).toBe(true);
    expect(ev.applied.map((a) => [a.code, a.amount])).toEqual([
      ['SUMMER10', 2.5],
      ['GIFT', 5],
    ]);
    expect(ev).toMatchObject({ percentDiscount: 2.5, fixedDiscount: 5, totalDiscount: 7.5, remainingTotal: 20.49 });
    expect(h.prisma.discountCodedUses.create).toHaveBeenCalledTimes(2);
  });

  it('enforces maxUses and once-per-customer', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([percentCode({ maxUses: 3 })]);
    setAmountUsed(0, 3);
    const full = await discount.evaluateDiscounts(cartWith('SUMMER10'), makeBase(), {}, 'check');
    expect(full.failed).toEqual([{ code: 'SUMMER10', message: 'discountCodeMaxUsesReached' }]);

    h.prisma.discountCode.findMany.mockResolvedValueOnce([percentCode({ oncePerCustomer: true })]);
    setAmountUsed(0, 0);
    h.prisma.discountCodedUses.count.mockResolvedValueOnce(1);
    const again = await discount.evaluateDiscounts(
      cartWith('SUMMER10'),
      makeBase(),
      { email: 'buyer@example.com' },
      'check'
    );
    expect(again.failed).toEqual([{ code: 'SUMMER10', message: 'discountCodeAlreadyUsedByCustomer' }]);
    expect(h.prisma.discountCodedUses.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ discountCodeId: 9, email: 'buyer@example.com' }),
    });

    // Without an email (cart stage) the per-customer rule cannot run yet.
    h.prisma.discountCode.findMany.mockResolvedValueOnce([percentCode({ oncePerCustomer: true })]);
    const anon = await discount.evaluateDiscounts(cartWith('SUMMER10'), makeBase(), {}, 'check');
    expect(anon.ok).toBe(true);
  });

  it('writes nothing when any code fails, even in redeem mode', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([fixedCode()]);
    const ev = await discount.evaluateDiscounts(cartWith('V', 'NOPE'), makeBase(), {}, 'redeem');
    expect(ev.ok).toBe(false);
    expect(ev.applied).toHaveLength(1);
    expect(h.prisma.discountCodedUses.create).not.toHaveBeenCalled();
    expect(ev.discountUseIds).toEqual([]);
  });

  it('clamps the total discount at the order total', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([
      fixedCode({ id: 1, code: 'A', amount: 20 }),
      fixedCode({ id: 2, code: 'B', amount: 20 }),
    ]);
    const ev = await discount.evaluateDiscounts(cartWith('A', 'B'), makeBase(), {}, 'check');
    expect(ev.applied.map((a) => a.amount)).toEqual([20, 5]);
    expect(ev.totalDiscount).toBe(25);
    expect(ev.remainingTotal).toBe(0);
  });
});

describe('calculateDiscounts', () => {
  const calc = { total: 25, price: '20.66', payment: '0.00', taxRate: 21, taxRateShipping: 21, boxFee: 0 };

  it('returns zeros when the cart has no discounts', async () => {
    expect(await discount.calculateDiscounts({ items: [] }, calc)).toEqual({
      discountAmount: 0,
      discountUseIds: [],
      discountUsed: false,
      percentAmount: 0,
      percent: null,
      label: '',
    });
  });

  it('reserves and summarises the applied codes', async () => {
    h.prisma.discountCode.findMany.mockResolvedValueOnce([percentCode(), fixedCode({ code: 'GIFT', amount: 5 })]);
    const result = await discount.calculateDiscounts(
      { items: [{ type: 'physical' }], discounts: [{ code: 'summer10' }, { code: 'gift' }] },
      calc,
      'buyer@example.com'
    );
    expect(result).toEqual({
      discountAmount: 7.5,
      discountUseIds: [103, 105],
      discountUsed: true,
      percentAmount: 2.5,
      percent: 10,
      label: 'SUMMER10 (10%), GIFT',
    });
  });

  it('throws DiscountApplyError naming the first code that cannot be applied', async () => {
    const { DiscountApplyError } = await import('../../../src/discount');
    h.prisma.discountCode.findMany.mockResolvedValueOnce([fixedCode()]);
    setAmountUsed(50);
    await expect(
      discount.calculateDiscounts({ items: [{}], discounts: [{ code: 'V' }] }, calc)
    ).rejects.toMatchObject(
      Object.assign(new DiscountApplyError('V', 'discountCodeExhausted'), {})
    );
    expect(h.prisma.discountCodedUses.create).not.toHaveBeenCalled();
  });
});

describe('reservation lifecycle', () => {
  it('attaches, confirms and releases rows by payment', async () => {
    await discount.attachPaymentToDiscountUses([1, 2], 55);
    expect(h.prisma.discountCodedUses.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [1, 2] } },
      data: { paymentId: 55 },
    });

    await discount.confirmDiscountUsesByIds([1], 55);
    expect(h.prisma.discountCodedUses.updateMany).toHaveBeenLastCalledWith({
      where: { id: { in: [1] } },
      data: { paymentId: 55, status: 'paid', expiresAt: null },
    });

    await discount.attachPaymentToDiscountUses([], 55);
    expect(h.prisma.discountCodedUses.updateMany).toHaveBeenCalledTimes(2);

    h.prisma.discountCodedUses.updateMany.mockResolvedValueOnce({ count: 2 });
    expect(await discount.releaseDiscountUsesByPaymentId(55)).toMatchObject({ success: true, count: 2 });
    expect(h.prisma.discountCodedUses.updateMany).toHaveBeenLastCalledWith({
      where: { paymentId: 55, status: { not: 'released' } },
      data: { status: 'released' },
    });
  });

  it('confirming a paid payment re-settles released rows and reports shortfalls', async () => {
    h.prisma.discountCodedUses.findMany.mockResolvedValueOnce([
      { id: 1, discountCodeId: 7 },
    ]);
    h.prisma.discountCode.findUnique.mockResolvedValueOnce(fixedCode({ amount: 50 }));
    setAmountUsed(60);
    const result = await discount.confirmDiscountUsesByPaymentId(55);
    expect(h.prisma.discountCodedUses.updateMany).toHaveBeenCalledWith({
      where: { paymentId: 55, status: { not: 'paid' } },
      data: { status: 'paid', expiresAt: null },
    });
    expect(result.shortfalls).toEqual([{ code: 'V', over: 10 }]);
  });

  it('supersedes the customer\'s open payments that hold the same codes', async () => {
    h.prisma.payment.findMany.mockResolvedValueOnce([
      { id: 8, paymentId: 'tr_old' },
    ]);
    const result = await discount.supersedeOpenReservations('buyer@example.com', ['V']);
    expect(h.prisma.payment.findMany.mock.calls[0][0].where).toMatchObject({
      email: 'buyer@example.com',
      status: { in: ['open', 'pending', 'authorized'] },
    });
    expect(h.prisma.discountCodedUses.updateMany).toHaveBeenCalledWith({
      where: { paymentId: { in: [8] }, status: 'reserved' },
      data: { status: 'released' },
    });
    expect(result).toEqual({ paymentIds: ['tr_old'] });

    expect(await discount.supersedeOpenReservations('', ['V'])).toEqual({ paymentIds: [] });
  });

  it('sweeps expired reservations', async () => {
    h.prisma.discountCodedUses.updateMany.mockResolvedValueOnce({ count: 3 });
    expect(await discount.sweepExpiredReservations(new Date(0))).toBe(3);
    expect(h.prisma.discountCodedUses.updateMany).toHaveBeenCalledWith({
      where: { status: 'reserved', expiresAt: { lt: new Date(0) } },
      data: { status: 'released' },
    });
  });
});

describe('aggregate helpers', () => {
  it('calculateTotalDiscountForPayment sums uses, defaulting to 0', async () => {
    setAmountUsed(17.5);
    expect(await discount.calculateTotalDiscountForPayment(4)).toBe(17.5);
    expect(h.prisma.discountCodedUses.aggregate).toHaveBeenCalledWith({
      where: { paymentId: 4, status: { not: 'released' } },
      _sum: { amount: true },
    });

    setAmountUsed(null);
    expect(await discount.calculateTotalDiscountForPayment(4)).toBe(0);
  });

  it('removeDiscountUsesByPaymentId deletes by payment and reports status', async () => {
    h.prisma.discountCodedUses.deleteMany.mockResolvedValueOnce({ count: 2 });
    expect(await discount.removeDiscountUsesByPaymentId(4)).toEqual({
      success: true,
      message: 'discountUsesRemovedSuccessfully',
    });

    h.prisma.discountCodedUses.deleteMany.mockRejectedValueOnce(new Error('x'));
    const failed = await discount.removeDiscountUsesByPaymentId(4);
    expect(failed.success).toBe(false);
    expect(failed.message).toBe('errorRemovingDiscountUses');
  });

  it('getDiscountDetails returns selected fields or not-found', async () => {
    h.prisma.discountCode.findUnique.mockResolvedValueOnce({
      id: 1,
      code: 'C',
      amount: 10,
      description: null,
      from: 'Alice',
      message: 'Happy birthday',
    });
    expect(await discount.getDiscountDetails('C')).toMatchObject({
      success: true,
      code: 'C',
      from: 'Alice',
    });

    h.prisma.discountCode.findUnique.mockResolvedValueOnce(null);
    expect(await discount.getDiscountDetails('X')).toEqual({
      success: false,
      message: 'discountCodeNotFound',
    });
  });
});

describe('createDiscountCode (gift voucher)', () => {
  it('creates a code with sender metadata and returns id + code', async () => {
    h.prisma.discountCode.create.mockImplementationOnce(async (args: any) => ({
      id: 12,
      ...args.data,
    }));
    const result = await discount.createDiscountCode(25, 'Bob', 'Enjoy!');
    expect(result.id).toBe(12);
    expect(result.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(h.prisma.discountCode.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 25, from: 'Bob', message: 'Enjoy!' }),
    });
  });

  it('throws on database failure', async () => {
    h.prisma.discountCode.create.mockRejectedValueOnce(new Error('db'));
    await expect(discount.createDiscountCode(25, 'B', 'M')).rejects.toThrow(
      'Failed to create discount code'
    );
  });
});

describe('calculateVolumeDiscount', () => {
  it('returns 0 for fewer than 2 digital card playlists', async () => {
    const cart = {
      items: [
        { type: 'digital', productType: 'cards', numberOfTracks: 100, price: 13, amount: 1 },
        { type: 'physical', productType: 'cards', numberOfTracks: 100, price: 30, amount: 1 },
      ],
    };
    expect(await discount.calculateVolumeDiscount(cart)).toBe(0);
    expect(h.calculateDigitalCardPrice).not.toHaveBeenCalled();
  });

  it('returns the gap between individually priced and volume pricing', async () => {
    h.calculateDigitalCardPrice.mockResolvedValueOnce({ totalPrice: 20.5 });
    const cart = {
      items: [
        { type: 'digital', productType: 'cards', numberOfTracks: '100', price: 13, amount: 1 },
        { type: 'digital', productType: 'cards', numberOfTracks: '150', price: 13, amount: 1 },
      ],
    };
    const result = await discount.calculateVolumeDiscount(cart);
    expect(h.calculateDigitalCardPrice).toHaveBeenCalledWith(13, 250);
    expect(result).toBe(5.5); // 26 - 20.50
  });

  it('never returns a negative discount', async () => {
    h.calculateDigitalCardPrice.mockResolvedValueOnce({ totalPrice: 99 });
    const cart = {
      items: [
        { type: 'digital', productType: 'cards', numberOfTracks: 10, price: 13, amount: 1 },
        { type: 'digital', productType: 'cards', numberOfTracks: 10, price: 13, amount: 1 },
      ],
    };
    expect(await discount.calculateVolumeDiscount(cart)).toBe(0);
  });
});
