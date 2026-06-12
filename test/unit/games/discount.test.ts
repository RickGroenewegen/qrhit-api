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
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
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

function setAmountUsed(amount: number | null) {
  h.prisma.discountCodedUses.aggregate.mockResolvedValue({
    _sum: { amount },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.$transaction.mockImplementation(async (fn: any) => fn(h.prisma));
  h.executeCommand.mockResolvedValue('OK');
  h.verifyRecaptcha.mockResolvedValue({ isHuman: true, score: 0.9 });
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
      { id: 1, amount: 50, totalSpent: 12.5, amountLeft: 37.5 },
      { id: 2, amount: 20, totalSpent: 0, amountLeft: 20 },
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
    // First (paged) query
    h.prisma.discountCode.findMany.mockResolvedValueOnce([]);
    h.prisma.discountCode.count.mockResolvedValueOnce(3);
    // Second (full) query for balance filtering
    h.prisma.discountCode.findMany.mockResolvedValueOnce([
      { id: 1, amount: 10 }, // unused
      { id: 2, amount: 10 }, // partially used
      { id: 3, amount: 10 }, // exhausted
    ]);
    h.prisma.discountCodedUses.aggregate
      .mockResolvedValueOnce({ _sum: { amount: null } })
      .mockResolvedValueOnce({ _sum: { amount: 4 } })
      .mockResolvedValueOnce({ _sum: { amount: 10 } });

    const result = await discount.searchDiscounts({
      balanceFilter: 'partial',
      page: 1,
      limit: 12,
    });

    expect(result.success).toBe(true);
    expect(result.total).toBe(1);
    expect(result.discounts).toEqual([
      { id: 2, amount: 10, totalSpent: 4, amountLeft: 6 },
    ]);
    expect(result.totalPages).toBe(1);
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

  it('throws when recaptcha says bot', async () => {
    h.verifyRecaptcha.mockResolvedValueOnce({ isHuman: false, score: 0.1 });
    await expect(discount.checkDiscount('CODE', 'tok', false)).rejects.toThrow(
      'Request failed'
    );
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
      fullAmount: 50,
      amountLeft: 37.5,
    });
  });
});

describe('redeemDiscount', () => {
  const voucher = {
    id: 7,
    code: 'V',
    amount: 50,
    general: false,
    digital: false,
    playlistId: null,
    startDate: null,
    endDate: null,
  };

  it('bails out when the Redis lock is already held', async () => {
    h.executeCommand.mockResolvedValueOnce(null);
    const result = await discount.redeemDiscount('V', 10, { items: [] });
    expect(result).toEqual({ success: false, message: 'discountCodeInUse' });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    // No release for a lock that was never acquired
    expect(h.executeCommand).toHaveBeenCalledTimes(1);
  });

  it('acquires and releases the per-code lock around the transaction', async () => {
    h.prisma.discountCode.findUnique.mockResolvedValueOnce(null);
    await discount.redeemDiscount('V', 10, { items: [] });

    expect(h.executeCommand).toHaveBeenNthCalledWith(
      1,
      'set',
      'lock:discount:V',
      'locked',
      'NX',
      'PX',
      5000
    );
    expect(h.executeCommand).toHaveBeenLastCalledWith('del', 'lock:discount:V');
  });

  it('rejects redemption above the remaining balance for voucher codes', async () => {
    h.prisma.discountCode.findUnique.mockResolvedValueOnce(voucher);
    setAmountUsed(45);
    const result = await discount.redeemDiscount('V', 10, { items: [] });
    expect(result).toEqual({
      success: false,
      message: 'insufficientDiscountAmountLeft',
      fullAmount: 50,
      amountLeft: 5,
    });
    expect(h.prisma.discountCodedUses.create).not.toHaveBeenCalled();
  });

  it('records a discount use and returns the new balance for vouchers', async () => {
    h.prisma.discountCode.findUnique.mockResolvedValueOnce(voucher);
    setAmountUsed(10);
    h.prisma.discountCodedUses.create.mockResolvedValueOnce({ id: 33 });

    const result = await discount.redeemDiscount('V', 15.5, { items: [] });
    expect(h.prisma.discountCodedUses.create).toHaveBeenCalledWith({
      data: { amount: 15.5, discountCodeId: 7 },
    });
    expect(result).toEqual({
      success: true,
      message: 'discountRedeemedSuccessfully',
      fullAmount: 50,
      amountLeft: 24.5, // 40 remaining - 15.50 redeemed
      discountUseId: 33,
    });
  });

  it('redeems a general playlist-bound code for the matching single-item cart', async () => {
    const general = {
      ...voucher,
      general: true,
      digital: true,
      playlistId: 'spotify-pl-1',
    };
    h.prisma.discountCode.findUnique.mockResolvedValueOnce(general);
    setAmountUsed(0);
    // Cart references the playlist by slug; DB lookup maps it to the real id
    h.prisma.playlist.findFirst.mockResolvedValueOnce({
      playlistId: 'spotify-pl-1',
    });

    const result = await discount.redeemDiscount('V', 12, {
      items: [{ playlistId: 'party-mix', type: 'digital' }],
    });

    expect(h.prisma.playlist.findFirst).toHaveBeenCalledWith({
      where: { slug: 'party-mix' },
    });
    expect(result).toMatchObject({
      success: true,
      message: 'discountRedeemedSuccessfully',
      discountUseId: 0,
    });
    // General codes never write a discountCodedUses row
    expect(h.prisma.discountCodedUses.create).not.toHaveBeenCalled();
  });

  it('rejects a general code when playlist or order type does not match', async () => {
    const general = {
      ...voucher,
      general: true,
      digital: true,
      playlistId: 'spotify-pl-1',
    };
    h.prisma.discountCode.findUnique.mockResolvedValueOnce(general);
    setAmountUsed(0);
    h.prisma.playlist.findFirst.mockResolvedValueOnce(null);

    const result = await discount.redeemDiscount('V', 12, {
      items: [{ playlistId: 'other-pl', type: 'physical' }],
    });
    expect(result).toMatchObject({ success: false, message: 'notApplicable' });
  });

  it('returns undefined for a general code with a multi-item cart (suspected bug: missing return path)', async () => {
    const general = { ...voucher, general: true };
    h.prisma.discountCode.findUnique.mockResolvedValueOnce(general);
    setAmountUsed(0);

    const result = await discount.redeemDiscount('V', 12, {
      items: [{}, {}],
    });
    // Documents current (buggy) behavior: the transaction callback has no
    // return statement for this branch, so callers receive undefined.
    expect(result).toBeUndefined();
  });
});

