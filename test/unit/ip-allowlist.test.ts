import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/ipAllowlist.ts, the table of addresses the AbuseGuard
 * must never ban.
 */

const prismaMock = vi.hoisted(() => ({
  allowedIp: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

vi.mock('../../src/logger', () => ({
  default: class {
    log = vi.fn();
  },
}));

let IpAllowlist: typeof import('../../src/ipAllowlist').default;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const mod = await import('../../src/ipAllowlist');
  IpAllowlist = mod.default;
  (IpAllowlist as any).instance = undefined;
});

describe('getAllowedIps', () => {
  it('lower-cases every address for the guard to match against', async () => {
    prismaMock.allowedIp.findMany.mockResolvedValue([
      { ip: '2A06:98C0:3600::103' },
      { ip: '5.5.5.5' },
    ]);

    const ips = await IpAllowlist.getInstance().getAllowedIps();

    expect(ips).toEqual(['2a06:98c0:3600::103', '5.5.5.5']);
  });

  it('lets a database error surface so the guard keeps its last snapshot', async () => {
    prismaMock.allowedIp.findMany.mockRejectedValue(new Error('db down'));

    await expect(IpAllowlist.getInstance().getAllowedIps()).rejects.toThrow(
      'db down',
    );
  });
});

describe('add', () => {
  it('whitelists an address with its note', async () => {
    prismaMock.allowedIp.upsert.mockResolvedValue({ id: 1 });

    const result = await IpAllowlist.getInstance().add('5.5.5.5', 'A Customer');

    expect(result).toEqual({ success: true });
    expect(prismaMock.allowedIp.upsert).toHaveBeenCalledWith({
      where: { ip: '5.5.5.5' },
      update: { note: 'A Customer' },
      create: { ip: '5.5.5.5', note: 'A Customer' },
    });
  });

  it('trims the address and is not an error the second time', async () => {
    prismaMock.allowedIp.upsert.mockResolvedValue({ id: 1 });

    const first = await IpAllowlist.getInstance().add('  5.5.5.5  ');
    const second = await IpAllowlist.getInstance().add('5.5.5.5');

    expect(first).toEqual({ success: true });
    expect(second).toEqual({ success: true });
    expect(prismaMock.allowedIp.upsert.mock.calls[0][0].where.ip).toBe(
      '5.5.5.5',
    );
  });

  it('rejects an empty address without touching the database', async () => {
    const result = await IpAllowlist.getInstance().add('   ');

    expect(result).toEqual({ success: false, error: 'No IP given' });
    expect(prismaMock.allowedIp.upsert).not.toHaveBeenCalled();
  });

  it('reports a failure instead of throwing', async () => {
    prismaMock.allowedIp.upsert.mockRejectedValue(new Error('db down'));

    const result = await IpAllowlist.getInstance().add('5.5.5.5');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to allow ip');
  });
});

describe('remove', () => {
  it('takes the address off the whitelist', async () => {
    prismaMock.allowedIp.deleteMany.mockResolvedValue({ count: 1 });

    const result = await IpAllowlist.getInstance().remove('5.5.5.5');

    expect(result).toEqual({ success: true });
    expect(prismaMock.allowedIp.deleteMany).toHaveBeenCalledWith({
      where: { ip: '5.5.5.5' },
    });
  });

  it('succeeds when the address was not on the list', async () => {
    prismaMock.allowedIp.deleteMany.mockResolvedValue({ count: 0 });

    const result = await IpAllowlist.getInstance().remove('9.9.9.9');

    expect(result).toEqual({ success: true });
  });

  it('rejects an empty address', async () => {
    const result = await IpAllowlist.getInstance().remove('');

    expect(result).toEqual({ success: false, error: 'No IP given' });
    expect(prismaMock.allowedIp.deleteMany).not.toHaveBeenCalled();
  });
});

describe('list', () => {
  it('returns the records newest first', async () => {
    prismaMock.allowedIp.findMany.mockResolvedValue([{ id: 2 }, { id: 1 }]);

    const result = await IpAllowlist.getInstance().list();

    expect(result.success).toBe(true);
    expect(prismaMock.allowedIp.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
    });
  });

  it('reports a failure instead of throwing', async () => {
    prismaMock.allowedIp.findMany.mockRejectedValue(new Error('db down'));

    const result = await IpAllowlist.getInstance().list();

    expect(result.success).toBe(false);
  });
});
