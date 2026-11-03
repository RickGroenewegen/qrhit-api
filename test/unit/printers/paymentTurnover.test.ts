import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for src/paymentTurnover.ts, the admin recompute behind
 * POST /admin/payment/:paymentId/recompute-turnover. Prisma and Data are
 * stubbed (no DB). The case is order 100009253: a German business order
 * (reverse charge, charged 0%, €42.02) booked by the printer step at 19%
 * as €35.31 ex VAT and €9.72 profit (print cost €25.59).
 */

const h = vi.hoisted(() => ({
  paymentFindUnique: vi.fn(),
  paymentUpdateMany: vi.fn(),
  phpFindMany: vi.fn(),
  getTaxRate: vi.fn(),
  log: vi.fn(),
}));

vi.mock('../../../src/logger', () => ({
  default: class Logger {
    log = h.log;
    logDev() {}
  },
}));
vi.mock('../../../src/prisma', () => ({
  default: {
    getInstance: () => ({
      payment: { findUnique: h.paymentFindUnique, updateMany: h.paymentUpdateMany },
      paymentHasPlaylist: { findMany: h.phpFindMany },
    }),
  },
}));
vi.mock('../../../src/data', () => ({
  default: { getInstance: () => ({ getTaxRate: h.getTaxRate }) },
}));

import PaymentTurnover, {
  PaymentTurnoverError,
  turnoverProblem,
} from '../../../src/paymentTurnover';

const PAYMENT_ID = 'tr_t9MhdMyxRbGcSAcp5DCYJ';

const row9253 = (over: Record<string, unknown> = {}) => ({
  id: 9253,
  paymentId: PAYMENT_ID,
  orderId: '100009253',
  status: 'paid',
  countrycode: 'DE',
  taxRate: 0,
  reverseCharge: true,
  totalPrice: 42.02,
  totalPriceWithoutTax: 35.31,
  profit: 9.72,
  printApiPrice: 25.59,
  extraPrintCost: 0,
  ...over,
});

const recompute = (opts?: { dryRun?: boolean }) =>
  PaymentTurnover.getInstance().recompute(PAYMENT_ID, opts);

async function refusal(promise: Promise<unknown>): Promise<PaymentTurnoverError> {
  const error = await promise.then(
    () => null,
    (e) => e
  );
  expect(error).toBeInstanceOf(PaymentTurnoverError);
  return error as PaymentTurnoverError;
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.phpFindMany.mockResolvedValue([]);
  h.getTaxRate.mockImplementation(async (c: string) => ({ NL: 21, DE: 19 })[c] ?? null);
});

describe('turnoverProblem', () => {
  it('takes a paid order with a print cost', () => {
    expect(turnoverProblem({ status: 'paid', printApiPrice: 25.59 })).toBeNull();
  });

  it('refuses an unpaid order and one without a print cost', () => {
    expect(turnoverProblem({ status: 'open', printApiPrice: 25.59 })).toMatch(
      /the payment is open: only a paid order/
    );
    expect(turnoverProblem({ status: 'paid', printApiPrice: 0 })).toMatch(
      /no print cost stored/
    );
  });
});

