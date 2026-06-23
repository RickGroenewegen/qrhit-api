import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/brokenLink.ts.
 *
 * All I/O is mocked at module level:
 *  - src/prisma  → in-memory brokenLink model stub
 *  - src/logger  → no-op
 */

const prismaMock = vi.hoisted(() => ({
  brokenLink: {
    findFirst: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
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

// Reset singleton between tests
let BrokenLink: typeof import('../../src/brokenLink').default;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const mod = await import('../../src/brokenLink');
  BrokenLink = mod.default;
  // Reset singleton so each test gets a fresh instance
  (BrokenLink as any).instance = undefined;
});

function makeSvc() {
  return BrokenLink.getInstance();
}

// ──────────────────────────────────────────────
// logBrokenLink
// ──────────────────────────────────────────────

describe('BrokenLink.logBrokenLink', () => {
  it('returns error when required fields are missing', async () => {
    const svc = makeSvc();
    const res = await svc.logBrokenLink({ url: '', type: 'invalid', errorType: '404' });
    expect(res).toEqual({ success: false, error: 'Missing required fields' });
    expect(prismaMock.brokenLink.findFirst).not.toHaveBeenCalled();
  });

  it('returns error when type is invalid', async () => {
    const svc = makeSvc();
    const res = await svc.logBrokenLink({ url: 'https://x.com', type: 'invalid', errorType: '' });
    expect(res).toEqual({ success: false, error: 'Missing required fields' });
  });

  it('returns existing id when duplicate within one hour', async () => {
    prismaMock.brokenLink.findFirst.mockResolvedValueOnce({ id: 42, url: 'https://x.com' });
    const svc = makeSvc();
    const res = await svc.logBrokenLink({ url: 'https://x.com', type: 'invalid', errorType: '404' });
    expect(res).toEqual({ success: true, id: 42 });
    expect(prismaMock.brokenLink.create).not.toHaveBeenCalled();
  });

  it('creates a new broken link when no duplicate exists', async () => {
    prismaMock.brokenLink.findFirst.mockResolvedValueOnce(null);
    prismaMock.brokenLink.create.mockResolvedValueOnce({ id: 99 });
    const svc = makeSvc();
    const res = await svc.logBrokenLink({
      url: 'https://y.com',
      type: 'non-retrievable',
      errorType: '500',
      serviceType: 'spotify',
      userAgent: 'Mozilla/5.0',
    });
    expect(res).toEqual({ success: true, id: 99 });
    expect(prismaMock.brokenLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        url: 'https://y.com',
        type: 'non-retrievable',
        errorType: '500',
        serviceType: 'spotify',
        userAgent: 'Mozilla/5.0',
      }),
    });
  });

  it('sets serviceType and userAgent to null when not provided', async () => {
    prismaMock.brokenLink.findFirst.mockResolvedValueOnce(null);
    prismaMock.brokenLink.create.mockResolvedValueOnce({ id: 1 });
    const svc = makeSvc();
    await svc.logBrokenLink({ url: 'https://z.com', type: 'invalid', errorType: 'DNS' });
    expect(prismaMock.brokenLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ serviceType: null, userAgent: null }),
    });
  });

  it('returns error on db exception', async () => {
    prismaMock.brokenLink.findFirst.mockRejectedValueOnce(new Error('DB down'));
    const svc = makeSvc();
    const res = await svc.logBrokenLink({ url: 'https://a.com', type: 'invalid', errorType: '404' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Failed to log broken link');
  });
});

// ──────────────────────────────────────────────
// getBrokenLinks
// ──────────────────────────────────────────────

describe('BrokenLink.getBrokenLinks', () => {
  it('returns paginated data with totals', async () => {
    const fakeData = [{ id: 1 }, { id: 2 }];
    prismaMock.brokenLink.findMany.mockResolvedValueOnce(fakeData);
    prismaMock.brokenLink.count.mockResolvedValueOnce(2);
    const svc = makeSvc();
    const res = await svc.getBrokenLinks({ limit: 10, offset: 0 });
    expect(res).toEqual({ success: true, data: fakeData, total: 2 });
  });

  it('applies type and serviceType filters', async () => {
    prismaMock.brokenLink.findMany.mockResolvedValueOnce([]);
    prismaMock.brokenLink.count.mockResolvedValueOnce(0);
    const svc = makeSvc();
    await svc.getBrokenLinks({ type: 'invalid', serviceType: 'spotify' });
    expect(prismaMock.brokenLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { type: 'invalid', serviceType: 'spotify' },
      })
    );
  });

  it('uses default limit 50, offset 0 when no params', async () => {
    prismaMock.brokenLink.findMany.mockResolvedValueOnce([]);
    prismaMock.brokenLink.count.mockResolvedValueOnce(0);
    const svc = makeSvc();
    await svc.getBrokenLinks();
    expect(prismaMock.brokenLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, skip: 0 })
    );
  });

  it('returns error on db exception', async () => {
    prismaMock.brokenLink.findMany.mockRejectedValueOnce(new Error('DB err'));
    const svc = makeSvc();
    const res = await svc.getBrokenLinks();
    expect(res.success).toBe(false);
    expect(res.error).toContain('Failed to fetch broken links');
  });
});

