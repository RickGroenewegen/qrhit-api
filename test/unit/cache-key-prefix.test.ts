import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';

// Map-backed stand-in for the ioredis client, shared by every Cache instance
// the tests create, like one local Redis serving two API configurations.
const { redisStore } = vi.hoisted(() => ({
  redisStore: new Map<string, string>(),
}));

vi.mock('ioredis', () => ({
  default: class FakeRedis {
    constructor(_url: string, _opts: any) {}
    on() {}
    async get(key: string) {
      return redisStore.get(key) ?? null;
    }
    async set(key: string, value: string) {
      redisStore.set(key, value);
      return 'OK';
    }
    async del(...keys: string[]) {
      keys.forEach((key) => redisStore.delete(key));
      return keys.length;
    }
    async keys(pattern: string) {
      const prefix = pattern.replace(/\*$/, '');
      return [...redisStore.keys()].filter((k) => k.startsWith(prefix));
    }
  },
}));

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const savedEnv = { ...process.env };

async function cacheFor(environment: string, database: string) {
  process.env['ENVIRONMENT'] = environment;
  process.env['DATABASE_URL'] = `mysql://user:pass@db.example.com:3306/${database}?connection_limit=5`;
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  vi.resetModules();
  const { default: Cache } = await import('../../src/cache');
  const cache = Cache.getInstance();
  await cache.init();
  return cache;
}

describe('Cache key prefix', () => {
  beforeEach(() => {
    redisStore.clear();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('keeps the bare version prefix in production', async () => {
    const cache = await cacheFor('production', 'qrhit');
    await cache.set('featuredPlaylists_v4_20260929_en', 'live');
    expect([...redisStore.keys()]).toEqual([`${version}:featuredPlaylists_v4_20260929_en`]);
    expect(await cache.get('featuredPlaylists_v4_20260929_en')).toBe('live');
  });

  it('names the database outside production', async () => {
    const cache = await cacheFor('development', 'qrhit_dev');
    await cache.set('featuredPlaylists_v4_20260929_en', 'dev');
    expect([...redisStore.keys()]).toEqual([
      `${version}:qrhit_dev:featuredPlaylists_v4_20260929_en`,
    ]);
    expect(await cache.get('featuredPlaylists_v4_20260929_en')).toBe('dev');
  });

  it('never serves one database its neighbour’s entries on a shared Redis', async () => {
    const onLive = await cacheFor('development', 'qrhit');
    await onLive.set('featuredPlaylists_v4_20260929_en', 'rows from qrhit');

    const onDev = await cacheFor('development', 'qrhit_dev');
    expect(await onDev.get('featuredPlaylists_v4_20260929_en')).toBeNull();
  });

  it('scopes pattern deletes to its own database', async () => {
    const onLive = await cacheFor('development', 'qrhit');
    await onLive.set('featuredPlaylists_a', '1');
    const onDev = await cacheFor('development', 'qrhit_dev');
    await onDev.set('featuredPlaylists_a', '1');

    await onDev.delPattern('featuredPlaylists_*');

    expect([...redisStore.keys()]).toEqual([`${version}:qrhit:featuredPlaylists_a`]);
  });
});
