import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/discount.ts (Discount class).
 *
 * Mocks:
 *  - src/prisma → in-memory discountCode / discountCodedUses stubs
 *  - src/cache  → in-memory map mock (for lock)
 *  - src/utils  → verifyRecaptcha always human (for checkDiscount)
 *
 * Skipped: redeemDiscount – uses prisma.$transaction + executeCommand
 * (locking), tested in integration; calculateVolumeDiscount + calculateDiscounts
 * require complex cart fixtures, covered elsewhere.
 */

const discountCodeStore = new Map<string, any>();
const discountUsesStore: any[] = [];

function makePrismaImpls() {
  return {
    discountCode: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.code) return discountCodeStore.get(where.code) ?? null;
        if (where.id !== undefined) {
          for (const v of discountCodeStore.values()) if (v.id === where.id) return v;
          return null;
        }
        return null;
      }),
      findMany: vi.fn(async () => [...discountCodeStore.values()]),
      create: vi.fn(async ({ data }: any) => {
        const record = { id: discountCodeStore.size + 1, ...data };
        discountCodeStore.set(data.code, record);
        return record;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        for (const [k, v] of discountCodeStore.entries()) {
          if (v.id === where.id) {
            const updated = { ...v, ...data };
            discountCodeStore.set(k, updated);
            if (data.code && data.code !== k) {
              discountCodeStore.delete(k);
              discountCodeStore.set(data.code, updated);
            }
            return updated;
          }
        }
        throw new Error('Record not found');
      }),
      delete: vi.fn(async ({ where }: any) => {
        for (const [k, v] of discountCodeStore.entries()) {
          if (v.id === where.id) {
            discountCodeStore.delete(k);
            return v;
          }
        }
        throw new Error('Record not found');
      }),
    },
    discountCodedUses: {
      aggregate: vi.fn(async ({ where }: any) => {
        const uses = discountUsesStore.filter((u) => u.discountCodeId === where?.discountCodeId || u.paymentId === where?.paymentId);
        const sum = uses.reduce((acc, u) => acc + (u.amount || 0), 0);
        return { _sum: { amount: sum || null } };
      }),
      deleteMany: vi.fn(async () => ({})),
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    $transaction: vi.fn(async (fn: any) => fn({
      discountCode: makePrismaImpls().discountCode,
      discountCodedUses: makePrismaImpls().discountCodedUses,
    })),
  };
}

const prismaMock = {
  discountCode: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  discountCodedUses: { aggregate: vi.fn(), deleteMany: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

const cacheStoreMock = new Map<string, string>();
vi.mock('../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (k: string) => cacheStoreMock.get(k) ?? null,
      set: async (k: string, v: string) => { cacheStoreMock.set(k, v); },
      del: async (k: string) => { cacheStoreMock.delete(k); },
      executeCommand: vi.fn(async () => true), // always acquire lock
    }),
  },
}));

const verifyRecaptcha = vi.fn(async () => ({ isHuman: true }));
vi.mock('../../src/utils', () => ({
  default: class {
    verifyRecaptcha = verifyRecaptcha;
    generateRandomString = vi.fn(() => 'RANDOM');
    parseBoolean = vi.fn((v: any) => !!v);
  },
}));

let Discount: typeof import('../../src/discount').default;

beforeEach(async () => {
  vi.resetModules();
  discountCodeStore.clear();
  discountUsesStore.length = 0;
  cacheStoreMock.clear();
  vi.clearAllMocks();

  const impls = makePrismaImpls();
  prismaMock.discountCode.findUnique.mockImplementation(impls.discountCode.findUnique);
  prismaMock.discountCode.findMany.mockImplementation(impls.discountCode.findMany);
  prismaMock.discountCode.create.mockImplementation(impls.discountCode.create);
  prismaMock.discountCode.update.mockImplementation(impls.discountCode.update);
  prismaMock.discountCode.delete.mockImplementation(impls.discountCode.delete);
  prismaMock.discountCodedUses.aggregate.mockImplementation(impls.discountCodedUses.aggregate);
  prismaMock.discountCodedUses.deleteMany.mockImplementation(impls.discountCodedUses.deleteMany);
  prismaMock.discountCodedUses.update.mockImplementation(impls.discountCodedUses.update);
  prismaMock.$transaction.mockImplementation(impls.$transaction);

  const mod = await import('../../src/discount');
  Discount = mod.default;
});

