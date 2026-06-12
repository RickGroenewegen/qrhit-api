import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  prisma: {
    brokenLink: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prisma },
}));

import BrokenLink from '../../../src/brokenLink';

const brokenLink = BrokenLink.getInstance();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('logBrokenLink', () => {
  const valid = {
    url: 'https://hitstergame.com/nl/abc/1',
    type: 'invalid' as const,
    errorType: 'not_found',
  };

  it('rejects missing required fields', async () => {
    expect(
      await brokenLink.logBrokenLink({ ...valid, url: '' })
    ).toEqual({ success: false, error: 'Missing required fields' });
    expect(
      await brokenLink.logBrokenLink({ ...valid, errorType: '' })
    ).toEqual({ success: false, error: 'Missing required fields' });
    expect(h.prisma.brokenLink.create).not.toHaveBeenCalled();
  });

  it('rejects unknown type values', async () => {
    const result = await brokenLink.logBrokenLink({
      ...valid,
      type: 'weird' as any,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid type');
  });

  it('deduplicates URLs logged within the last hour', async () => {
    h.prisma.brokenLink.findFirst.mockResolvedValueOnce({ id: 77 });
    const result = await brokenLink.logBrokenLink(valid);
    expect(result).toEqual({ success: true, id: 77 });
    expect(h.prisma.brokenLink.create).not.toHaveBeenCalled();

    // The dedupe window is a gte filter on createdAt
    const where = h.prisma.brokenLink.findFirst.mock.calls[0][0].where;
    expect(where.url).toBe(valid.url);
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(Date.now() - where.createdAt.gte.getTime()).toBeGreaterThanOrEqual(
      3600_000 - 5000
    );
  });

  it('creates a row with null defaults for optional fields', async () => {
    h.prisma.brokenLink.findFirst.mockResolvedValueOnce(null);
    h.prisma.brokenLink.create.mockResolvedValueOnce({ id: 5 });

    const result = await brokenLink.logBrokenLink({
      ...valid,
      type: 'non-retrievable',
      serviceType: undefined,
      userAgent: '',
    });
    expect(result).toEqual({ success: true, id: 5 });
    expect(h.prisma.brokenLink.create).toHaveBeenCalledWith({
      data: {
        url: valid.url,
        type: 'non-retrievable',
        errorType: 'not_found',
        serviceType: null,
        userAgent: null,
      },
    });
  });

  it('maps database errors to a generic failure', async () => {
    h.prisma.brokenLink.findFirst.mockRejectedValueOnce(new Error('db'));
    expect(await brokenLink.logBrokenLink(valid)).toEqual({
      success: false,
      error: 'Failed to log broken link',
    });
  });
});

describe('getBrokenLinks', () => {
  it('applies type/service filters and default pagination', async () => {
    h.prisma.brokenLink.findMany.mockResolvedValueOnce([{ id: 1 }]);
    h.prisma.brokenLink.count.mockResolvedValueOnce(1);

    const result = await brokenLink.getBrokenLinks({
      type: 'invalid',
      serviceType: 'spotify',
    });
    expect(result).toEqual({ success: true, data: [{ id: 1 }], total: 1 });
    expect(h.prisma.brokenLink.findMany).toHaveBeenCalledWith({
      where: { type: 'invalid', serviceType: 'spotify' },
      orderBy: { createdAt: 'desc' },
      take: 50,
      skip: 0,
    });
  });

  it('works without params', async () => {
    h.prisma.brokenLink.findMany.mockResolvedValueOnce([]);
    h.prisma.brokenLink.count.mockResolvedValueOnce(0);
    const result = await brokenLink.getBrokenLinks();
    expect(result).toEqual({ success: true, data: [], total: 0 });
    expect(h.prisma.brokenLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });
});

describe('getBrokenLinksCount', () => {
  it('counts only non-ignored links', async () => {
    h.prisma.brokenLink.count.mockResolvedValueOnce(4);
    expect(await brokenLink.getBrokenLinksCount()).toEqual({
      success: true,
      count: 4,
    });
    expect(h.prisma.brokenLink.count).toHaveBeenCalledWith({
      where: { ignored: false },
    });
  });
});

describe('toggleIgnored', () => {
  it('flips the ignored flag', async () => {
    h.prisma.brokenLink.findUnique.mockResolvedValueOnce({ ignored: false });
    h.prisma.brokenLink.update.mockResolvedValueOnce({ ignored: true });

    expect(await brokenLink.toggleIgnored(3)).toEqual({
      success: true,
      ignored: true,
    });
    expect(h.prisma.brokenLink.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { ignored: true },
    });
  });

  it('returns not-found for unknown ids', async () => {
    h.prisma.brokenLink.findUnique.mockResolvedValueOnce(null);
    expect(await brokenLink.toggleIgnored(99)).toEqual({
      success: false,
      error: 'Broken link not found',
    });
    expect(h.prisma.brokenLink.update).not.toHaveBeenCalled();
  });
});

describe('delete operations', () => {
  it('deletes a single link', async () => {
    h.prisma.brokenLink.delete.mockResolvedValueOnce({});
    expect(await brokenLink.deleteBrokenLink(3)).toEqual({ success: true });
    expect(h.prisma.brokenLink.delete).toHaveBeenCalledWith({ where: { id: 3 } });
  });

  it('reports bulk delete counts', async () => {
    h.prisma.brokenLink.deleteMany.mockResolvedValueOnce({ count: 12 });
    expect(await brokenLink.deleteAllBrokenLinks()).toEqual({
      success: true,
      deleted: 12,
    });
  });

  it('maps delete errors to generic failures', async () => {
    h.prisma.brokenLink.delete.mockRejectedValueOnce(new Error('x'));
    expect(await brokenLink.deleteBrokenLink(3)).toEqual({
      success: false,
      error: 'Failed to delete broken link',
    });
  });
});
