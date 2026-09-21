import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/blockedIp.ts.
 *
 * All I/O is mocked at module level:
 *  - src/prisma      → in-memory blockedIp / paymentHasPlaylist stubs
 *  - src/ipAllowlist → the whitelist the overview marks rows against
 *  - src/logger      → no-op
 */

const prismaMock = vi.hoisted(() => ({
  blockedIp: {
    findFirst: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
  },
  paymentHasPlaylist: {
    findMany: vi.fn(),
  },
}));

const allowlistMock = vi.hoisted(() => ({
  getAllowedIps: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

vi.mock('../../src/ipAllowlist', () => ({
  default: { getInstance: () => allowlistMock },
}));

vi.mock('../../src/logger', () => ({
  default: class {
    log = vi.fn();
  },
}));

let BlockedIp: typeof import('../../src/blockedIp').default;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  allowlistMock.getAllowedIps.mockResolvedValue([]);
  const mod = await import('../../src/blockedIp');
  BlockedIp = mod.default;
  (BlockedIp as any).instance = undefined;
});

describe('logBlock', () => {
  it('writes the block with everything the dashboard shows', async () => {
    prismaMock.blockedIp.findFirst.mockResolvedValue(null);
    prismaMock.blockedIp.create.mockResolvedValue({ id: 1 });

    const expiresAt = new Date('2026-09-27T00:00:00Z');
    await BlockedIp.getInstance().logBlock({
      ip: '1.2.3.4',
      reason: 'enumeration',
      detail: 'sequential track ids: 10 ascending requests',
      userAgent: 'Mozilla/5.0',
      php: 8817,
      trackId: 392351,
      expiresAt,
    });

    expect(prismaMock.blockedIp.create).toHaveBeenCalledWith({
      data: {
        ip: '1.2.3.4',
        reason: 'enumeration',
        detail: 'sequential track ids: 10 ascending requests',
        userAgent: 'Mozilla/5.0',
        php: 8817,
        trackId: 392351,
        expiresAt,
      },
    });
  });

  it('collapses the same address and reason reported by several workers', async () => {
    prismaMock.blockedIp.findFirst.mockResolvedValue({ id: 7 });

    await BlockedIp.getInstance().logBlock({
      ip: '1.2.3.4',
      reason: 'rate-limit',
    });

    expect(prismaMock.blockedIp.create).not.toHaveBeenCalled();
  });

  it('stores nulls rather than undefined for the optional columns', async () => {
    prismaMock.blockedIp.findFirst.mockResolvedValue(null);
    prismaMock.blockedIp.create.mockResolvedValue({ id: 1 });

    await BlockedIp.getInstance().logBlock({ ip: '1.2.3.4', reason: 'denylist' });

    expect(prismaMock.blockedIp.create).toHaveBeenCalledWith({
      data: {
        ip: '1.2.3.4',
        reason: 'denylist',
        detail: null,
        userAgent: null,
        php: null,
        trackId: null,
        expiresAt: null,
      },
    });
  });

  it('ignores a call with no ip or no reason', async () => {
    await BlockedIp.getInstance().logBlock({ ip: '', reason: 'denylist' });
    await BlockedIp.getInstance().logBlock({ ip: '1.2.3.4', reason: '' });
    expect(prismaMock.blockedIp.findFirst).not.toHaveBeenCalled();
  });

  it('never throws when the database is down', async () => {
    prismaMock.blockedIp.findFirst.mockRejectedValue(new Error('db down'));

    await expect(
      BlockedIp.getInstance().logBlock({ ip: '1.2.3.4', reason: 'rate-limit' }),
    ).resolves.toBeUndefined();
  });
});

describe('getBlockedIps', () => {
  it('resolves each php into the order and playlist behind it', async () => {
    prismaMock.blockedIp.findMany.mockResolvedValue([
      { id: 1, ip: '1.2.3.4', reason: 'enumeration', php: 8817 },
    ]);
    prismaMock.blockedIp.count.mockResolvedValue(1);
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([
      {
        id: 8817,
        numberOfTracks: 120,
        playlist: { id: 5, name: 'Party Mix', slug: 'party-mix' },
        payment: {
          id: 42,
          paymentId: 'tr_abc',
          orderId: 'QR-2026-42',
          fullname: 'A Customer',
          email: 'customer@example.com',
          createdAt: new Date('2026-09-01T00:00:00Z'),
        },
      },
    ]);

    const result = await BlockedIp.getInstance().getBlockedIps();

    expect(result.success).toBe(true);
    expect(result.data![0].scan).toEqual({
      playlistId: 5,
      playlistName: 'Party Mix',
      playlistSlug: 'party-mix',
      numberOfTracks: 120,
      paymentId: 42,
      orderId: 'QR-2026-42',
      customerName: 'A Customer',
      customerEmail: 'customer@example.com',
      orderedAt: new Date('2026-09-01T00:00:00Z'),
    });
  });

  it('looks the whole page up in one query', async () => {
    prismaMock.blockedIp.findMany.mockResolvedValue([
      { id: 1, ip: '1.1.1.1', php: 10 },
      { id: 2, ip: '2.2.2.2', php: 11 },
      { id: 3, ip: '3.3.3.3', php: 10 }, // same order as the first
      { id: 4, ip: '4.4.4.4', php: null },
    ]);
    prismaMock.blockedIp.count.mockResolvedValue(4);
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([]);

    await BlockedIp.getInstance().getBlockedIps();

    expect(prismaMock.paymentHasPlaylist.findMany).toHaveBeenCalledTimes(1);
    // Deduplicated, and the row without a php is not looked up.
    expect(
      prismaMock.paymentHasPlaylist.findMany.mock.calls[0][0].where.id.in,
    ).toEqual([10, 11]);
  });

  it('leaves scan null when the row has no php', async () => {
    prismaMock.blockedIp.findMany.mockResolvedValue([
      { id: 1, ip: '1.2.3.4', reason: 'denylist', php: null },
    ]);
    prismaMock.blockedIp.count.mockResolvedValue(1);

    const result = await BlockedIp.getInstance().getBlockedIps();

    expect(result.data![0].scan).toBeNull();
    expect(prismaMock.paymentHasPlaylist.findMany).not.toHaveBeenCalled();
  });

  it('leaves scan null when the order has since been deleted', async () => {
    prismaMock.blockedIp.findMany.mockResolvedValue([
      { id: 1, ip: '1.2.3.4', php: 9999 },
    ]);
    prismaMock.blockedIp.count.mockResolvedValue(1);
    prismaMock.paymentHasPlaylist.findMany.mockResolvedValue([]);

    const result = await BlockedIp.getInstance().getBlockedIps();

    expect(result.data![0].scan).toBeNull();
  });

  it('marks the rows whose address is whitelisted, ignoring case', async () => {
    prismaMock.blockedIp.findMany.mockResolvedValue([
      { id: 1, ip: '2A06:98C0:3600::103', php: null },
      { id: 2, ip: '5.5.5.5', php: null },
    ]);
    prismaMock.blockedIp.count.mockResolvedValue(2);
    allowlistMock.getAllowedIps.mockResolvedValue(['2a06:98c0:3600::103']);

    const result = await BlockedIp.getInstance().getBlockedIps();

    expect(result.data![0].allowed).toBe(true);
    expect(result.data![1].allowed).toBe(false);
  });

  it('filters by reason and searches by partial ip', async () => {
    prismaMock.blockedIp.findMany.mockResolvedValue([]);
    prismaMock.blockedIp.count.mockResolvedValue(0);

    await BlockedIp.getInstance().getBlockedIps({
      reason: 'enumeration',
      ip: '2a06',
      limit: 10,
      offset: 20,
    });

    const args = prismaMock.blockedIp.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      ip: { contains: '2a06' },
      reason: 'enumeration',
    });
    expect(args.take).toBe(10);
    expect(args.skip).toBe(20);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('reports a failure instead of throwing', async () => {
    prismaMock.blockedIp.findMany.mockRejectedValue(new Error('db down'));

    const result = await BlockedIp.getInstance().getBlockedIps();

    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to fetch blocked ips');
  });
});

describe('deleteBlockedIp', () => {
  it('deletes the record by id', async () => {
    prismaMock.blockedIp.delete.mockResolvedValue({ id: 3 });

    const result = await BlockedIp.getInstance().deleteBlockedIp(3);

    expect(result).toEqual({ success: true });
    expect(prismaMock.blockedIp.delete).toHaveBeenCalledWith({
      where: { id: 3 },
    });
  });

  it('reports a failure instead of throwing', async () => {
    prismaMock.blockedIp.delete.mockRejectedValue(new Error('gone'));

    const result = await BlockedIp.getInstance().deleteBlockedIp(3);

    expect(result.success).toBe(false);
  });
});