describe('calculateDiscounts', () => {
  it('returns zeros when the cart has no discounts', async () => {
    expect(await discount.calculateDiscounts({ items: [] }, 100)).toEqual({
      discountAmount: 0,
      discountUseIds: [],
      discountUsed: false,
    });
  });

  it('redeems codes sequentially, capping at the remaining total', async () => {
    const spy = vi
      .spyOn(discount, 'redeemDiscount')
      .mockResolvedValueOnce({ success: true, discountUseId: 1 })
      .mockResolvedValueOnce({ success: true, discountUseId: 2 });

    const cart = {
      items: [],
      discounts: [
        { code: 'A', amountLeft: 30 },
        { code: 'B', amountLeft: 100 },
      ],
    };

    const result = await discount.calculateDiscounts(cart, 50);
    expect(spy).toHaveBeenNthCalledWith(1, 'A', 30, cart);
    // Only 20 left after the first code
    expect(spy).toHaveBeenNthCalledWith(2, 'B', 20, cart);
    expect(result).toEqual({
      discountAmount: 50,
      discountUseIds: [1, 2],
      discountUsed: true,
    });
    spy.mockRestore();
  });

  it('skips failed redemptions without aborting the rest', async () => {
    const spy = vi
      .spyOn(discount, 'redeemDiscount')
      .mockResolvedValueOnce({ success: false, message: 'nope' })
      .mockResolvedValueOnce({ success: true, discountUseId: 9 });

    const result = await discount.calculateDiscounts(
      {
        items: [],
        discounts: [
          { code: 'BAD', amountLeft: 10 },
          { code: 'GOOD', amountLeft: 10 },
        ],
      },
      40
    );
    expect(result).toEqual({
      discountAmount: 10,
      discountUseIds: [9],
      discountUsed: true,
    });
    spy.mockRestore();
  });
});

describe('aggregate helpers', () => {
  it('calculateTotalDiscountForPayment sums uses, defaulting to 0', async () => {
    setAmountUsed(17.5);
    expect(await discount.calculateTotalDiscountForPayment(4)).toBe(17.5);
    expect(h.prisma.discountCodedUses.aggregate).toHaveBeenCalledWith({
      where: { paymentId: 4 },
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

  it('associatePaymentWithDiscountUse links the use to the payment', async () => {
    h.prisma.discountCodedUses.update.mockResolvedValueOnce({});
    expect(await discount.associatePaymentWithDiscountUse(33, 4)).toEqual({
      success: true,
      message: 'paymentAssociatedSuccessfully',
    });
    expect(h.prisma.discountCodedUses.update).toHaveBeenCalledWith({
      where: { id: 33 },
      data: { paymentId: 4 },
    });
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
