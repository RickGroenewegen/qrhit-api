import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/settings.ts (Settings service).
 *
 * Mocks:
 *  - src/prisma → in-memory appSetting stub
 *  - src/cache  → in-memory map mock with lock support
 *  - src/logger → no-op
 */

// ── Cache mock ──────────────────────────────────────────────────────────────
// Simulates the redis-backed cache with an in-memory Map plus a lock Map.
const cacheStore = new Map<string, string>();
const lockStore = new Map<string, boolean>();

// Default implementations – restored in beforeEach so persistent mockResolvedValue
// overrides from one test cannot leak into the next.
function makeCacheMockImpls() {
  return {
    get: async (key: string, _never?: boolean) => cacheStore.get(key) ?? null,
    set: async (key: string, value: string, _ttl?: number) => {
      cacheStore.set(key, value);
    },
    del: async (key: string) => {
      cacheStore.delete(key);
    },
    acquireLock: async (key: string, _ttl?: number): Promise<boolean> => {
      if (lockStore.get(key)) return false;
      lockStore.set(key, true);
      return true;
    },
    releaseLock: async (key: string) => {
      lockStore.delete(key);
    },
  };
}

const cacheMock = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
};

vi.mock('../../src/cache', () => ({
  default: { getInstance: () => cacheMock },
}));

// ── Prisma mock ─────────────────────────────────────────────────────────────
const dbStore = new Map<string, string>();

const prismaMock = {
  appSetting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
};

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

vi.mock('../../src/logger', () => ({
  default: class {
    log = vi.fn();
  },
}));

function makePrismaMockImpls() {
  return {
    findUnique: async ({ where }: any) => {
      const val = dbStore.get(where.key);
      return val !== undefined ? { key: where.key, value: val } : null;
    },
    upsert: async ({ where, update, create }: any) => {
      const val = dbStore.has(where.key) ? update.value : create.value;
      dbStore.set(where.key, val);
    },
    delete: async ({ where }: any) => {
      if (!dbStore.has(where.key)) throw new Error('Record not found');
      dbStore.delete(where.key);
    },
  };
}

let Settings: typeof import('../../src/settings').default;

beforeEach(async () => {
  vi.resetModules();
  cacheStore.clear();
  lockStore.clear();
  dbStore.clear();

  // Restore default implementations so persistent overrides from one test
  // (e.g. mockResolvedValue without Once) cannot leak into the next.
  // clearAllMocks() wipes call counts but also wipes implementations; we
  // re-install them immediately after.
  vi.clearAllMocks();

  const cacheImpls = makeCacheMockImpls();
  cacheMock.get.mockImplementation(cacheImpls.get);
  cacheMock.set.mockImplementation(cacheImpls.set);
  cacheMock.del.mockImplementation(cacheImpls.del);
  cacheMock.acquireLock.mockImplementation(cacheImpls.acquireLock);
  cacheMock.releaseLock.mockImplementation(cacheImpls.releaseLock);

  const prismaImpls = makePrismaMockImpls();
  prismaMock.appSetting.findUnique.mockImplementation(prismaImpls.findUnique);
  prismaMock.appSetting.upsert.mockImplementation(prismaImpls.upsert);
  prismaMock.appSetting.delete.mockImplementation(prismaImpls.delete);

  const mod = await import('../../src/settings');
  Settings = mod.default;
  (Settings as any).instance = undefined;
});

function makeSvc() {
  return Settings.getInstance();
}

// ──────────────────────────────────────────────
// getSetting – cache hit
// ──────────────────────────────────────────────

