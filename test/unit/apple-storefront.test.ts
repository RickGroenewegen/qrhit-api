import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/appleStorefront.ts (AppleStorefront).
 *
 * Mocks:
 *  - src/prisma → $queryRaw stub
 *
 * AppleStorefront uses an in-memory Map for caching (no Redis needed).
 */

const queryRawResult: any[] = [];

const prismaMock = {
  $queryRaw: vi.fn(async () => queryRawResult),
};

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

import AppleStorefront from '../../src/appleStorefront';

beforeEach(() => {
  vi.clearAllMocks();
  queryRawResult.length = 0;
  // Reset singleton to get a fresh in-memory cache
  (AppleStorefront as any).instance = undefined;
  prismaMock.$queryRaw.mockImplementation(async () => queryRawResult);
});

function makeSvc() {
  return AppleStorefront.getInstance();
}

// ──────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────

describe('AppleStorefront singleton', () => {
  it('returns the same instance on repeated calls', () => {
    const svc = makeSvc();
    expect(AppleStorefront.getInstance()).toBe(svc);
  });
});

// ──────────────────────────────────────────────
// getStorefront
// ──────────────────────────────────────────────

describe('AppleStorefront.getStorefront', () => {
  it('returns the appleStoreFront value from DB', async () => {
    queryRawResult.push({ appleStoreFront: 'nl' });
    const svc = makeSvc();
    const result = await svc.getStorefront(1);
    expect(result).toBe('nl');
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns null when DB result is empty', async () => {
    // queryRawResult is empty
    const svc = makeSvc();
    const result = await svc.getStorefront(2);
    expect(result).toBeNull();
  });

  it('returns null when appleStoreFront is falsy (empty string)', async () => {
    queryRawResult.push({ appleStoreFront: '' });
    const svc = makeSvc();
    const result = await svc.getStorefront(3);
    expect(result).toBeNull();
  });

  it('caches the result so DB is not queried again for the same phpId', async () => {
    queryRawResult.push({ appleStoreFront: 'de' });
    const svc = makeSvc();
    await svc.getStorefront(10);
    await svc.getStorefront(10); // second call - should use cache
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('queries DB for different phpIds independently', async () => {
    queryRawResult.push({ appleStoreFront: 'fr' });
    const svc = makeSvc();
    await svc.getStorefront(10);
    queryRawResult.length = 0;
    queryRawResult.push({ appleStoreFront: 'es' });
    const result2 = await svc.getStorefront(20);
    expect(result2).toBe('es');
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('caches null result (no re-query for missing entries)', async () => {
    // Empty result → returns null
    const svc = makeSvc();
    await svc.getStorefront(99);
    await svc.getStorefront(99); // second call
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────
// setStorefront
// ──────────────────────────────────────────────

describe('AppleStorefront.setStorefront', () => {
  it('stores the storefront in cache so DB is not queried on next getStorefront', async () => {
    const svc = makeSvc();
    svc.setStorefront(5, 'gb');
    const result = await svc.getStorefront(5);
    expect(result).toBe('gb');
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it('overwrites a previously cached value', async () => {
    queryRawResult.push({ appleStoreFront: 'nl' });
    const svc = makeSvc();
    await svc.getStorefront(7);
    svc.setStorefront(7, 'be');
    const result = await svc.getStorefront(7);
    expect(result).toBe('be');
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1); // DB only for first call
  });
});
