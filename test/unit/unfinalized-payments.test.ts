import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for checkUnfinalizedPayments in src/data/users.ts: the list of
 * orders a saved year may finalize (the Year check page's POST /yearcheck).
 *
 * An order whose generation has not stored its tracks yet has no rows in
 * playlist_has_tracks, so the open-track count is 0 and it looked done. A year
 * saved in those seconds finalized it halfway through generate(): PDFs
 * without QR codes or years, or without any card (October 2026).
 */

vi.mock('../../src/printers/printenbind', () => ({ default: {} }));

import { checkUnfinalizedPayments } from '../../src/data/users';

function makeDeps(uncheckedCount: number) {
  return {
    prisma: {
      payment: {
        findMany: vi.fn(async () => [{ id: 9519, paymentId: 'tr_1' }]),
      },
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ uncheckedCount: BigInt(uncheckedCount) }])
        .mockResolvedValue([]),
    },
    cache: { del: vi.fn(async () => undefined) },
    logger: { log: vi.fn() },
  } as any;
}

describe('checkUnfinalizedPayments', () => {
  let deps: any;

  beforeEach(() => {
    deps = makeDeps(0);
  });

  it('only looks at paid orders whose generation stored their tracks', async () => {
    await checkUnfinalizedPayments(deps);

    expect(deps.prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { finalized: false, status: 'paid', processedFirstTime: true },
      })
    );
  });

  it('returns an order with no open tracks left', async () => {
    expect(await checkUnfinalizedPayments(deps)).toEqual(['tr_1']);
  });

  it('leaves an order with open tracks', async () => {
    deps = makeDeps(4);

    expect(await checkUnfinalizedPayments(deps)).toEqual([]);
  });
});
