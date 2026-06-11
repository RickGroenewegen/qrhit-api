import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

// In-memory stand-in for the Redis-backed cache (unit tests: no Redis).
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string, _ttl?: number) => {
        store.set(key, value);
      },
      del: async (key: string) => {
        store.delete(key);
      },
    }),
  },
}));

import LoginRateLimiter from '../../src/loginRateLimiter';

const limiter = LoginRateLimiter.getInstance();
const IP = '10.0.0.1';
const EMAIL = 'user@example.com';

describe('LoginRateLimiter', () => {
  beforeEach(() => {
    store.clear();
  });

  it('is a singleton', () => {
    expect(LoginRateLimiter.getInstance()).toBe(limiter);
  });

  it('allows a clean IP/email pair', async () => {
    expect(await limiter.checkRateLimit(IP, EMAIL)).toEqual({ allowed: true });
  });

  it('still allows after a few failed attempts below the threshold', async () => {
    for (let i = 0; i < 9; i++) {
      await limiter.recordFailedAttempt(IP, EMAIL);
    }
    expect(await limiter.checkRateLimit(IP, EMAIL)).toEqual({ allowed: true });
    expect(store.get(`ratelimit:login:ip_email:${IP}:${EMAIL}`)).toBe('9');
    expect(store.get(`ratelimit:login:ip:${IP}`)).toBe('9');
  });

  it('locks out after 10 failed login attempts for the same ip+email', async () => {
    for (let i = 0; i < 10; i++) {
      await limiter.recordFailedAttempt(IP, EMAIL);
    }
    // Lockout key was written on the 10th failure
    const lockout = store.get(`ratelimit:login:lockout:${IP}:${EMAIL}`);
    expect(lockout).toBeDefined();
    expect(parseInt(lockout!, 10)).toBeGreaterThan(Date.now());

    const result = await limiter.checkRateLimit(IP, EMAIL);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.retryAfter).toBeLessThanOrEqual(600);
  });

  it('blocks via the ip+email counter even without a lockout key', async () => {
    store.set(`ratelimit:login:ip_email:${IP}:${EMAIL}`, '10');
    const result = await limiter.checkRateLimit(IP, EMAIL);
    expect(result).toEqual({ allowed: false, retryAfter: 600 });
  });

  it('blocks via the per-IP counter across different emails', async () => {
    store.set(`ratelimit:login:ip:${IP}`, '50');
    const result = await limiter.checkRateLimit(IP, 'other@example.com');
    expect(result).toEqual({ allowed: false, retryAfter: 600 });
  });

  it('ignores an expired lockout entry', async () => {
    store.set(
      `ratelimit:login:lockout:${IP}:${EMAIL}`,
      (Date.now() - 1000).toString()
    );
    expect(await limiter.checkRateLimit(IP, EMAIL)).toEqual({ allowed: true });
  });

  it('normalizes email case and whitespace in keys', async () => {
    await limiter.recordFailedAttempt(IP, '  User@Example.COM ');
    expect(store.get(`ratelimit:login:ip_email:${IP}:user@example.com`)).toBe(
      '1'
    );
  });

  it('clears all counters and the lockout on successful login', async () => {
    for (let i = 0; i < 10; i++) {
      await limiter.recordFailedAttempt(IP, EMAIL);
    }
    expect((await limiter.checkRateLimit(IP, EMAIL)).allowed).toBe(false);

    await limiter.recordSuccessfulLogin(IP, EMAIL);
    expect(store.has(`ratelimit:login:ip_email:${IP}:${EMAIL}`)).toBe(false);
    expect(store.has(`ratelimit:login:lockout:${IP}:${EMAIL}`)).toBe(false);
    expect(store.has(`ratelimit:login:ip:${IP}`)).toBe(false);
    expect(await limiter.checkRateLimit(IP, EMAIL)).toEqual({ allowed: true });
  });

  it('uses the stricter password-reset limits (5 per ip+email)', async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.recordFailedAttempt(IP, EMAIL, 'password-reset');
    }
    const result = await limiter.checkRateLimit(IP, EMAIL, 'password-reset');
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeLessThanOrEqual(900);
    // login flow for the same pair is unaffected (separate keyspace)
    expect(await limiter.checkRateLimit(IP, EMAIL, 'login')).toEqual({
      allowed: true,
    });
  });

  it('caps the pincode flow per-IP at 30', async () => {
    store.set(`ratelimit:pincode:ip:${IP}`, '30');
    const result = await limiter.checkRateLimit(IP, EMAIL, 'pincode');
    expect(result).toEqual({ allowed: false, retryAfter: 600 });
    // 29 attempts is still fine
    store.set(`ratelimit:pincode:ip:${IP}`, '29');
    expect(await limiter.checkRateLimit(IP, EMAIL, 'pincode')).toEqual({
      allowed: true,
    });
  });

  it('sets a lockout when the per-IP cap is hit even for a fresh email', async () => {
    store.set(`ratelimit:login:ip:${IP}`, '49');
    await limiter.recordFailedAttempt(IP, 'fresh@example.com');
    expect(
      store.get(`ratelimit:login:lockout:${IP}:fresh@example.com`)
    ).toBeDefined();
  });
});
