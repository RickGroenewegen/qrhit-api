import { color } from 'console-log-colors';
import Cache from './cache';
import Logger from './logger';

/**
 * AbuseGuard protects high-value, enumerable public endpoints (the qrlink
 * track-resolution endpoints) against scraping / database-draining by
 * competitors.
 *
 * Detection (only runs on the protected qrlink endpoints):
 *  1. User-agent blocklist  - known scraper agents are banned on sight.
 *  2. Per-IP rate limiting  - a fixed-window counter in Redis; an IP that
 *     exceeds the threshold is a scraper enumerating track ids and gets
 *     banned.
 *
 * Enforcement (runs on EVERY request, see ipPlugin):
 *  - Banned IPs are rejected with 403 across the entire API, not just the
 *    qrlink endpoints. Bans are persisted in a Redis sorted set keyed by
 *    expiry timestamp (so they are self-healing after `QRLINK_BAN_SECONDS`)
 *    and shared across all cluster workers. Each worker keeps an in-memory
 *    mirror so the per-request check costs nothing (no Redis round-trip).
 *
 * The IP used here comes from ipPlugin's spoof-resistant resolver
 * (CloudFront-Viewer-Address preferred over the forgeable X-Forwarded-For),
 * so an attacker cannot get a victim banned or evade their own ban by
 * spoofing headers. The TTL is a defence-in-depth safety net on top of that.
 *
 * All thresholds are env-configurable. Defaults are generous enough for a
 * large party scanning physical cards over one shared (NAT) IP, but far below
 * scraper request rates (the offending scraper did ~20 req/s).
 */

export interface GuardResult {
  allowed: boolean;
  reason?: 'user-agent' | 'rate-limit';
}

class AbuseGuard {
  private static instance: AbuseGuard;
  private cache = Cache.getInstance();
  private logger = new Logger();

  // Redis keys (namespaced under the cache version automatically).
  // NB: this is a sorted set (zadd/zrange). It is intentionally NOT named
  // `banned_ips` to avoid a WRONGTYPE clash with any leftover plain-set key of
  // that name from an earlier implementation.
  private readonly BANNED_SET_KEY = 'banned_ips_z';
  private readonly COUNT_PREFIX = 'qrlink_rl';

  private readonly windowSeconds: number;
  private readonly maxPerWindow: number;
  private readonly banSeconds: number;
  private readonly refreshSeconds: number;
  private readonly blockedUserAgents: string[];

  // In-memory mirror of the Redis ban set (ip -> expiry epoch ms) for
  // zero-latency per-request checks.
  private bannedIps = new Map<string, number>();
  private mirrorLoaded = false;

  private constructor() {
    this.windowSeconds = this.envInt('QRLINK_RATE_WINDOW_SECONDS', 60);
    this.maxPerWindow = this.envInt('QRLINK_RATE_MAX', 30);
    this.banSeconds = this.envInt('QRLINK_BAN_SECONDS', 86400); // 24h
    this.refreshSeconds = this.envInt('QRLINK_BAN_REFRESH_SECONDS', 20);

    // Comma-separated, case-insensitive substrings. The default seeds the
    // known competitor scraper; extra agents can be added via env.
    const defaults = ['Hitify-QRSong-Sync'];
    const fromEnv = (process.env['QRLINK_BLOCKED_USER_AGENTS'] || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    this.blockedUserAgents = [...defaults, ...fromEnv].map(s =>
      s.toLowerCase()
    );

    // Prime the in-memory mirror and keep it in sync across cluster workers.
    void this.refreshBannedIps();
    setInterval(() => {
      void this.refreshBannedIps();
    }, this.refreshSeconds * 1000).unref();
  }

  public static getInstance(): AbuseGuard {
    if (!AbuseGuard.instance) {
      AbuseGuard.instance = new AbuseGuard();
    }
    return AbuseGuard.instance;
  }

  private envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
      return fallback;
    }
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private async refreshBannedIps(): Promise<void> {
    try {
      const now = Date.now();
      // Drop expired bans from Redis, then mirror the survivors locally.
      await this.cache.pruneSortedSet(this.BANNED_SET_KEY, now);
      const entries = await this.cache.getSortedSetWithScores(
        this.BANNED_SET_KEY
      );
      const next = new Map<string, number>();
      for (const { member, score } of entries) {
        if (score > now) {
          next.set(member, score);
        }
      }
      this.bannedIps = next;
      this.mirrorLoaded = true;
    } catch (error) {
      // Keep the previous in-memory snapshot on a transient cache failure.
      this.logger.log(
        color.yellow.bold(
          `AbuseGuard could not refresh banned IPs: ${
            (error as Error).message
          }`
        )
      );
    }
  }

