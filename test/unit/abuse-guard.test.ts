import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Redis-backed cache singleton: AbuseGuard uses increment +
// sorted-set helpers only.
const cacheMock = vi.hoisted(() => ({
  increment: vi.fn(),
  pruneSortedSet: vi.fn().mockResolvedValue(undefined),
  getSortedSetWithScores: vi.fn().mockResolvedValue([]),
  addToSortedSet: vi.fn().mockResolvedValue(undefined),
  removeFromSortedSet: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/cache', () => ({
  default: { getInstance: () => cacheMock },
}));

// The guard records every block for the admin overview; that write is fire and
// forget and must never be what a guard test depends on.
const blockedIpMock = vi.hoisted(() => ({
  logBlock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/blockedIp', () => ({
  default: { getInstance: () => blockedIpMock },
}));

// The whitelist is a database table the guard mirrors; the table itself is
// exercised through its own module, not here.
const allowlistMock = vi.hoisted(() => ({
  getAllowedIps: vi.fn().mockResolvedValue([]),
  add: vi.fn().mockResolvedValue({ success: true }),
  remove: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('../../src/ipAllowlist', () => ({
  default: { getInstance: () => allowlistMock },
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
  'QRLINK_DENY_IPS',
  'QRLINK_SEQ_STREAK',
  'QRLINK_SEQ_MAX_STEP',
  'QRLINK_SEQ_WINDOW_SECONDS',
];

/** Cloudflare's shared Workers egress, denied by default. */
const WORKERS_IP = '2a06:98c0:3600::103';

/**
 * Stands in for the Redis-backed sequence counter so a run of ids can be fed
 * through `check()` the way the cluster would see it.
 */
function withSequenceStore() {
  const store = new Map<string, string>();
  cacheMock.get.mockImplementation(async (key: string) => store.get(key) ?? null);
  cacheMock.set.mockImplementation(async (key: string, value: string) => {
    store.set(key, value);
  });
  return store;
}
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
  cacheMock.removeFromSortedSet.mockReset().mockResolvedValue(undefined);
  cacheMock.del.mockReset().mockResolvedValue(undefined);
  cacheMock.get.mockReset().mockResolvedValue(null);
  cacheMock.set.mockReset().mockResolvedValue(undefined);
  blockedIpMock.logBlock.mockReset().mockResolvedValue(undefined);
  allowlistMock.getAllowedIps.mockReset().mockResolvedValue([]);
  allowlistMock.add.mockReset().mockResolvedValue({ success: true });
  allowlistMock.remove.mockReset().mockResolvedValue({ success: true });
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

describe('permanent denylist', () => {
  it('blocks Cloudflare\'s shared Workers egress by default', async () => {
    const guard = freshGuard();
    await flush();
    expect(await guard.check(WORKERS_IP, 'Mozilla/5.0 Chrome/120')).toEqual({
      allowed: false,
      reason: 'denylist',
    });
    expect(guard.isBanned(WORKERS_IP)).toBe(true);
    // Denied addresses never reach the counter or the Redis ban set.
    expect(cacheMock.increment).not.toHaveBeenCalled();
    expect(cacheMock.addToSortedSet).not.toHaveBeenCalled();
  });

  it('holds before the mirror has loaded and while Redis is down', async () => {
    cacheMock.getSortedSetWithScores.mockRejectedValue(new Error('redis gone'));
    const guard = freshGuard();
    await flush();
    expect(guard.isBanned(WORKERS_IP)).toBe(true);
  });

  it('accepts extra addresses from the env and ignores case', async () => {
    process.env['QRLINK_DENY_IPS'] = ' 5.6.7.8 , 2A06:98C0:3600::FF ';
    const guard = freshGuard();
    await flush();
    expect(guard.isBanned('5.6.7.8')).toBe(true);
    expect(guard.isBanned('2a06:98c0:3600::ff')).toBe(true);
    expect(guard.isBanned('5.6.7.9')).toBe(false);
  });
});

describe('sequential-id detection', () => {
  it('bans an IP walking the ids upwards below the rate limit', async () => {
    process.env['QRLINK_SEQ_STREAK'] = '10';
    const guard = freshGuard();
    await flush();
    withSequenceStore();
    cacheMock.increment.mockResolvedValue(1); // never trips the rate limiter

    // Nine ascending ids are still allowed.
    for (let id = 392322; id < 392331; id++) {
      expect(await guard.check('1.2.3.4', 'ua', id)).toEqual({ allowed: true });
    }
    // The tenth completes the run.
    expect(await guard.check('1.2.3.4', 'ua', 392331)).toEqual({
      allowed: false,
      reason: 'enumeration',
    });
    expect(guard.isBanned('1.2.3.4')).toBe(true);
  });

  it('does not accumulate on scattered ids from a real deck', async () => {
    process.env['QRLINK_SEQ_STREAK'] = '10';
    const guard = freshGuard();
    await flush();
    withSequenceStore();
    cacheMock.increment.mockResolvedValue(1);

    const deck = [41, 90312, 7, 55010, 8, 120, 90313, 33, 4001, 902, 91, 7788];
    for (const id of deck) {
      expect((await guard.check('9.8.7.6', 'ua', id)).allowed).toBe(true);
    }
    expect(guard.isBanned('9.8.7.6')).toBe(false);
  });

  it('restarts the run on a repeat or a backwards jump', async () => {
    process.env['QRLINK_SEQ_STREAK'] = '3';
    const guard = freshGuard();
    await flush();
    withSequenceStore();
    cacheMock.increment.mockResolvedValue(1);

    expect((await guard.check('4.4.4.4', 'ua', 100)).allowed).toBe(true);
    expect((await guard.check('4.4.4.4', 'ua', 101)).allowed).toBe(true);
    // Same id again: not a forward step, so the run restarts.
    expect((await guard.check('4.4.4.4', 'ua', 101)).allowed).toBe(true);
    expect((await guard.check('4.4.4.4', 'ua', 50)).allowed).toBe(true);
    expect(guard.isBanned('4.4.4.4')).toBe(false);
  });

  it('ignores a gap wider than the allowed step', async () => {
    process.env['QRLINK_SEQ_STREAK'] = '3';
    process.env['QRLINK_SEQ_MAX_STEP'] = '5';
    const guard = freshGuard();
    await flush();
    withSequenceStore();
    cacheMock.increment.mockResolvedValue(1);

    for (const id of [10, 16, 22, 28, 34]) {
      expect((await guard.check('3.3.3.3', 'ua', id)).allowed).toBe(true);
    }
    expect(guard.isBanned('3.3.3.3')).toBe(false);
  });

  it('skips the check when the track id is not numeric', async () => {
    const guard = freshGuard();
    await flush();
    cacheMock.increment.mockResolvedValue(1);
    expect(await guard.check('2.2.2.2', 'ua', 'trk-1')).toEqual({
      allowed: true,
    });
    expect(cacheMock.get).not.toHaveBeenCalled();
  });

  it('parses a numeric id arriving as a string route param', async () => {
    process.env['QRLINK_SEQ_STREAK'] = '2';
    const guard = freshGuard();
    await flush();
    withSequenceStore();
    cacheMock.increment.mockResolvedValue(1);

    expect((await guard.check('6.5.4.3', 'ua', '700')).allowed).toBe(true);
    expect(await guard.check('6.5.4.3', 'ua', '701')).toEqual({
      allowed: false,
      reason: 'enumeration',
    });
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

  it('survives the refresh that failed to persist it, and retries the write', async () => {
    const guard = freshGuard();
    await flush();

    // Redis rejects the write, so the ban exists only in this worker.
    cacheMock.addToSortedSet.mockRejectedValue(new Error('write failed'));
    await guard.ban('7.7.7.1', 'rate limit');
    expect(guard.isBanned('7.7.7.1')).toBe(true);

    // The refresh rebuilds the mirror from Redis, which still has nothing.
    // Before the pendingBans fix this silently lifted the ban.
    await (guard as any).refreshBannedIps();
    expect(guard.isBanned('7.7.7.1')).toBe(true);

    // Once Redis recovers the pending ban is written through and forgotten.
    cacheMock.addToSortedSet.mockResolvedValue(undefined);
    await (guard as any).refreshBannedIps();
    expect(cacheMock.addToSortedSet).toHaveBeenLastCalledWith(
      'banned_ips_z',
      expect.any(Number),
      '7.7.7.1'
    );
    expect((guard as any).pendingBans.size).toBe(0);
  });

  it('keeps a ban added while the refresh was reading Redis', async () => {
    const guard = freshGuard();
    await flush();

    // Ban lands after the sorted set has been read but before it is applied.
    cacheMock.getSortedSetWithScores.mockImplementation(async () => {
      await guard.ban('7.7.7.2', 'rate limit');
      return [];
    });

    await (guard as any).refreshBannedIps();
    expect(guard.isBanned('7.7.7.2')).toBe(true);
  });

  it('still lets a ban removed from Redis expire', async () => {
    const guard = freshGuard();
    await flush();
    await guard.ban('7.7.7.3', 'rate limit'); // persists cleanly
    expect(guard.isBanned('7.7.7.3')).toBe(true);

    // An operator zrems it: the next refresh must let it go.
    await (guard as any).refreshBannedIps();
    expect(guard.isBanned('7.7.7.3')).toBe(false);
  });
});

describe('unban', () => {
  it('clears the ban from Redis, the mirror and both counters', async () => {
    const guard = freshGuard();
    await flush();
    await guard.ban('9.1.1.1', 'rate limit', 'rate-limit');
    expect(guard.isBanned('9.1.1.1')).toBe(true);

    const result = await guard.unban('9.1.1.1');

    expect(result).toEqual({ success: true });
    expect(guard.isBanned('9.1.1.1')).toBe(false);
    expect(cacheMock.removeFromSortedSet).toHaveBeenCalledWith(
      'banned_ips_z',
      '9.1.1.1'
    );
    // Both counters go, or the next request is banned again straight away.
    expect(cacheMock.del).toHaveBeenCalledWith('qrlink_rl:9.1.1.1');
    expect(cacheMock.del).toHaveBeenCalledWith('qrlink_seq:9.1.1.1');
  });

  it('survives the next refresh instead of being mirrored back', async () => {
    const guard = freshGuard();
    await flush();
    await guard.ban('9.1.1.2', 'rate limit', 'rate-limit');
    await guard.unban('9.1.1.2');

    // Redis no longer returns it, which is what removeFromSortedSet ensures.
    await (guard as any).refreshBannedIps();
    expect(guard.isBanned('9.1.1.2')).toBe(false);
  });

  it('does not resurrect a ban whose Redis write had failed', async () => {
    const guard = freshGuard();
    await flush();
    cacheMock.addToSortedSet.mockRejectedValue(new Error('write failed'));
    await guard.ban('9.1.1.3', 'rate limit', 'rate-limit');
    expect(guard.isBanned('9.1.1.3')).toBe(true);

    cacheMock.addToSortedSet.mockResolvedValue(undefined);
    await guard.unban('9.1.1.3');
    await (guard as any).refreshBannedIps();

    expect(guard.isBanned('9.1.1.3')).toBe(false);
  });

  it('refuses to lift a permanent denylist entry and says why', async () => {
    const guard = freshGuard();
    await flush();
    const result = await guard.unban(WORKERS_IP);

    expect(result.success).toBe(false);
    expect(result.error).toContain('QRLINK_DENY_IPS');
    expect(guard.isBanned(WORKERS_IP)).toBe(true);
  });

  it('reports a failure when Redis cannot be cleared', async () => {
    const guard = freshGuard();
    await flush();
    await guard.ban('9.1.1.4', 'rate limit', 'rate-limit');
    cacheMock.removeFromSortedSet.mockRejectedValue(new Error('redis gone'));

    const result = await guard.unban('9.1.1.4');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to clear the ban');
  });

  it('rejects an empty IP', async () => {
    const guard = freshGuard();
    await flush();
    expect(await guard.unban('')).toEqual({
      success: false,
      error: 'No IP given',
    });
  });
});

describe('whitelist', () => {
  it('never bans a whitelisted address, whatever it does', async () => {
    allowlistMock.getAllowedIps.mockResolvedValue(['1.2.3.9']);
    process.env['QRLINK_SEQ_STREAK'] = '3';
    process.env['QRLINK_RATE_MAX'] = '2';
    const guard = freshGuard();
    await flush();
    withSequenceStore();
    cacheMock.increment.mockResolvedValue(999); // way over the rate limit

    // The exact pattern that would otherwise ban: a fast ascending run.
    for (const id of [100, 101, 102, 103, 104]) {
      expect(await guard.check('1.2.3.9', 'ua', id)).toEqual({ allowed: true });
    }

    expect(guard.isBanned('1.2.3.9')).toBe(false);
    expect(blockedIpMock.logBlock).not.toHaveBeenCalled();
    // The detectors are skipped entirely, so no counters are touched either.
    expect(cacheMock.increment).not.toHaveBeenCalled();
  });

  it('beats the permanent denylist', async () => {
    allowlistMock.getAllowedIps.mockResolvedValue([WORKERS_IP]);
    const guard = freshGuard();
    await flush();

    expect(guard.isAllowed(WORKERS_IP)).toBe(true);
    expect(guard.isBanned(WORKERS_IP)).toBe(false);
    expect(await guard.check(WORKERS_IP, 'ua')).toEqual({ allowed: true });
  });

  it('ignores an explicit ban call for a whitelisted address', async () => {
    allowlistMock.getAllowedIps.mockResolvedValue(['1.2.3.8']);
    const guard = freshGuard();
    await flush();

    await guard.ban('1.2.3.8', 'rate limit', 'rate-limit');

    expect(guard.isBanned('1.2.3.8')).toBe(false);
    expect(cacheMock.addToSortedSet).not.toHaveBeenCalled();
  });

  it('whitelisting lifts the ban the address already had', async () => {
    const guard = freshGuard();
    await flush();
    await guard.ban('1.2.3.7', 'rate limit', 'rate-limit');
    expect(guard.isBanned('1.2.3.7')).toBe(true);

    const result = await guard.allow('1.2.3.7', 'Customer scanning own deck');

    expect(result).toEqual({ success: true });
    expect(allowlistMock.add).toHaveBeenCalledWith(
      '1.2.3.7',
      'Customer scanning own deck'
    );
    // Freed in Redis and in the counters, not just marked allowed.
    expect(cacheMock.removeFromSortedSet).toHaveBeenCalledWith(
      'banned_ips_z',
      '1.2.3.7'
    );
    expect(guard.isBanned('1.2.3.7')).toBe(false);
  });

  it('applies immediately, before the next mirror refresh', async () => {
    const guard = freshGuard();
    await flush();
    await guard.allow('1.2.3.6', null);
    // getAllowedIps still returns [] until the next refresh; the local set is
    // what makes this take effect at once.
    expect(guard.isAllowed('1.2.3.6')).toBe(true);
  });

  it('does not whitelist when the table write fails', async () => {
    allowlistMock.add.mockResolvedValue({ success: false, error: 'db down' });
    const guard = freshGuard();
    await flush();

    const result = await guard.allow('1.2.3.5');

    expect(result).toEqual({ success: false, error: 'db down' });
    expect(guard.isAllowed('1.2.3.5')).toBe(false);
  });

  it('removing from the whitelist makes the address bannable again', async () => {
    allowlistMock.getAllowedIps.mockResolvedValue(['1.2.3.4']);
    const guard = freshGuard();
    await flush();
    expect(guard.isAllowed('1.2.3.4')).toBe(true);

    await guard.disallow('1.2.3.4');

    expect(allowlistMock.remove).toHaveBeenCalledWith('1.2.3.4');
    expect(guard.isAllowed('1.2.3.4')).toBe(false);
    await guard.ban('1.2.3.4', 'rate limit', 'rate-limit');
    expect(guard.isBanned('1.2.3.4')).toBe(true);
  });

  it('keeps the previous whitelist when the database is unreachable', async () => {
    allowlistMock.getAllowedIps.mockResolvedValue(['1.2.3.3']);
    const guard = freshGuard();
    await flush();
    expect(guard.isAllowed('1.2.3.3')).toBe(true);

    // A later refresh fails: the customer must not be re-banned by it.
    allowlistMock.getAllowedIps.mockRejectedValue(new Error('db down'));
    await (guard as any).refreshBannedIps();

    expect(guard.isAllowed('1.2.3.3')).toBe(true);
  });
});

describe('block logging', () => {
  it('reports a blocked IP once, not on every refused request', async () => {
    const guard = freshGuard();
    await flush();
    const logs: string[] = [];
    (guard as any).logger = { log: (m: string) => logs.push(m) };

    for (let i = 0; i < 5; i++) {
      expect(guard.isBanned(WORKERS_IP)).toBe(true);
    }
    const blocked = logs.filter(l => l.includes('Blocking requests from'));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toContain('denylist');
    expect(blocked[0]).toContain(WORKERS_IP);
  });

  it('records the block once for the admin overview', async () => {
    const guard = freshGuard();
    await flush();

    for (let i = 0; i < 4; i++) {
      guard.isBanned(WORKERS_IP, 'Mozilla/5.0 Chrome/120');
    }

    expect(blockedIpMock.logBlock).toHaveBeenCalledTimes(1);
    expect(blockedIpMock.logBlock).toHaveBeenCalledWith({
      ip: WORKERS_IP,
      reason: 'denylist',
      detail: null,
      userAgent: 'Mozilla/5.0 Chrome/120',
      php: null, // the global hook does not know which playlist was scanned
      expiresAt: null, // denylist entries never expire
    });
  });

  it('records the playlist when the blocked scan carried one', async () => {
    process.env['QRLINK_RATE_MAX'] = '2';
    const guard = freshGuard();
    await flush();
    cacheMock.increment.mockResolvedValue(3);

    // /qrlink2/:trackId/:php passes the playlist as a string route param.
    await guard.check('5.5.5.2', 'Mozilla/5.0 Chrome/120', '392322', '8817');

    const record = blockedIpMock.logBlock.mock.calls[0][0];
    expect(record.php).toBe(8817);
    expect(record.detail).toContain('php=8817');
  });

  it('leaves the playlist empty for the legacy endpoint that has none', async () => {
    process.env['QRLINK_RATE_MAX'] = '2';
    const guard = freshGuard();
    await flush();
    cacheMock.increment.mockResolvedValue(3);

    // /qrlink/:trackId carries no playlist.
    await guard.check('5.5.5.3', 'Mozilla/5.0 Chrome/120', '392322');

    const record = blockedIpMock.logBlock.mock.calls[0][0];
    expect(record.php).toBeNull();
    expect(record.detail).not.toContain('php=');
  });

  it('records a rate-limit ban with its reason, detail and expiry', async () => {
    process.env['QRLINK_RATE_MAX'] = '2';
    const guard = freshGuard();
    await flush();
    cacheMock.increment.mockResolvedValue(3);

    await guard.check('5.5.5.1', 'Mozilla/5.0 Chrome/120');
    guard.isBanned('5.5.5.1', 'Mozilla/5.0 Chrome/120');

    expect(blockedIpMock.logBlock).toHaveBeenCalledTimes(1);
    const record = blockedIpMock.logBlock.mock.calls[0][0];
    expect(record.ip).toBe('5.5.5.1');
    expect(record.reason).toBe('rate-limit');
    expect(record.detail).toContain('3 qrlink requests in 60s');
    expect(record.userAgent).toBe('Mozilla/5.0 Chrome/120');
    // Default ban is a week.
    expect(record.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 6 * 24 * 3600 * 1000
    );
  });

  it('does not record a second row on the workers that only mirror the ban', async () => {
    // This worker never issued the ban; it read it from Redis like a sibling
    // worker would. It must still log and enforce, but the row belongs to the
    // worker that knows why.
    const future = Date.now() + 60_000;
    cacheMock.getSortedSetWithScores.mockResolvedValue([
      { member: '7.1.1.1', score: future },
    ]);
    const guard = freshGuard();
    await flush();
    const logs: string[] = [];
    (guard as any).logger = { log: (m: string) => logs.push(m) };

    expect(guard.isBanned('7.1.1.1', 'ua')).toBe(true);

    expect(logs.filter(l => l.includes('Blocking requests from'))).toHaveLength(
      1
    );
    expect(blockedIpMock.logBlock).not.toHaveBeenCalled();
  });

  it('does not let a failed record write break the block', async () => {
    blockedIpMock.logBlock.mockRejectedValue(new Error('db down'));
    const guard = freshGuard();
    await flush();
    expect(() => guard.isBanned(WORKERS_IP)).not.toThrow();
    expect(guard.isBanned(WORKERS_IP)).toBe(true);
  });

  it('reports again after a ban has expired and the IP returns', async () => {
    process.env['QRLINK_BAN_SECONDS'] = '100';
    const guard = freshGuard();
    await flush();
    const logs: string[] = [];
    (guard as any).logger = { log: (m: string) => logs.push(m) };

    await guard.ban('8.8.4.4', 'rate limit');
    expect(guard.isBanned('8.8.4.4')).toBe(true);
    expect(guard.isBanned('8.8.4.4')).toBe(true);
    expect(logs.filter(l => l.includes('Blocking requests from'))).toHaveLength(
      1
    );

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 101_000);
    expect(guard.isBanned('8.8.4.4')).toBe(false); // clears the log flag
    vi.useRealTimers();

    await guard.ban('8.8.4.4', 'rate limit again');
    expect(guard.isBanned('8.8.4.4')).toBe(true);
    expect(logs.filter(l => l.includes('Blocking requests from'))).toHaveLength(
      2
    );
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