describe('PaymentTurnover.recompute', () => {
  it('dry run: before → after at the 0% it was charged, nothing written', async () => {
    h.paymentFindUnique.mockResolvedValueOnce(row9253());

    const r = await recompute({ dryRun: true });

    expect(r).toMatchObject({
      paymentId: PAYMENT_ID,
      orderId: '100009253',
      countrycode: 'DE',
      reverseCharge: true,
      totalPrice: 42.02,
      taxRate: 0,
      taxRateSource: 'payment',
      printApiPrice: 25.59,
      boxes: 0,
      boxCost: 0,
      extraPrintCost: 0,
      before: { totalPriceWithoutTax: 35.31, profit: 9.72 },
      after: { totalPriceWithoutTax: 42.02, profit: 16.43 },
      changed: true,
      dryRun: true,
      written: false,
      readBack: null,
    });
    expect(h.paymentUpdateMany).not.toHaveBeenCalled();
    // The stored rate is used, not the country's 19%.
    expect(h.getTaxRate).not.toHaveBeenCalled();
  });

  it('writes the two figures only while the row still holds what was read, then reads it back', async () => {
    h.paymentFindUnique
      .mockResolvedValueOnce(row9253())
      .mockResolvedValueOnce({ totalPriceWithoutTax: 42.02, profit: 16.43 });
    h.paymentUpdateMany.mockResolvedValueOnce({ count: 1 });

    const r = await recompute();

    expect(h.paymentUpdateMany).toHaveBeenCalledTimes(1);
    expect(h.paymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 9253,
        totalPrice: 42.02,
        printApiPrice: 25.59,
        extraPrintCost: 0,
        totalPriceWithoutTax: 35.31,
        profit: 9.72,
      },
      data: { totalPriceWithoutTax: 42.02, profit: 16.43 },
    });
    expect(h.paymentFindUnique).toHaveBeenLastCalledWith({
      where: { id: 9253 },
      select: { totalPriceWithoutTax: true, profit: true },
    });
    expect(r).toMatchObject({
      dryRun: false,
      changed: true,
      written: true,
      readBack: { totalPriceWithoutTax: 42.02, profit: 16.43 },
    });
    expect(h.log).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the row is right already', async () => {
    h.paymentFindUnique.mockResolvedValueOnce(
      row9253({ totalPriceWithoutTax: 42.02, profit: 16.43 })
    );

    const r = await recompute();

    expect(r).toMatchObject({ changed: false, written: false, readBack: null });
    expect(h.paymentUpdateMany).not.toHaveBeenCalled();
  });

  it('refuses when the row changed in between (an upgrade, a printer pass)', async () => {
    h.paymentFindUnique.mockResolvedValueOnce(row9253());
    h.paymentUpdateMany.mockResolvedValueOnce({ count: 0 });

    const e = await refusal(recompute());

    expect(e.status).toBe(409);
    expect(e.message).toMatch(/changed while it was recomputed .*nothing written/);
    expect(h.log).not.toHaveBeenCalled();
  });

  it('takes the gift boxes and a later printer order off the profit, as the printer step does', async () => {
    h.paymentFindUnique.mockResolvedValueOnce(
      row9253({
        countrycode: 'NL',
        taxRate: 21,
        reverseCharge: false,
        totalPrice: 60.5,
        totalPriceWithoutTax: 50,
        profit: 30,
        printApiPrice: 20,
        extraPrintCost: 3.1,
      })
    );
    h.phpFindMany.mockResolvedValueOnce([
      { boxEnabled: true, boxQuantity: 1, amount: 2 },
      { boxEnabled: false, boxQuantity: 1, amount: 1 },
    ]);

    const r = await recompute({ dryRun: true });

    expect(h.phpFindMany).toHaveBeenCalledWith({
      where: { paymentId: 9253 },
      select: { boxEnabled: true, boxQuantity: true, amount: true },
    });
    expect(r).toMatchObject({
      boxes: 2,
      boxCost: 1.5,
      extraPrintCost: 3.1,
      after: { totalPriceWithoutTax: 50, profit: 25.4 },
    });
  });

  it("falls back to the country's rate when the payment stores none", async () => {
    h.paymentFindUnique.mockResolvedValueOnce(
      row9253({
        countrycode: 'NL',
        taxRate: null,
        reverseCharge: false,
        totalPrice: 60.5,
        totalPriceWithoutTax: 60.5,
        profit: 40.5,
        printApiPrice: 20,
      })
    );

    const r = await recompute({ dryRun: true });

    expect(h.getTaxRate).toHaveBeenCalledWith('NL');
    expect(r).toMatchObject({
      taxRate: 21,
      taxRateSource: 'country',
      after: { totalPriceWithoutTax: 50, profit: 30 },
    });
  });

  it('refuses a reverse-charge payment whose rate does not come out at 0%', async () => {
    h.paymentFindUnique.mockResolvedValueOnce(row9253({ taxRate: null }));

    const e = await refusal(recompute());

    expect(e.status).toBe(409);
    expect(e.message).toMatch(/reverse-charge payment is charged 0%, but its rate comes out at 19% \(country\)/);
    expect(h.paymentUpdateMany).not.toHaveBeenCalled();
  });

  it('refuses an unknown, an unpaid and an unbooked payment without writing', async () => {
    h.paymentFindUnique.mockResolvedValueOnce(null);
    const notFound = await refusal(recompute());
    expect(notFound.status).toBe(404);

    h.paymentFindUnique.mockResolvedValueOnce(row9253({ status: 'open' }));
    const unpaid = await refusal(recompute());
    expect(unpaid.status).toBe(409);
    expect(unpaid.message).toMatch(/is open/);

    h.paymentFindUnique.mockResolvedValueOnce(row9253({ printApiPrice: 0 }));
    const unbooked = await refusal(recompute());
    expect(unbooked.status).toBe(409);
    expect(unbooked.message).toMatch(/no print cost stored/);

    expect(h.phpFindMany).not.toHaveBeenCalled();
    expect(h.paymentUpdateMany).not.toHaveBeenCalled();
  });
});