  /**
   * Fast, synchronous ban check used by the global per-request hook.
   * Reads only the in-memory mirror, so it adds no latency to normal traffic.
   */
  public isBanned(clientIp: string): boolean {
    if (!clientIp || !this.mirrorLoaded) {
      return false;
    }
    const expiry = this.bannedIps.get(clientIp);
    if (!expiry) {
      return false;
    }
    if (Date.now() >= expiry) {
      // Lazily forget locally-expired bans; Redis is pruned on refresh.
      this.bannedIps.delete(clientIp);
      return false;
    }
    return true;
  }

  /**
   * Bans an IP immediately: updates the local mirror so this worker enforces
   * it on the very next request, and persists to Redis so all other workers
   * pick it up (on their next refresh) and it survives restarts. The ban
   * self-heals after `banSeconds`.
   */
  public async ban(clientIp: string, reason: string): Promise<void> {
    if (!clientIp) {
      return;
    }
    const expiry = Date.now() + this.banSeconds * 1000;
    const existing = this.bannedIps.get(clientIp);
    if (existing && existing > Date.now()) {
      return; // already banned
    }
    this.bannedIps.set(clientIp, expiry);
    this.logger.log(
      color.red.bold(
        `Banned ip=${color.white.bold(clientIp)} for ${color.white.bold(
          this.banSeconds
        )}s (${color.white.bold(reason)})`
      )
    );
    try {
      await this.cache.addToSortedSet(this.BANNED_SET_KEY, expiry, clientIp);
    } catch (error) {
      this.logger.log(
        color.yellow.bold(
          `AbuseGuard failed to persist ban for ${clientIp}: ${
            (error as Error).message
          }`
        )
      );
    }
  }

  private isBlockedUserAgent(userAgent: string): boolean {
    if (!userAgent) {
      return false;
    }
    const ua = userAgent.toLowerCase();
    return this.blockedUserAgents.some(blocked => ua.includes(blocked));
  }

  /**
   * Detection for the protected qrlink endpoints. Bans offending IPs straight
   * away. Increments the per-IP counter as a side effect. Fails open (allows
   * the request) if Redis is unavailable, so a cache outage never breaks
   * legitimate card scans.
   */
  public async check(
    clientIp: string,
    userAgent: string
  ): Promise<GuardResult> {
    // Layer 1: known scraper user-agent -> ban on sight.
    if (this.isBlockedUserAgent(userAgent)) {
      await this.ban(clientIp, `scraper user-agent: ${userAgent}`);
      return { allowed: false, reason: 'user-agent' };
    }

    if (!clientIp) {
      return { allowed: true };
    }

    try {
      // Layer 2: fixed-window per-IP counter.
      const countKey = `${this.COUNT_PREFIX}:${clientIp}`;
      const count = await this.cache.increment(countKey, this.windowSeconds);

      if (count > this.maxPerWindow) {
        await this.ban(
          clientIp,
          `rate limit: ${count} qrlink requests in ${this.windowSeconds}s, userAgent=${
            userAgent || 'unknown'
          }`
        );
        return { allowed: false, reason: 'rate-limit' };
      }

      return { allowed: true };
    } catch (error) {
      // Fail open: never let a cache problem break legitimate scans.
      this.logger.log(
        color.yellow.bold(
          `AbuseGuard check failed (allowing request): ${
            (error as Error).message
          }`
        )
      );
      return { allowed: true };
    }
  }
}

export default AbuseGuard;
