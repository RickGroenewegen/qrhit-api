import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Invoices for purchases made after an order (App Designer, extra cards):
 * the U<year>-<sequence> range, the line maths, the billing address and the
 * issue flow (idempotent on the Mollie payment, never throws).
 */

const prismaMock = vi.hoisted(() => ({
  upgradeInvoice: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    aggregate: vi.fn(),
  },
}));
vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

const mailMock = vi.hoisted(() => ({ sendUpgradeInvoiceEmail: vi.fn() }));
vi.mock('../../src/mail', () => ({
  default: { getInstance: () => mailMock },
}));

const pdfMock = vi.hoisted(() => ({ generateFromUrl: vi.fn(), resizePDFPages: vi.fn() }));
vi.mock('../../src/pdf', () => ({
  default: class {
    generateFromUrl = pdfMock.generateFromUrl;
    resizePDFPages = pdfMock.resizePDFPages;
  },
}));

const fsMock = vi.hoisted(() => ({ access: vi.fn(), mkdir: vi.fn() }));
vi.mock('fs/promises', () => ({ default: fsMock, ...fsMock }));

import UpgradeInvoices, {
  ORDER_BOOKED_UPGRADE_TYPES,
  buildUpgradeInvoiceLines,
  customerFromOrder,
  upgradeInvoiceNumber,
} from '../../src/upgradeInvoice';

const invoices = UpgradeInvoices.getInstance();

function issueParams(over: Record<string, any> = {}) {
  return {
    type: 'app_design' as const,
    molliePayment: { id: 'tr_up', method: 'ideal', amount: { value: '9.00', currency: 'EUR' } },
    userId: 5,
    paymentId: null,
    email: 'buyer@example.com',
    locale: 'nl',
    customer: customerFromOrder({ fullname: 'Jan', countrycode: 'NL' }),
    taxRate: 21,
    items: [{ description: 'App Designer', quantity: 1, totalIncl: 9 }],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env['PRIVATE_DIR'] = '/private-test';
  process.env['API_URI'] = 'https://api.test';
  prismaMock.upgradeInvoice.findUnique.mockResolvedValue(null);
  prismaMock.upgradeInvoice.findFirst.mockResolvedValue(null);
  prismaMock.upgradeInvoice.create.mockImplementation(async ({ data }: any) => ({
    id: 1,
    mailedAt: null,
    ...data,
  }));
  prismaMock.upgradeInvoice.update.mockResolvedValue({});
  fsMock.access.mockRejectedValue(new Error('ENOENT'));
  fsMock.mkdir.mockResolvedValue(undefined);
  mailMock.sendUpgradeInvoiceEmail.mockResolvedValue(undefined);
});

describe('upgradeInvoiceNumber', () => {
  it('prefixes U and pads the yearly sequence to five digits', () => {
    expect(upgradeInvoiceNumber(2026, 1)).toBe('U2026-00001');
    expect(upgradeInvoiceNumber(2026, 12345)).toBe('U2026-12345');
    expect(upgradeInvoiceNumber(2027, 123456)).toBe('U2027-123456');
  });
});