function makeSvc() {
  return new Discount();
}

// ──────────────────────────────────────────────
// createAdminDiscountCode
// ──────────────────────────────────────────────

describe('Discount.createAdminDiscountCode', () => {
  it('returns error for invalid (zero) amount', async () => {
    const svc = makeSvc();
    const res = await svc.createAdminDiscountCode({ amount: 0 });
    expect(res).toEqual({ success: false, error: 'Invalid amount' });
  });

  it('returns error for negative amount', async () => {
    const svc = makeSvc();
    const res = await svc.createAdminDiscountCode({ amount: -5 });
    expect(res).toEqual({ success: false, error: 'Invalid amount' });
  });

  it('returns error for non-numeric amount', async () => {
    const svc = makeSvc();
    const res = await svc.createAdminDiscountCode({ amount: NaN });
    expect(res).toEqual({ success: false, error: 'Invalid amount' });
  });

  it('creates a discount code with manual code (uppercased)', async () => {
    const svc = makeSvc();
    const res = await svc.createAdminDiscountCode({ amount: 10, code: 'testcode' });
    expect(res.success).toBe(true);
    expect(res.code).toBe('TESTCODE');
  });

  it('returns error when manual code already exists', async () => {
    discountCodeStore.set('EXISTING', { id: 1, code: 'EXISTING', amount: 5 });
    const svc = makeSvc();
    const res = await svc.createAdminDiscountCode({ amount: 10, code: 'EXISTING' });
    expect(res).toEqual({ success: false, error: 'Discount code already exists' });
  });

  it('generates a random code when no manual code is provided', async () => {
    const svc = makeSvc();
    const res = await svc.createAdminDiscountCode({ amount: 15 });
    expect(res.success).toBe(true);
    expect(res.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it('converts general=1 to boolean true', async () => {
    const svc = makeSvc();
    await svc.createAdminDiscountCode({ amount: 5, code: 'GCODE', general: 1 });
    const call = prismaMock.discountCode.create.mock.calls[0][0];
    expect(call.data.general).toBe(true);
  });

  it('converts digital="1" to boolean true', async () => {
    const svc = makeSvc();
    await svc.createAdminDiscountCode({ amount: 5, code: 'DCODE', digital: '1' });
    const call = prismaMock.discountCode.create.mock.calls[0][0];
    expect(call.data.digital).toBe(true);
  });

  it('converts unix timestamps to Date objects', async () => {
    const svc = makeSvc();
    const startTs = 1700000000;
    const endTs = 1800000000;
    await svc.createAdminDiscountCode({ amount: 10, code: 'TSCODE', startDate: startTs, endDate: endTs });
    const call = prismaMock.discountCode.create.mock.calls[0][0];
    expect(call.data.startDate).toEqual(new Date(startTs * 1000));
    expect(call.data.endDate).toEqual(new Date(endTs * 1000));
  });

  it('uses null for missing dates', async () => {
    const svc = makeSvc();
    await svc.createAdminDiscountCode({ amount: 10, code: 'NODATE' });
    const call = prismaMock.discountCode.create.mock.calls[0][0];
    expect(call.data.startDate).toBeNull();
    expect(call.data.endDate).toBeNull();
  });

  it('handles DB exception gracefully', async () => {
    prismaMock.discountCode.create.mockRejectedValueOnce(new Error('DB fail'));
    const svc = makeSvc();
    const res = await svc.createAdminDiscountCode({ amount: 5, code: 'ERRCODE' });
    expect(res).toEqual({ success: false, error: 'Failed to create discount code' });
  });
});

// ──────────────────────────────────────────────
// deleteDiscountCode
// ──────────────────────────────────────────────

describe('Discount.deleteDiscountCode', () => {
  it('deletes an existing code', async () => {
    discountCodeStore.set('DEL01', { id: 10, code: 'DEL01' });
    const svc = makeSvc();
    const res = await svc.deleteDiscountCode(10);
    expect(res).toEqual({ success: true });
    expect(prismaMock.discountCode.delete).toHaveBeenCalledWith({ where: { id: 10 } });
  });

  it('returns error when deletion fails', async () => {
    prismaMock.discountCode.delete.mockRejectedValueOnce(new Error('Not found'));
    const svc = makeSvc();
    const res = await svc.deleteDiscountCode(999);
    expect(res).toEqual({ success: false, error: 'Failed to delete discount code' });
  });
});

// ──────────────────────────────────────────────
// updateDiscountCode
// ──────────────────────────────────────────────

describe('Discount.updateDiscountCode', () => {
  beforeEach(() => {
    discountCodeStore.set('OLDCODE', { id: 5, code: 'OLDCODE', amount: 20 });
  });

  it('returns error for invalid amount', async () => {
    const svc = makeSvc();
    const res = await svc.updateDiscountCode(5, { amount: 0 });
    expect(res).toEqual({ success: false, error: 'Invalid amount' });
  });

  it('updates an existing code', async () => {
    const svc = makeSvc();
    const res = await svc.updateDiscountCode(5, { amount: 30, code: 'NEWCODE' });
    expect(res.success).toBe(true);
    expect(res.code).toBe('NEWCODE');
  });

  it('returns error if new code is taken by a different discount', async () => {
    discountCodeStore.set('TAKEN', { id: 99, code: 'TAKEN', amount: 5 });
    const svc = makeSvc();
    const res = await svc.updateDiscountCode(5, { amount: 10, code: 'TAKEN' });
    expect(res).toEqual({ success: false, error: 'Discount code already exists' });
  });

  it('allows updating to same code (owned by same id)', async () => {
    const svc = makeSvc();
    // Code OLDCODE belongs to id 5, updating id 5 with same code should work
    const res = await svc.updateDiscountCode(5, { amount: 25, code: 'OLDCODE' });
    expect(res.success).toBe(true);
  });

  it('handles DB exception gracefully', async () => {
    prismaMock.discountCode.update.mockRejectedValueOnce(new Error('DB fail'));
    const svc = makeSvc();
    const res = await svc.updateDiscountCode(5, { amount: 10 });
    expect(res).toEqual({ success: false, error: 'Failed to update discount code' });
  });
});

// ──────────────────────────────────────────────
// getAllDiscounts
// ──────────────────────────────────────────────

describe('Discount.getAllDiscounts', () => {
  it('returns empty list when no discounts', async () => {
    const svc = makeSvc();
    const res = await svc.getAllDiscounts();
    expect(res.success).toBe(true);
    expect(res.discounts).toEqual([]);
  });

  it('enriches discounts with totalSpent and amountLeft', async () => {
    discountCodeStore.set('RICH', { id: 1, code: 'RICH', amount: 100 });
    discountUsesStore.push({ discountCodeId: 1, amount: 30 });
    const svc = makeSvc();
    const res = await svc.getAllDiscounts();
    expect(res.success).toBe(true);
    expect(res.discounts![0].totalSpent).toBe(30);
    expect(res.discounts![0].amountLeft).toBe(70);
  });

  it('returns error on DB exception', async () => {
    prismaMock.discountCode.findMany.mockRejectedValueOnce(new Error('fail'));
    const svc = makeSvc();
    const res = await svc.getAllDiscounts();
    expect(res.success).toBe(false);
    expect(res.error).toContain('Failed to fetch discounts');
  });
});

// ──────────────────────────────────────────────
// removeDiscountUsesByPaymentId
// ──────────────────────────────────────────────

describe('Discount.removeDiscountUsesByPaymentId', () => {
  it('deletes uses for a paymentId', async () => {
    const svc = makeSvc();
    const res = await svc.removeDiscountUsesByPaymentId(42);
    expect(res.success).toBe(true);
    expect(prismaMock.discountCodedUses.deleteMany).toHaveBeenCalledWith({ where: { paymentId: 42 } });
  });

  it('returns error on exception', async () => {
    prismaMock.discountCodedUses.deleteMany.mockRejectedValueOnce(new Error('fail'));
    const svc = makeSvc();
    const res = await svc.removeDiscountUsesByPaymentId(99);
    expect(res.success).toBe(false);
  });
});

// ──────────────────────────────────────────────
// associatePaymentWithDiscountUse
// ──────────────────────────────────────────────

describe('Discount.associatePaymentWithDiscountUse', () => {
  it('updates the discountUse with paymentId', async () => {
    const svc = makeSvc();
    const res = await svc.associatePaymentWithDiscountUse(7, 99);
    expect(res.success).toBe(true);
    expect(prismaMock.discountCodedUses.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { paymentId: 99 },
    });
  });

  it('returns error on exception', async () => {
    prismaMock.discountCodedUses.update.mockRejectedValueOnce(new Error('fail'));
    const svc = makeSvc();
    const res = await svc.associatePaymentWithDiscountUse(7, 99);
    expect(res.success).toBe(false);
  });
});

// ──────────────────────────────────────────────
// calculateTotalDiscountForPayment
// ──────────────────────────────────────────────

describe('Discount.calculateTotalDiscountForPayment', () => {
  it('returns the aggregate sum', async () => {
    prismaMock.discountCodedUses.aggregate.mockResolvedValueOnce({ _sum: { amount: 15 } });
    const svc = makeSvc();
    const result = await svc.calculateTotalDiscountForPayment(5);
    expect(result).toBe(15);
  });

  it('returns 0 when no uses exist', async () => {
    prismaMock.discountCodedUses.aggregate.mockResolvedValueOnce({ _sum: { amount: null } });
    const svc = makeSvc();
    const result = await svc.calculateTotalDiscountForPayment(5);
    expect(result).toBe(0);
  });
});

// ──────────────────────────────────────────────
// checkDiscount
// ──────────────────────────────────────────────

describe('Discount.checkDiscount', () => {
  it('throws when recaptcha fails', async () => {
    verifyRecaptcha.mockResolvedValueOnce({ isHuman: false });
    const svc = makeSvc();
    await expect(svc.checkDiscount('CODE', 'token', false)).rejects.toThrow('Request failed');
  });

  it('returns not found when code does not exist', async () => {
    const svc = makeSvc();
    const res = await svc.checkDiscount('NOTFOUND', 'tok', false);
    expect(res).toEqual({ success: false, message: 'discountCodeNotFound' });
  });

  it('returns notApplicableForRealOrders for digital-only code on real order', async () => {
    discountCodeStore.set('DIGITAL', { id: 1, code: 'DIGITAL', amount: 10, digital: true, startDate: null, endDate: null });
    const svc = makeSvc();
    const res = await svc.checkDiscount('DIGITAL', 'tok', false);
    expect(res).toEqual({ success: false, message: 'notApplicableForRealOrders' });
  });

  it('allows digital-only code on digital order', async () => {
    discountCodeStore.set('DIG2', { id: 2, code: 'DIG2', amount: 10, digital: true, startDate: null, endDate: null });
    prismaMock.discountCodedUses.aggregate.mockResolvedValueOnce({ _sum: { amount: 0 } });
    const svc = makeSvc();
    const res = await svc.checkDiscount('DIG2', 'tok', true);
    expect(res.success).toBe(true);
  });

  it('returns discountNotActive when startDate is in the future', async () => {
    const future = new Date(Date.now() + 1_000_000);
    discountCodeStore.set('FUTURE', { id: 3, code: 'FUTURE', amount: 10, digital: false, startDate: future, endDate: null });
    const svc = makeSvc();
    const res = await svc.checkDiscount('FUTURE', 'tok', false);
    expect(res).toEqual({ success: false, message: 'discountNotActive' });
  });

  it('returns discountNotActive when endDate is in the past', async () => {
    const past = new Date(Date.now() - 1_000_000);
    discountCodeStore.set('EXPIRED', { id: 4, code: 'EXPIRED', amount: 10, digital: false, startDate: null, endDate: past });
    const svc = makeSvc();
    const res = await svc.checkDiscount('EXPIRED', 'tok', false);
    expect(res).toEqual({ success: false, message: 'discountNotActive' });
  });

  it('returns exhausted when amountLeft <= 0', async () => {
    discountCodeStore.set('USED', { id: 5, code: 'USED', amount: 10, digital: false, startDate: null, endDate: null });
    prismaMock.discountCodedUses.aggregate.mockResolvedValueOnce({ _sum: { amount: 10 } });
    const svc = makeSvc();
    const res = await svc.checkDiscount('USED', 'tok', false);
    expect(res.success).toBe(false);
    expect(res.message).toBe('discountCodeExhausted');
  });

  it('returns success with amount info for valid code', async () => {
    discountCodeStore.set('VALID', { id: 6, code: 'VALID', amount: 20, digital: false, startDate: null, endDate: null });
    prismaMock.discountCodedUses.aggregate.mockResolvedValueOnce({ _sum: { amount: 5 } });
    const svc = makeSvc();
    const res = await svc.checkDiscount('VALID', 'tok', false);
    expect(res.success).toBe(true);
    expect(res.fullAmount).toBe(20);
    expect(res.amountLeft).toBe(15);
  });
});