describe('Settings.getSetting – cache hit', () => {
  it('returns cached value without touching DB', async () => {
    cacheStore.set('setting:spotify_access_token', 'cached-token');
    const svc = makeSvc();
    const val = await svc.getSetting('spotify_access_token');
    expect(val).toBe('cached-token');
    expect(prismaMock.appSetting.findUnique).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// getSetting – cache miss → DB fetch
// ──────────────────────────────────────────────

describe('Settings.getSetting – cache miss', () => {
  it('fetches from DB, stores in cache, returns value', async () => {
    dbStore.set('spotify_access_token', 'db-token');
    const svc = makeSvc();
    const val = await svc.getSetting('spotify_access_token');
    expect(val).toBe('db-token');
    expect(prismaMock.appSetting.findUnique).toHaveBeenCalledWith({
      where: { key: 'spotify_access_token' },
    });
    // Should now be in cache
    expect(cacheStore.get('setting:spotify_access_token')).toBe('db-token');
  });

  it('returns null when key not in DB', async () => {
    const svc = makeSvc();
    const val = await svc.getSetting('tidal_access_token');
    expect(val).toBeNull();
  });

  it('does not cache null values', async () => {
    const svc = makeSvc();
    await svc.getSetting('tidal_access_token');
    expect(cacheStore.has('setting:tidal_access_token')).toBe(false);
  });
});

// ──────────────────────────────────────────────
// getSetting – lock contention (lock not acquired)
// ──────────────────────────────────────────────

describe('Settings.getSetting – lock not acquired → fallback DB read', () => {
  it('falls back to direct DB read after retries when lock is held', async () => {
    // Make lock always unavailable (simulating another worker holds it)
    cacheMock.acquireLock.mockResolvedValue(false);
    dbStore.set('spotify_access_token', 'fallback-val');

    const svc = makeSvc();
    // Retries exhaust and then hits the fallback direct DB read
    const val = await svc.getSetting('spotify_access_token');
    expect(val).toBe('fallback-val');
  });

  it('returns null on fallback DB error when lock is never acquired', async () => {
    cacheMock.acquireLock.mockResolvedValue(false);
    prismaMock.appSetting.findUnique.mockRejectedValueOnce(new Error('DB down'));
    const svc = makeSvc();
    const val = await svc.getSetting('spotify_access_token');
    expect(val).toBeNull();
  });
});

// ──────────────────────────────────────────────
// getSetting – DB error while holding lock
// ──────────────────────────────────────────────

describe('Settings.getSetting – DB error while holding lock', () => {
  it('returns null and releases lock on DB error', async () => {
    prismaMock.appSetting.findUnique.mockRejectedValueOnce(new Error('DB fail'));
    const svc = makeSvc();
    const val = await svc.getSetting('spotify_access_token');
    expect(val).toBeNull();
    // Lock should have been released
    expect(cacheMock.releaseLock).toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// setSetting
// ──────────────────────────────────────────────

describe('Settings.setSetting', () => {
  it('upserts to DB and invalidates cache', async () => {
    cacheStore.set('setting:spotify_access_token', 'old-token');
    const svc = makeSvc();
    await svc.setSetting('spotify_access_token', 'new-token');
    expect(prismaMock.appSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'spotify_access_token' },
        update: { value: 'new-token' },
        create: { key: 'spotify_access_token', value: 'new-token' },
      })
    );
    // Cache key should be invalidated
    expect(cacheStore.has('setting:spotify_access_token')).toBe(false);
    expect(cacheMock.del).toHaveBeenCalledWith('setting:spotify_access_token');
  });

  it('does not throw on DB error (silently logs)', async () => {
    prismaMock.appSetting.upsert.mockRejectedValueOnce(new Error('DB fail'));
    const svc = makeSvc();
    await expect(svc.setSetting('tidal_access_token', 'v')).resolves.not.toThrow();
  });
});

// ──────────────────────────────────────────────
// deleteSetting
// ──────────────────────────────────────────────

describe('Settings.deleteSetting', () => {
  it('deletes from DB and invalidates cache', async () => {
    dbStore.set('spotify_access_token', 'val');
    cacheStore.set('setting:spotify_access_token', 'val');
    const svc = makeSvc();
    await svc.deleteSetting('spotify_access_token');
    expect(prismaMock.appSetting.delete).toHaveBeenCalledWith({
      where: { key: 'spotify_access_token' },
    });
    expect(cacheStore.has('setting:spotify_access_token')).toBe(false);
  });

  it('still invalidates cache even when delete throws (key not found)', async () => {
    prismaMock.appSetting.delete.mockRejectedValueOnce(new Error('Record not found'));
    cacheStore.set('setting:spotify_access_token', 'stale');
    const svc = makeSvc();
    // Should not throw
    await expect(svc.deleteSetting('spotify_access_token')).resolves.not.toThrow();
    // Cache should still be cleared
    expect(cacheMock.del).toHaveBeenCalledWith('setting:spotify_access_token');
  });
});

// ──────────────────────────────────────────────
// getCacheKey (tested indirectly)
// ──────────────────────────────────────────────

describe('Settings cache key format', () => {
  it('uses "setting:<key>" format', async () => {
    dbStore.set('spotify_access_token', 'tok');
    const svc = makeSvc();
    await svc.getSetting('spotify_access_token');
    expect(cacheMock.set).toHaveBeenCalledWith('setting:spotify_access_token', 'tok', expect.any(Number));
  });
});

// ──────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────

describe('Settings singleton', () => {
  it('returns the same instance on repeated calls', () => {
    const svc = makeSvc();
    expect(Settings.getInstance()).toBe(svc);
  });
});