// ──────────────────────────────────────────────
// getBrokenLinksCount
// ──────────────────────────────────────────────

describe('BrokenLink.getBrokenLinksCount', () => {
  it('counts only non-ignored links', async () => {
    prismaMock.brokenLink.count.mockResolvedValueOnce(7);
    const svc = makeSvc();
    const res = await svc.getBrokenLinksCount();
    expect(res).toEqual({ success: true, count: 7 });
    expect(prismaMock.brokenLink.count).toHaveBeenCalledWith({ where: { ignored: false } });
  });

  it('returns error on exception', async () => {
    prismaMock.brokenLink.count.mockRejectedValueOnce(new Error('fail'));
    const svc = makeSvc();
    const res = await svc.getBrokenLinksCount();
    expect(res.success).toBe(false);
  });
});

// ──────────────────────────────────────────────
// toggleIgnored
// ──────────────────────────────────────────────

describe('BrokenLink.toggleIgnored', () => {
  it('returns not-found when link does not exist', async () => {
    prismaMock.brokenLink.findUnique.mockResolvedValueOnce(null);
    const svc = makeSvc();
    const res = await svc.toggleIgnored(999);
    expect(res).toEqual({ success: false, error: 'Broken link not found' });
  });

  it('flips ignored from false to true', async () => {
    prismaMock.brokenLink.findUnique.mockResolvedValueOnce({ ignored: false });
    prismaMock.brokenLink.update.mockResolvedValueOnce({ ignored: true });
    const svc = makeSvc();
    const res = await svc.toggleIgnored(1);
    expect(res).toEqual({ success: true, ignored: true });
    expect(prismaMock.brokenLink.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { ignored: true },
    });
  });

  it('flips ignored from true to false', async () => {
    prismaMock.brokenLink.findUnique.mockResolvedValueOnce({ ignored: true });
    prismaMock.brokenLink.update.mockResolvedValueOnce({ ignored: false });
    const svc = makeSvc();
    const res = await svc.toggleIgnored(2);
    expect(res).toEqual({ success: true, ignored: false });
  });

  it('returns error on db exception', async () => {
    prismaMock.brokenLink.findUnique.mockRejectedValueOnce(new Error('db'));
    const svc = makeSvc();
    const res = await svc.toggleIgnored(3);
    expect(res.success).toBe(false);
  });
});

// ──────────────────────────────────────────────
// deleteBrokenLink
// ──────────────────────────────────────────────

describe('BrokenLink.deleteBrokenLink', () => {
  it('deletes a link by id', async () => {
    prismaMock.brokenLink.delete.mockResolvedValueOnce({});
    const svc = makeSvc();
    const res = await svc.deleteBrokenLink(5);
    expect(res).toEqual({ success: true });
    expect(prismaMock.brokenLink.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });

  it('returns error on db exception', async () => {
    prismaMock.brokenLink.delete.mockRejectedValueOnce(new Error('fail'));
    const svc = makeSvc();
    const res = await svc.deleteBrokenLink(5);
    expect(res.success).toBe(false);
  });
});

// ──────────────────────────────────────────────
// deleteAllBrokenLinks
// ──────────────────────────────────────────────

describe('BrokenLink.deleteAllBrokenLinks', () => {
  it('deletes all links and returns count', async () => {
    prismaMock.brokenLink.deleteMany.mockResolvedValueOnce({ count: 12 });
    const svc = makeSvc();
    const res = await svc.deleteAllBrokenLinks();
    expect(res).toEqual({ success: true, deleted: 12 });
  });

  it('returns error on db exception', async () => {
    prismaMock.brokenLink.deleteMany.mockRejectedValueOnce(new Error('fail'));
    const svc = makeSvc();
    const res = await svc.deleteAllBrokenLinks();
    expect(res.success).toBe(false);
  });
});
