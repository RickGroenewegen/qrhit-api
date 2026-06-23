import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Redis-backed cache singleton: AbuseGuard uses increment +
// sorted-set helpers only.
const cacheMock = vi.hoisted(() => ({
  increment: vi.fn(),
  pruneSortedSet: vi.fn().mockResolvedValue(undefined),
  getSortedSetWithScores: vi.fn().mockResolvedValue([]),
  addToSortedSet: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/cache', () => ({
  default: { getInstance: () => cacheMock },
}));

import AbuseGuard from '../../src/abuse_guard';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Reset the singleton so each test exercises a fresh constructor/env. */
function freshGuard(): AbuseGuard {
  (AbuseGuard as any).instance = undefined;
  return AbuseGuard.getInstance();
}

const ENV_KEYS = [
  'QRLINK_RATE_WINDOW_SECONDS',
  'QRLINK_RATE_MAX',
  'QRLINK_BAN_SECONDS',
  'QRLINK_BAN_REFRESH_SECONDS',
  'QRLINK_BLOCKED_USER_AGENTS',
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  cacheMock.increment.mockReset();
  cacheMock.pruneSortedSet.mockReset().mockResolvedValue(undefined);
  cacheMock.getSortedSetWithScores.mockReset().mockResolvedValue([]);
  cacheMock.addToSortedSet.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.useRealTimers();
});

describe('ban mirror priming', () => {
  it('mirrors unexpired Redis bans and drops expired ones', async () => {
    const future = Date.now() + 60_000;
    const past = Date.now() - 1;
    cacheMock.getSortedSetWithScores.mockResolvedValue([
      { member: '1.1.1.1', score: future },
      { member: '2.2.2.2', score: past },
    ]);
    const guard = freshGuard();
    await flush();

    expect(cacheMock.pruneSortedSet).toHaveBeenCalledWith(
      'banned_ips_z',
      expect.any(Number)
    );
    expect(guard.isBanned('1.1.1.1')).toBe(true);
    expect(guard.isBanned('2.2.2.2')).toBe(false);
    expect(guard.isBanned('')).toBe(false);
  });

  it('fails open while the mirror has never loaded (Redis down)', async () => {
    cacheMock.getSortedSetWithScores.mockRejectedValue(new Error('redis gone'));
    const guard = freshGuard();
    await flush();
    // Even a locally recorded ban is not enforced until the mirror loads
    await guard.ban('3.3.3.3', 'test');
    expect(guard.isBanned('3.3.3.3')).toBe(false);
  });
});

describe('user-agent blocklist', () => {
  it('bans the default scraper UA on sight (case-insensitive substring)', async () => {
    const guard = freshGuard();
    await flush();
    const result = await guard.check('9.9.9.9', 'hitify-qrsong-sync/1.2');
    expect(result).toEqual({ allowed: false, reason: 'user-agent' });
    expect(guard.isBanned('9.9.9.9')).toBe(true);
    expect(cacheMock.addToSortedSet).toHaveBeenCalledWith(
      'banned_ips_z',
      expect.any(Number),
      '9.9.9.9'
    );
    // UA bans never consume the rate-limit counter
    expect(cacheMock.increment).not.toHaveBeenCalled();
  });

  it('honors extra blocked agents from the env (comma separated)', async () => {
    process.env['QRLINK_BLOCKED_USER_AGENTS'] = ' EvilBot , OtherBot ';
    const guard = freshGuard();
    await flush();
    expect(await guard.check('8.8.8.8', 'Mozilla EVILBOT 2.0')).toEqual({
      allowed: false,
      reason: 'user-agent',
    });
  });

  it('allows a normal browser user agent', async () => {
    const guard = freshGuard();
    await flush();
    cacheMock.increment.mockResolvedValue(1);
    expect(await guard.check('7.7.7.7', 'Mozilla/5.0 Safari')).toEqual({
      allowed: true,
    });
  });
});

describe('rate limiting', () => {
  it('allows requests at the limit and bans the request over it', async () => {
    process.env['QRLINK_RATE_MAX'] = '3';
    process.env['QRLINK_RATE_WINDOW_SECONDS'] = '60';
    const guard = freshGuard();
    await flush();

    cacheMock.increment.mockResolvedValue(3);
    expect(await guard.check('5.5.5.5', 'ua')).toEqual({ allowed: true });
    expect(cacheMock.increment).toHaveBeenCalledWith('qrlink_rl:5.5.5.5', 60);
    expect(guard.isBanned('5.5.5.5')).toBe(false);

    cacheMock.increment.mockResolvedValue(4);
    expect(await guard.check('5.5.5.5', 'ua')).toEqual({
      allowed: false,
      reason: 'rate-limit',
    });
    expect(guard.isBanned('5.5.5.5')).toBe(true);
  });

  it('ignores invalid env overrides and keeps the defaults', async () => {
    process.env['QRLINK_RATE_MAX'] = '-5';
    process.env['QRLINK_RATE_WINDOW_SECONDS'] = 'abc';
    const guard = freshGuard();
    await flush();

    // default max is 30, window 60
    cacheMock.increment.mockResolvedValue(30);
    expect(await guard.check('4.4.4.4', 'ua')).toEqual({ allowed: true });
    expect(cacheMock.increment).toHaveBeenCalledWith('qrlink_rl:4.4.4.4', 60);
    cacheMock.increment.mockResolvedValue(31);
    expect((await guard.check('4.4.4.4', 'ua')).allowed).toBe(false);
  });

  it('skips counting when the client IP is empty', async () => {
    const guard = freshGuard();
    await flush();
    expect(await guard.check('', 'ua')).toEqual({ allowed: true });
    expect(cacheMock.increment).not.toHaveBeenCalled();
  });

  it('fails open when the counter increment throws', async () => {
    const guard = freshGuard();
    await flush();
    cacheMock.increment.mockRejectedValue(new Error('redis timeout'));
    expect(await guard.check('6.6.6.6', 'ua')).toEqual({ allowed: true });
    expect(guard.isBanned('6.6.6.6')).toBe(false);
  });
});

describe('ban', () => {
  it('is a no-op for an empty IP', async () => {
    const guard = freshGuard();
    await flush();
    await guard.ban('', 'reason');
    expect(cacheMock.addToSortedSet).not.toHaveBeenCalled();
  });

  it('does not re-persist an already active ban', async () => {
    const guard = freshGuard();
    await flush();
    await guard.ban('1.2.3.4', 'first');
    await guard.ban('1.2.3.4', 'second');
    expect(cacheMock.addToSortedSet).toHaveBeenCalledTimes(1);
  });

  it('keeps the local ban even if Redis persistence fails', async () => {
    const guard = freshGuard();
    await flush();
    cacheMock.addToSortedSet.mockRejectedValue(new Error('write failed'));
    await expect(guard.ban('2.3.4.5', 'r')).resolves.toBeUndefined();
    expect(guard.isBanned('2.3.4.5')).toBe(true);
  });

  it('expires locally after banSeconds (lazy delete)', async () => {
    process.env['QRLINK_BAN_SECONDS'] = '100';
    const guard = freshGuard();
    await flush();
    await guard.ban('3.4.5.6', 'r');
    expect(guard.isBanned('3.4.5.6')).toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 101_000);
    expect(guard.isBanned('3.4.5.6')).toBe(false);
    // and it stays unbanned (entry was deleted from the mirror)
    expect(guard.isBanned('3.4.5.6')).toBe(false);
  });
});