describe('buildUpgradeInvoiceLines', () => {
  it('derives ex-VAT and VAT from VAT-inclusive amounts', () => {
    const { lines, totalIncl, totalExcl, totalVat } = buildUpgradeInvoiceLines(
      [{ description: 'App Designer', quantity: 1, totalIncl: 9 }],
      21
    );
    expect(lines).toEqual([
      {
        kind: 'product',
        description: 'App Designer',
        quantity: 1,
        unitExcl: 7.44,
        totalExcl: 7.44,
        rate: 21,
        vat: 1.56,
        totalIncl: 9,
      },
    ]);
    expect({ totalIncl, totalExcl, totalVat }).toEqual({
      totalIncl: 9,
      totalExcl: 7.44,
      totalVat: 1.56,
    });
  });

  it('keeps the columns consistent across several lines', () => {
    const { lines, totalIncl, totalExcl, totalVat } = buildUpgradeInvoiceLines(
      [
        { description: 'Extra cards', quantity: 50, totalIncl: 18.1 },
        { description: 'Handling', quantity: 1, totalIncl: 3.03 },
        { description: 'Gift box', quantity: 1, totalIncl: 9.95 },
      ],
      21
    );
    expect(totalIncl).toBe(31.08);
    for (const line of lines) {
      expect(Math.round((line.totalExcl + line.vat) * 100) / 100).toBe(line.totalIncl);
    }
    expect(Math.round((totalExcl + totalVat) * 100) / 100).toBe(totalIncl);
    expect(lines[0].unitExcl).toBe(0.3);
  });

  it('drops empty lines (no boxes, no handling)', () => {
    const { lines } = buildUpgradeInvoiceLines(
      [
        { description: 'Extra cards', quantity: 50, totalIncl: 10 },
        { description: 'Handling', quantity: 1, totalIncl: 0 },
        { description: 'Gift box', quantity: 0, totalIncl: 0 },
      ],
      21
    );
    expect(lines.map((l) => l.description)).toEqual(['Extra cards']);
  });

  it('handles a zero rate (no VAT)', () => {
    const { lines, totalVat } = buildUpgradeInvoiceLines(
      [{ description: 'App Designer', quantity: 1, totalIncl: 9 }],
      0
    );
    expect(lines[0].totalExcl).toBe(9);
    expect(totalVat).toBe(0);
  });
});

describe('customerFromOrder', () => {
  it('prefers the invoice address over the delivery address', () => {
    expect(
      customerFromOrder({
        fullname: 'Jan',
        companyName: 'Acme',
        isBusinessOrder: true,
        vatId: 'NL001',
        address: 'Straat',
        housenumber: '1',
        zipcode: '1000 AA',
        city: 'Amsterdam',
        countrycode: 'NL',
        invoiceAddress: 'Factuurlaan',
        invoiceHousenumber: '9',
        invoiceZipcode: '2000 BB',
        invoiceCity: 'Haarlem',
        invoiceCountrycode: 'BE',
      })
    ).toEqual({
      fullname: 'Jan',
      companyName: 'Acme',
      isBusinessOrder: true,
      vatId: 'NL001',
      address: 'Factuurlaan',
      housenumber: '9',
      zipcode: '2000 BB',
      city: 'Haarlem',
      countrycode: 'BE',
    });
  });

  it('falls back to the delivery address, and to blanks without an order', () => {
    expect(customerFromOrder({ fullname: 'Jan', address: 'Straat', city: 'Amsterdam' })).toMatchObject({
      address: 'Straat',
      city: 'Amsterdam',
      companyName: null,
    });
    expect(customerFromOrder(null)).toMatchObject({ fullname: '', address: '', countrycode: '' });
  });
});

describe('UpgradeInvoices.amountBookedOnOrder', () => {
  it('sums the extra-cards and gift-box invoices of the order, the ones added to its total', async () => {
    prismaMock.upgradeInvoice.aggregate.mockResolvedValueOnce({ _sum: { totalPrice: 31.080000000000002 } });

    await expect(invoices.amountBookedOnOrder(321)).resolves.toBe(31.08);

    expect(prismaMock.upgradeInvoice.aggregate).toHaveBeenCalledWith({
      where: { paymentId: 321, type: { in: ORDER_BOOKED_UPGRADE_TYPES } },
      _sum: { totalPrice: true },
    });
    // App Designer and QRGames never touch an order's total.
    expect(ORDER_BOOKED_UPGRADE_TYPES).toEqual(['extra_tracks', 'box']);
  });

  it('is 0 for an order without upgrade invoices', async () => {
    prismaMock.upgradeInvoice.aggregate.mockResolvedValueOnce({ _sum: { totalPrice: null } });

    await expect(invoices.amountBookedOnOrder(1)).resolves.toBe(0);
  });
});

