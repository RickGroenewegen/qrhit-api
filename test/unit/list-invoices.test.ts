import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/listInvoices.ts: which MoneyBird invoices a company list
 * already has. The answer decides whether an admin may bill, so the failure
 * modes that matter are a second invoice for the same payment and another
 * customer's invoice showing up.
 */

const prismaMock = vi.hoisted(() => ({
  companyListInvoice: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
}));

const bookkeepingMock = vi.hoisted(() => ({
  providerName: vi.fn(() => 'moneybird'),
  getInvoice: vi.fn(),
  findContactByCustomerKey: vi.fn(),
  findInvoiceByReference: vi.fn(),
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));
vi.mock('../../src/bookkeeping', () => ({
  default: { getInstance: () => bookkeepingMock },
}));
vi.mock('../../src/logger', () => ({
  default: class {
    log = vi.fn();
  },
}));

import {
  blockingInvoice,
  findListInvoices,
  invoiceExclVat,
  recordListInvoice,
} from '../../src/listInvoices';

const references = {
  full: 'Kerst 2026',
  down: 'Kerst 2026 - Aanbetaling 30%',
  remaining: 'Kerst 2026 - Slottermijn 70%',
  legacyDown: 'Kerst 2026 — Aanbetaling 30%',
  legacyRemaining: 'Kerst 2026 — Slottermijn 70%',
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.companyListInvoice.findMany.mockResolvedValue([]);
  prismaMock.companyListInvoice.upsert.mockResolvedValue({});
  prismaMock.companyListInvoice.delete.mockResolvedValue({});
  bookkeepingMock.findContactByCustomerKey.mockResolvedValue({ id: 'c53' });
  bookkeepingMock.findInvoiceByReference.mockResolvedValue(null);
  bookkeepingMock.getInvoice.mockResolvedValue(null);
});

describe('blockingInvoice', () => {
  const inv = { id: 1 };
  const none = { full: null, down: null, remaining: null };

  it('a full invoice rules out everything', () => {
    const e = { ...none, full: inv };
    expect(blockingInvoice(e, 'full')).toBe(inv);
    expect(blockingInvoice(e, 'down')).toBe(inv);
    expect(blockingInvoice(e, 'remaining')).toBe(inv);
  });

  it('a split rules out the full invoice and a second one of itself only', () => {
    const e = { ...none, down: inv };
    expect(blockingInvoice(e, 'full')).toBe(inv);
    expect(blockingInvoice(e, 'down')).toBe(inv);
    expect(blockingInvoice(e, 'remaining')).toBeNull();
  });

  it('nothing rules out nothing', () => {
    expect(blockingInvoice(none, 'full')).toBeNull();
  });
});

describe('invoiceExclVat', () => {
  it('reads MoneyBird string totals', () => {
    expect(invoiceExclVat({ id: 1, total_price_excl_tax: '3469.5' })).toBe(3469.5);
    expect(invoiceExclVat({ id: 1 })).toBeNull();
    expect(invoiceExclVat({ id: 1, total_price_excl_tax: 'n/a' })).toBeNull();
    expect(invoiceExclVat(null)).toBeNull();
  });
});

describe('findListInvoices', () => {
  it('finds recorded invoices by id, not by reference', async () => {
    prismaMock.companyListInvoice.findMany.mockResolvedValue([
      { id: 9, paymentOption: 'down', externalId: '555' },
    ]);
    bookkeepingMock.getInvoice.mockResolvedValue({ id: '555', total_price_excl_tax: '3000.0' });

    const found = await findListInvoices({ listId: 7, companyId: 53, references });

    expect(bookkeepingMock.getInvoice).toHaveBeenCalledWith('555');
    expect(found.down).toMatchObject({ id: '555' });
    // The others are still looked up, for invoices from before the table.
    expect(bookkeepingMock.findInvoiceByReference).not.toHaveBeenCalledWith(
      references.down,
      expect.anything()
    );
  });

  it('forgets a recorded invoice that was deleted in MoneyBird', async () => {
    prismaMock.companyListInvoice.findMany.mockResolvedValue([
      { id: 9, paymentOption: 'full', externalId: '555' },
    ]);
    bookkeepingMock.getInvoice.mockResolvedValue(null);

    const found = await findListInvoices({ listId: 7, companyId: 53, references });

    expect(found.full).toBeNull();
    expect(prismaMock.companyListInvoice.delete).toHaveBeenCalledWith({ where: { id: 9 } });
  });

  it('falls back to exact references on the company contact, and records what it finds', async () => {
    bookkeepingMock.findInvoiceByReference.mockImplementation(async (ref: string) =>
      ref === references.legacyDown
        ? { id: '321', reference: ref, invoice_id: '2026-0042', total_price_excl_tax: '1000.0' }
        : null
    );

    const found = await findListInvoices({ listId: 7, companyId: 53, references });

    expect(bookkeepingMock.findContactByCustomerKey).toHaveBeenCalledWith('qrhit-53', { strict: true });
    expect(bookkeepingMock.findInvoiceByReference).toHaveBeenCalledWith(references.full, {
      contactId: 'c53',
      strict: true,
    });
    expect(found).toMatchObject({ full: null, down: { id: '321' }, remaining: null });
    expect(prismaMock.companyListInvoice.upsert).toHaveBeenCalledWith({
      where: { companyListId_paymentOption: { companyListId: 7, paymentOption: 'down' } },
      create: {
        companyListId: 7,
        paymentOption: 'down',
        provider: 'moneybird',
        externalId: '321',
        invoiceNumber: '2026-0042',
        reference: references.legacyDown,
        totalExclVat: 1000,
      },
      update: {
        provider: 'moneybird',
        externalId: '321',
        invoiceNumber: '2026-0042',
        reference: references.legacyDown,
        totalExclVat: 1000,
      },
    });
  });

  it('a company without a MoneyBird contact has no invoices to find', async () => {
    bookkeepingMock.findContactByCustomerKey.mockResolvedValue(null);
    const found = await findListInvoices({ listId: 7, companyId: 53, references });
    expect(found).toEqual({ full: null, down: null, remaining: null });
    expect(bookkeepingMock.findInvoiceByReference).not.toHaveBeenCalled();
  });

  it('still works from references before the table exists', async () => {
    prismaMock.companyListInvoice.findMany.mockRejectedValue(
      new Error("The table `company_list_invoices` does not exist")
    );
    bookkeepingMock.findInvoiceByReference.mockImplementation(async (ref: string) =>
      ref === references.full ? { id: '1', reference: ref } : null
    );
    const found = await findListInvoices({ listId: 7, companyId: 53, references });
    expect(found.full).toMatchObject({ id: '1' });
  });

  it('lets a MoneyBird outage fail the lookup rather than report "nothing invoiced"', async () => {
    bookkeepingMock.findInvoiceByReference.mockRejectedValue(new Error('503'));
    await expect(
      findListInvoices({ listId: 7, companyId: 53, references })
    ).rejects.toThrow('503');
  });
});

describe('recordListInvoice', () => {
  it('never throws: the invoice exists in MoneyBird either way', async () => {
    prismaMock.companyListInvoice.upsert.mockRejectedValue(new Error('no table'));
    await expect(recordListInvoice(7, 'full', { id: 1 })).resolves.toBeUndefined();
  });

  it('ignores an invoice without id', async () => {
    await recordListInvoice(7, 'full', {} as any);
    expect(prismaMock.companyListInvoice.upsert).not.toHaveBeenCalled();
  });
});
