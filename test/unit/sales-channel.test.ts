import { describe, it, expect, vi } from 'vitest';

/**
 * Unit tests for src/salesChannel.ts: the reports' Website / App toggle.
 * The SQL fragments go into raw report queries, so anything the query string
 * carries other than web or app must read as all and add nothing.
 */

import {
  channelSql,
  filterLedgerByChannel,
  ledgerChannelCondition,
  ledgerChannelSql,
  parseSalesChannel,
  paymentChannelWhere,
} from '../../src/salesChannel';

describe('parseSalesChannel', () => {
  it('reads web and app, and anything else as all', () => {
    expect(parseSalesChannel('web')).toBe('web');
    expect(parseSalesChannel('app')).toBe('app');
    expect(parseSalesChannel('all')).toBe('all');
    expect(parseSalesChannel(undefined)).toBe('all');
    expect(parseSalesChannel("app' OR '1'='1")).toBe('all');
    expect(parseSalesChannel(['app'])).toBe('all');
  });
});

describe('payments conditions', () => {
  it('web is a null channel, app is "app", all adds nothing', () => {
    expect(channelSql('web', 'p')).toBe(' AND p.channel IS NULL');
    expect(channelSql('app', 'p')).toBe(" AND p.channel = 'app'");
    expect(channelSql('app')).toBe(" AND channel = 'app'");
    expect(channelSql('all', 'p')).toBe('');
    expect(paymentChannelWhere('web')).toEqual({ channel: null });
    expect(paymentChannelWhere('app')).toEqual({ channel: 'app' });
    expect(paymentChannelWhere('all')).toEqual({});
  });
});

describe('ledger conditions', () => {
  it('follows the order a purchase came with; one without an order is the website', () => {
    const appOrder =
      "EXISTS (SELECT 1 FROM payments cp WHERE cp.id = gp.paymentId AND cp.channel = 'app')";
    expect(ledgerChannelCondition('app', 'gp')).toBe(appOrder);
    expect(ledgerChannelCondition('web', 'gp')).toBe(`NOT ${appOrder}`);
    expect(ledgerChannelCondition('all', 'gp')).toBeNull();
    expect(ledgerChannelSql('web', 'gp')).toBe(` AND NOT ${appOrder}`);
    expect(ledgerChannelSql('all', 'gp')).toBe('');
  });

  it('filters rows read through Prisma by the app orders among theirs', async () => {
    const prisma = {
      payment: { findMany: vi.fn(async () => [{ id: 40 }]) },
    };
    const rows = [
      { paymentId: 40, n: 'app order' },
      { paymentId: 41, n: 'website order' },
      { paymentId: null, n: 'on the account' },
      { paymentId: 40, n: 'app order again' },
    ];

    const app = await filterLedgerByChannel(prisma as any, rows, 'app');
    expect(app.map((r) => r.n)).toEqual(['app order', 'app order again']);
    expect(prisma.payment.findMany).toHaveBeenCalledWith({
      where: { id: { in: [40, 41] }, channel: 'app' },
      select: { id: true },
    });

    const web = await filterLedgerByChannel(prisma as any, rows, 'web');
    expect(web.map((r) => r.n)).toEqual(['website order', 'on the account']);

    prisma.payment.findMany.mockClear();
    expect(await filterLedgerByChannel(prisma as any, rows, 'all')).toBe(rows);
    expect(
      await filterLedgerByChannel(prisma as any, [{ paymentId: null }], 'web')
    ).toEqual([{ paymentId: null }]);
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });
});