describe('UpgradeInvoices.issue', () => {
  it('numbers the first invoice of the year 00001, renders the PDF and mails it', async () => {
    const year = new Date().getFullYear();

    await invoices.issue(issueParams());

    const data = prismaMock.upgradeInvoice.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      invoiceNumber: upgradeInvoiceNumber(year, 1),
      year,
      sequence: 1,
      type: 'app_design',
      molliePaymentId: 'tr_up',
      userId: 5,
      paymentId: null,
      email: 'buyer@example.com',
      locale: 'nl',
      totalPrice: 9,
      totalPriceWithoutTax: 7.44,
      totalVAT: 1.56,
      taxRate: 21,
      currency: 'EUR',
      amountCharged: 9,
      paymentMethod: 'ideal',
    });
    expect(pdfMock.generateFromUrl).toHaveBeenCalledWith(
      'https://api.test/invoice/upgrade/tr_up',
      `/private-test/invoice/upgrade/${upgradeInvoiceNumber(year, 1)}.pdf`,
      expect.any(Object)
    );
    expect(mailMock.sendUpgradeInvoiceEmail).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceNumber: upgradeInvoiceNumber(year, 1) }),
      `/private-test/invoice/upgrade/${upgradeInvoiceNumber(year, 1)}.pdf`
    );
    expect(prismaMock.upgradeInvoice.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { mailedAt: expect.any(Date) },
    });
  });

  it('continues the yearly sequence and stores what Mollie charged in another currency', async () => {
    prismaMock.upgradeInvoice.findFirst.mockResolvedValueOnce({ sequence: 41 });

    await invoices.issue(
      issueParams({
        molliePayment: { id: 'tr_sek', method: 'klarna', amount: { value: '105.00', currency: 'SEK' } },
      })
    );

    const data = prismaMock.upgradeInvoice.create.mock.calls[0][0].data;
    expect(data.sequence).toBe(42);
    expect(data.invoiceNumber).toMatch(/^U\d{4}-00042$/);
    expect(data.totalPrice).toBe(9);
    expect(data.currency).toBe('SEK');
    expect(data.amountCharged).toBe(105);
  });

  it('takes the next number when another webhook took the same one', async () => {
    prismaMock.upgradeInvoice.findFirst
      .mockResolvedValueOnce({ sequence: 6 })
      .mockResolvedValueOnce({ sequence: 7 });
    prismaMock.upgradeInvoice.create.mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002', meta: { target: 'upgrade_invoices_year_sequence_key' } })
    );

    await invoices.issue(issueParams());

    expect(prismaMock.upgradeInvoice.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.upgradeInvoice.create.mock.calls[1][0].data.sequence).toBe(8);
    expect(mailMock.sendUpgradeInvoiceEmail).toHaveBeenCalledTimes(1);
  });

  it('a replay that finds a mailed invoice does nothing', async () => {
    prismaMock.upgradeInvoice.findUnique.mockResolvedValueOnce({
      id: 3,
      invoiceNumber: 'U2026-00003',
      molliePaymentId: 'tr_up',
      mailedAt: new Date(),
    });

    await invoices.issue(issueParams());

    expect(prismaMock.upgradeInvoice.create).not.toHaveBeenCalled();
    expect(mailMock.sendUpgradeInvoiceEmail).not.toHaveBeenCalled();
  });

  it('a replay retries the mail of an invoice that was not mailed, reusing the PDF', async () => {
    prismaMock.upgradeInvoice.findUnique.mockResolvedValueOnce({
      id: 3,
      invoiceNumber: 'U2026-00003',
      molliePaymentId: 'tr_up',
      mailedAt: null,
    });
    fsMock.access.mockResolvedValueOnce(undefined);

    await invoices.issue(issueParams());

    expect(prismaMock.upgradeInvoice.create).not.toHaveBeenCalled();
    expect(pdfMock.generateFromUrl).not.toHaveBeenCalled();
    expect(mailMock.sendUpgradeInvoiceEmail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3 }),
      '/private-test/invoice/upgrade/U2026-00003.pdf'
    );
  });

  it('a failed mail leaves the invoice unmailed and does not throw', async () => {
    mailMock.sendUpgradeInvoiceEmail.mockRejectedValueOnce(new Error('SES down'));

    await expect(invoices.issue(issueParams())).resolves.toBeUndefined();

    expect(prismaMock.upgradeInvoice.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.upgradeInvoice.update).not.toHaveBeenCalled();
  });

  it('creates nothing when every line is empty', async () => {
    await invoices.issue(issueParams({ items: [{ description: 'x', quantity: 0, totalIncl: 0 }] }));

    expect(prismaMock.upgradeInvoice.create).not.toHaveBeenCalled();
    expect(mailMock.sendUpgradeInvoiceEmail).not.toHaveBeenCalled();
  });
});
