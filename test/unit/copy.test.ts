import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/copy.ts (Copy.duplicatePayment).
 *
 * Mocks:
 *  - src/prisma   → in-memory payment/paymentHasPlaylist stubs
 *  - src/apptheme → no-op reload
 */

const prismaMock = vi.hoisted(() => ({
  payment: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  paymentHasPlaylist: {
    create: vi.fn(),
  },
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

const reloadSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/apptheme', () => ({
  default: {
    getInstance: () => ({ reload: reloadSpy }),
  },
}));

let Copy: typeof import('../../src/copy').default;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const mod = await import('../../src/copy');
  Copy = mod.default;
  (Copy as any).instance = undefined;
});

function makeSvc() {
  return Copy.getInstance();
}

// Helper: minimal payment record
function makePayment(paymentId: string, orderId = '100', phpRows: any[] = []) {
  return {
    id: 99,
    paymentId,
    orderId,
    userId: 'user1',
    printerInvoiceId: null,
    orderTypeId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    PaymentHasPlaylist: phpRows,
    printApiOrderId: null,
    sendToPrinter: false,
    user: null,
    OrderType: null,
    printerInvoice: null,
    DiscountCodedUses: null,
    Review: null,
    CompanyList: null,
    // Additional fields that will be spread into the new payment
    status: 'paid',
    totalPrice: 10,
    profit: 5,
  };
}

// ──────────────────────────────────────────────
// duplicatePayment – not found
// ──────────────────────────────────────────────

describe('Copy.duplicatePayment – payment not found', () => {
  it('returns error when payment does not exist', async () => {
    prismaMock.payment.findUnique.mockResolvedValueOnce(null);
    const svc = makeSvc();
    const res = await svc.duplicatePayment('tr_nonexistent');
    expect(res).toEqual({ success: false, error: 'Payment not found' });
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// duplicatePayment – paymentId generation
// ──────────────────────────────────────────────

describe('Copy.duplicatePayment – paymentId generation', () => {
  beforeEach(() => {
    prismaMock.payment.findFirst.mockResolvedValue({ orderId: '200' });
    prismaMock.payment.create.mockResolvedValue({ id: 100 });
    prismaMock.paymentHasPlaylist.create.mockResolvedValue({});
  });

  it('converts tr_ prefix to dup_', async () => {
    prismaMock.payment.findUnique.mockResolvedValueOnce(makePayment('tr_abc123'));
    const svc = makeSvc();
    const res = await svc.duplicatePayment('tr_abc123');
    expect(res.success).toBe(true);
    expect(res.newPaymentId).toBe('dup_abc123');
  });

  it('increments dup_ prefix to dup2_', async () => {
    prismaMock.payment.findUnique.mockResolvedValueOnce(makePayment('dup_abc123'));
    const svc = makeSvc();
    const res = await svc.duplicatePayment('dup_abc123');
    expect(res.success).toBe(true);
    expect(res.newPaymentId).toBe('dup2_abc123');
  });

  it('increments dup2_ prefix to dup3_', async () => {
    prismaMock.payment.findUnique.mockResolvedValueOnce(makePayment('dup2_abc123'));
    const svc = makeSvc();
    const res = await svc.duplicatePayment('dup2_abc123');
    expect(res.success).toBe(true);
    expect(res.newPaymentId).toBe('dup3_abc123');
  });
});

// ──────────────────────────────────────────────
// duplicatePayment – orderId generation
// ──────────────────────────────────────────────

describe('Copy.duplicatePayment – orderId generation', () => {
  beforeEach(() => {
    prismaMock.payment.create.mockResolvedValue({ id: 100 });
    prismaMock.paymentHasPlaylist.create.mockResolvedValue({});
  });

  it('increments the highest orderId by 1', async () => {
    prismaMock.payment.findUnique.mockResolvedValueOnce(makePayment('tr_x', '100'));
    prismaMock.payment.findFirst.mockResolvedValueOnce({ orderId: '500' });
    const svc = makeSvc();
    await svc.duplicatePayment('tr_x');
    expect(prismaMock.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orderId: '501' }) })
    );
  });

  it('uses orderId "1" when no existing payments', async () => {
    prismaMock.payment.findUnique.mockResolvedValueOnce(makePayment('tr_x', '1'));
    prismaMock.payment.findFirst.mockResolvedValueOnce(null);
    const svc = makeSvc();
    await svc.duplicatePayment('tr_x');
    expect(prismaMock.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orderId: '1' }) })
    );
  });
});

// ──────────────────────────────────────────────
// duplicatePayment – PaymentHasPlaylist duplication
// ──────────────────────────────────────────────

describe('Copy.duplicatePayment – PaymentHasPlaylist', () => {
  it('creates a PHP record for each PHP row in the original payment', async () => {
    const phpRows = [
      { id: 10, paymentId: 'old_id', playlistId: 'pl1', qty: 1 },
      { id: 11, paymentId: 'old_id', playlistId: 'pl2', qty: 2 },
    ];
    prismaMock.payment.findUnique.mockResolvedValueOnce(makePayment('tr_y', '300', phpRows));
    prismaMock.payment.findFirst.mockResolvedValueOnce({ orderId: '300' });
    prismaMock.payment.create.mockResolvedValueOnce({ id: 101 });
    prismaMock.paymentHasPlaylist.create.mockResolvedValue({});

    const svc = makeSvc();
    const res = await svc.duplicatePayment('tr_y');
    expect(res.success).toBe(true);
    expect(prismaMock.paymentHasPlaylist.create).toHaveBeenCalledTimes(2);
    // Each create should use the new payment id (101), not the old one
    const calls = prismaMock.paymentHasPlaylist.create.mock.calls;
    expect(calls[0][0].data.paymentId).toBe(101);
    expect(calls[1][0].data.paymentId).toBe(101);
    // Old PHP id and paymentId should be stripped
    expect(calls[0][0].data).not.toHaveProperty('id');
  });

  it('skips PHP creation when no PHP rows', async () => {
    prismaMock.payment.findUnique.mockResolvedValueOnce(makePayment('tr_z', '100'));
    prismaMock.payment.findFirst.mockResolvedValueOnce({ orderId: '100' });
    prismaMock.payment.create.mockResolvedValueOnce({ id: 102 });
    const svc = makeSvc();
    await svc.duplicatePayment('tr_z');
    expect(prismaMock.paymentHasPlaylist.create).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// duplicatePayment – AppTheme reload
// ──────────────────────────────────────────────

describe('Copy.duplicatePayment – AppTheme reload', () => {
  it('calls appTheme.reload() after successful duplication', async () => {
    prismaMock.payment.findUnique.mockResolvedValueOnce(makePayment('tr_r', '200'));
    prismaMock.payment.findFirst.mockResolvedValueOnce({ orderId: '200' });
    prismaMock.payment.create.mockResolvedValueOnce({ id: 103 });
    const svc = makeSvc();
    await svc.duplicatePayment('tr_r');
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────
// duplicatePayment – error handling
// ──────────────────────────────────────────────

describe('Copy.duplicatePayment – error handling', () => {
  it('returns error object on DB exception', async () => {
    prismaMock.payment.findUnique.mockRejectedValueOnce(new Error('DB crash'));
    const svc = makeSvc();
    const res = await svc.duplicatePayment('tr_err');
    expect(res.success).toBe(false);
    expect(res.error).toContain('Failed to duplicate payment');
    expect(res.error).toContain('DB crash');
  });
});

// ──────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────

describe('Copy singleton', () => {
  it('returns the same instance', () => {
    const svc = makeSvc();
    expect(Copy.getInstance()).toBe(svc);
  });
});
