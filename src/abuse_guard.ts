import { color } from 'console-log-colors';
import BlockedIp from './blockedIp';
import Cache from './cache';
import IpAllowlist from './ipAllowlist';
import Logger from './logger';

/**
 * AbuseGuard protects high-value, enumerable public endpoints (the qrlink
 * track-resolution endpoints) against scraping / database-draining by
 * competitors.
 *
 * Detection (only runs on the protected qrlink endpoints):
 *  1. Permanent denylist   - addresses that are never a customer, banned on
 *     sight and independent of Redis (see `QRLINK_DENY_IPS`).
 *  2. User-agent blocklist  - known scraper agents are banned on sight.
 *  3. Per-IP rate limiting  - a fixed-window counter in Redis; an IP that
 *     exceeds the threshold is a scraper enumerating track ids and gets
 *     banned.
 *  4. Sequential-id detection - an IP whose track ids climb monotonically is
 *     walking the database by id, which no card scanner ever does. This is
 *     the layer that catches a scraper that throttles below the rate limit.
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
 *
 * The competitor behind that first scrape came back in September 2026 with the
 * user-agent layer defeated: a spoofed Chrome string, ~1 req/s, running on
 * rented Cloudflare Workers. Layers 1 and 4 exist because of that second pass.
 */

export interface GuardResult {
  allowed: boolean;
  reason?: 'user-agent' | 'rate-limit' | 'denylist' | 'enumeration';
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
  private readonly SEQ_PREFIX = 'qrlink_seq';

  private readonly windowSeconds: number;
  private readonly maxPerWindow: number;
  private readonly banSeconds: number;
  private readonly refreshSeconds: number;
  private readonly blockedUserAgents: string[];
  private readonly deniedIps: Set<string>;
  private readonly seqStreak: number;
  private readonly seqMaxStep: number;
  private readonly seqWindowSeconds: number;

  // In-memory mirror of the Redis ban set (ip -> expiry epoch ms) for
  // zero-latency per-request checks.
  private bannedIps = new Map<string, number>();
  private mirrorLoaded = false;

  // IPs whose rejection has already been logged. A blocked scraper keeps
  // hammering (the September 2026 one ran at ~1 req/s), and a line per refused
  // request would bury everything else, so the block is reported once and then
  // stays silent until the ban lifts. Per worker, so a cluster prints one line
  // per worker that the IP happens to reach.
  private blockLogged = new Set<string>();

  // Why each locally-issued ban happened, so the block can be recorded with a
  // reason rather than a bare "banned". Bans mirrored from another worker are
  // not in here, hence the fallback when it is reported.
  private banReasons = new Map<string, { code: string; detail: string }>();

  // Bans this worker could not persist to Redis. They are merged back into the
  // mirror on every refresh (which otherwise replaces it wholesale from Redis)
  // and retried, so a failed write cannot silently un-ban a scraper. Bans that
  // DID reach Redis are deliberately not kept here, so removing one there
  // (`zrem`) still lifts it.
  private pendingBans = new Map<string, number>();

  // Addresses that must never be banned, mirrored from `allowed_ips` on the
  // same interval as the ban list. Empty until the first load: the allowlist
  // is a safety valve for false positives, and a few seconds of the normal
  // rules at boot is better than opening the endpoints while it loads.
  private allowedIps = new Set<string>();

  private constructor() {
    this.windowSeconds = this.envInt('QRLINK_RATE_WINDOW_SECONDS', 60);
    this.maxPerWindow = this.envInt('QRLINK_RATE_MAX', 30);
    this.banSeconds = this.envInt('QRLINK_BAN_SECONDS', 604800); // 7 days
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

    // Addresses that are never a paying customer. The default is Cloudflare's
    // shared Workers egress: every Worker on the platform makes its outbound
    // fetches from this one address, so it is what you see when someone rents
    // Workers to proxy a scrape. We are behind CloudFront, not Cloudflare, so
    // no customer scan, no app request and no SSR render can originate here.
    // It is fixed platform infrastructure, so unlike a VPS the attacker cannot
    // rotate away from it without leaving the platform.
    const deniedDefaults = ['2a06:98c0:3600::103'];
    const deniedFromEnv = (process.env['QRLINK_DENY_IPS'] || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    this.deniedIps = new Set(
      [...deniedDefaults, ...deniedFromEnv].map(s => s.toLowerCase())
    );

    // Sequential-id detection. A scraper walks ids upwards; a deck does not.
    // `Track.trackId` is unique, so a playlist reuses the existing row for any
    // track already in the database and only mints new ids for genuinely new
    // ones. A real deck therefore holds ids scattered across the whole range,
    // and even scanning it in printed order does not climb. The exception is a
    // playlist of tracks we have never seen, which does get one contiguous
    // block: 10 consecutive ascending steps of at most 5 is the compromise.
    this.seqStreak = this.envInt('QRLINK_SEQ_STREAK', 10);
    this.seqMaxStep = this.envInt('QRLINK_SEQ_MAX_STEP', 5);
    this.seqWindowSeconds = this.envInt('QRLINK_SEQ_WINDOW_SECONDS', 3600);

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
      // Snapshot the mirror's keys before the await so bans added while Redis
      // is being read can be told apart from ones Redis has since dropped.
      // This has to be a copy: `ban()` mutates the live map, so holding a
      // reference to it would make every new ban look pre-existing.
      const before = new Set(this.bannedIps.keys());
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

      // Anything banned during the read above is not in `entries` yet. Keep it
      // rather than dropping it for a refresh cycle.
      for (const [ip, expiry] of this.bannedIps) {
        if (!before.has(ip) && expiry > now) {
          next.set(ip, expiry);
        }
      }

      // Re-apply (and retry persisting) bans whose Redis write failed.
      for (const [ip, expiry] of this.pendingBans) {
        if (expiry <= now) {
          this.pendingBans.delete(ip);
          continue;
        }
        next.set(ip, expiry);
        try {
          await this.cache.addToSortedSet(this.BANNED_SET_KEY, expiry, ip);
          this.pendingBans.delete(ip);
        } catch {
          // Still unreachable; keep it pending and enforce it locally.
        }
      }

      this.bannedIps = next;
      this.mirrorLoaded = true;
      await this.refreshAllowedIps();
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
   * Mirrors the whitelist. Kept separate from the ban refresh's try/catch so a
   * database problem leaves the previous snapshot in place rather than
   * emptying the whitelist and re-banning a customer.
   */
  private async refreshAllowedIps(): Promise<void> {
    try {
      const ips = await IpAllowlist.getInstance().getAllowedIps();
      this.allowedIps = new Set(ips);
    } catch (error) {
      this.logger.log(
        color.yellow.bold(
          `AbuseGuard could not refresh allowed IPs: ${
            (error as Error).message
          }`
        )
      );
    }
  }

  /** Whether an address is whitelisted and must never be banned. */
  public isAllowed(clientIp: string): boolean {
    return !!clientIp && this.allowedIps.has(clientIp.toLowerCase());
  }

  /**
   * Adds an address to the whitelist and lifts any ban it already has, which
   * is what the dashboard's "whitelist" action needs: whitelisting a customer
   * who is currently locked out should let them back in immediately.
   */
  public async allow(
    clientIp: string,
    note?: string | null
  ): Promise<{ success: boolean; error?: string }> {
    const cleaned = (clientIp || '').trim();
    if (!cleaned) {
      return { success: false, error: 'No IP given' };
    }

    const added = await IpAllowlist.getInstance().add(cleaned, note);
    if (!added.success) {
      return added;
    }

    this.allowedIps.add(cleaned.toLowerCase());

    // Clear an existing ban, but a denylisted address cannot be freed here.
    if (!this.isDenied(cleaned)) {
      await this.unban(cleaned);
    }

    this.logger.log(
      color.green.bold(
        `Whitelisted ip=${color.white.bold(cleaned)} (admin)${
          note ? `: ${color.white.bold(note)}` : ''
        }`
      )
    );
    return { success: true };
  }

  /** Takes an address off the whitelist. It can be banned again after this. */
  public async disallow(
    clientIp: string
  ): Promise<{ success: boolean; error?: string }> {
    const cleaned = (clientIp || '').trim();
    const removed = await IpAllowlist.getInstance().remove(cleaned);
    if (removed.success) {
      this.allowedIps.delete(cleaned.toLowerCase());
    }
    return removed;
  }

  /**
   * Fast, synchronous ban check used by the global per-request hook.
   * Reads only the in-memory mirror, so it adds no latency to normal traffic.
   */
  public isBanned(clientIp: string, userAgent?: string): boolean {
    if (!clientIp) {
      return false;
    }
    // The whitelist wins over everything, including the denylist: it is the
    // deliberate, admin-set exception.
    if (this.isAllowed(clientIp)) {
      return false;
    }
    // The denylist is static config, so it holds even before the mirror has
    // loaded and while Redis is unreachable.
    if (this.deniedIps.has(clientIp.toLowerCase())) {
      this.logBlockedOnce(clientIp, 'denylist', userAgent, null);
      return true;
    }
    if (!this.mirrorLoaded) {
      return false;
    }
    const expiry = this.bannedIps.get(clientIp);
    if (!expiry) {
      return false;
    }
    if (Date.now() >= expiry) {
      // Lazily forget locally-expired bans; Redis is pruned on refresh.
      this.bannedIps.delete(clientIp);
      // Let the next ban on this IP report itself again.
      this.blockLogged.delete(clientIp);
      return false;
    }
    this.logBlockedOnce(
      clientIp,
      this.banReasons.get(clientIp)?.code || 'ban',
      userAgent,
      new Date(expiry)
    );
    return true;
  }

  /**
   * Reports a refused request once per IP. `ban()` already logs the moment a
   * ban is created; this is what shows that the block is still doing its job
   * afterwards, without a line per request.
   */
  private logBlockedOnce(
    clientIp: string,
    reason: string,
    userAgent?: string,
    expiresAt?: Date | null
  ): void {
    if (this.blockLogged.has(clientIp)) {
      return;
    }
    this.blockLogged.add(clientIp);
    const detail = this.banReasons.get(clientIp)?.detail;
    this.logger.log(
      color.red.bold(
        `Blocking requests from ip=${color.white.bold(
          clientIp
        )} (${color.white.bold(
          detail || reason
        )}), userAgent=${color.white.bold(
          userAgent || 'unknown'
        )}. Further requests from this ip are refused silently.`
      )
    );
    // A denylisted address is never "banned", so nothing else records it.
    if (reason === 'denylist') {
      this.record(clientIp, reason, null, userAgent, null, expiresAt ?? null);
    }
  }

  /**
   * Writes a block to the admin overview. Fire and forget: the record must
   * never hold up a request or, worse, stop the block being applied.
   * `logBlock` swallows its own errors; the catch is here so a future change
   * cannot turn this into an unhandled rejection.
   */
  private record(
    clientIp: string,
    reason: string,
    detail: string | null,
    userAgent?: string,
    php?: number | null,
    expiresAt?: Date | null
  ): void {
    void BlockedIp.getInstance()
      .logBlock({
        ip: clientIp,
        reason,
        detail,
        userAgent: userAgent || null,
        php: php ?? null,
        expiresAt: expiresAt ?? null,
      })
      .catch(() => {});
  }

  /**
   * Bans an IP immediately: updates the local mirror so this worker enforces
   * it on the very next request, and persists to Redis so all other workers
   * pick it up (on their next refresh) and it survives restarts. The ban
   * self-heals after `banSeconds`.
   */
  public async ban(
    clientIp: string,
    reason: string,
    code: string = 'ban',
    context?: { userAgent?: string; php?: number | null }
  ): Promise<void> {
    if (!clientIp || this.isAllowed(clientIp)) {
      return;
    }
    const expiry = Date.now() + this.banSeconds * 1000;
    const existing = this.bannedIps.get(clientIp);
    if (existing && existing > Date.now()) {
      return; // already banned
    }
    this.bannedIps.set(clientIp, expiry);
    this.banReasons.set(clientIp, { code, detail: reason });
    // Recorded here rather than where the block is enforced: this is the one
    // worker that knows why, and it runs once. Every other worker only learns
    // that the address is banned, so leaving it to them would add a vaguer
    // duplicate row per worker.
    this.record(
      clientIp,
      code,
      reason,
      context?.userAgent,
      context?.php,
      new Date(expiry)
    );
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
      // Hold it for the next refresh to retry and, crucially, to re-apply:
      // the refresh rebuilds the mirror from Redis, so without this the ban
      // would disappear again within `refreshSeconds`.
      this.pendingBans.set(clientIp, expiry);
      this.logger.log(
        color.yellow.bold(
          `AbuseGuard failed to persist ban for ${clientIp}: ${
            (error as Error).message
          }`
        )
      );
    }
  }

  /**
   * Per-IP ascending-run counter over requested track ids, kept in Redis so it
   * survives the cluster spreading an IP's requests over several workers.
   *
   * Returns the current run length. A step that is not a small forward move
   * (a repeat, a jump backwards, or a gap wider than `seqMaxStep`) restarts
   * the run at 1, so ordinary scanning never accumulates.
   */
  private async trackSequence(
    clientIp: string,
    trackId?: number | string
  ): Promise<number> {
    const id = this.parseId(trackId);
    if (id === undefined) {
      return 0;
    }

    const key = `${this.SEQ_PREFIX}:${clientIp}`;
    const previous = await this.cache.get(key);
    let streak = 1;

    if (previous) {
      const [lastRaw, streakRaw] = previous.split(':');
      const lastId = parseInt(lastRaw, 10);
      const lastStreak = parseInt(streakRaw, 10);
      if (Number.isFinite(lastId) && Number.isFinite(lastStreak)) {
        const step = id - lastId;
        if (step > 0 && step <= this.seqMaxStep) {
          streak = lastStreak + 1;
        }
      }
    }

    await this.cache.set(key, `${id}:${streak}`, this.seqWindowSeconds);
    return streak;
  }

  /**
   * Route params arrive as strings and are not always numbers (older clients
   * send opaque track ids). Returns undefined for anything that is not a
   * plain number, which is the signal to skip whatever needed it.
   */
  private parseId(value?: number | string): number | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    const parsed = typeof value === 'string' ? parseInt(value, 10) : value;
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  /**
   * Lifts a ban from the admin dashboard: drops it from Redis (so no worker
   * mirrors it back), from this worker's mirror and pending set, and resets
   * the rate-limit and sequence counters so the address starts clean instead
   * of tripping again on its next request. Other workers drop it on their
   * next refresh, within `QRLINK_BAN_REFRESH_SECONDS`.
   *
   * An address on the permanent denylist cannot be lifted here: it is config,
   * so the caller is told to change `QRLINK_DENY_IPS` and restart.
   */
  public async unban(
    clientIp: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!clientIp) {
      return { success: false, error: 'No IP given' };
    }
    if (this.deniedIps.has(clientIp.toLowerCase())) {
      return {
        success: false,
        error:
          'This address is on the permanent denylist. Remove it from QRLINK_DENY_IPS and restart the API to lift it.',
      };
    }

    this.bannedIps.delete(clientIp);
    this.pendingBans.delete(clientIp);
    this.banReasons.delete(clientIp);
    // Let a future block on this address report itself again.
    this.blockLogged.delete(clientIp);

    try {
      await this.cache.removeFromSortedSet(this.BANNED_SET_KEY, clientIp);
      // Without this the next request lands on a counter that is already over
      // the limit, or mid-run, and is banned again immediately.
      await this.cache.del(`${this.COUNT_PREFIX}:${clientIp}`);
      await this.cache.del(`${this.SEQ_PREFIX}:${clientIp}`);
    } catch (error) {
      this.logger.log(
        color.yellow.bold(
          `AbuseGuard could not clear the ban for ${clientIp}: ${
            (error as Error).message
          }`
        )
      );
      return { success: false, error: 'Failed to clear the ban' };
    }

    this.logger.log(
      color.green.bold(`Unbanned ip=${color.white.bold(clientIp)} (admin)`)
    );
    return { success: true };
  }

  /** Whether an address is on the permanent, config-only denylist. */
  public isDenied(clientIp: string): boolean {
    return !!clientIp && this.deniedIps.has(clientIp.toLowerCase());
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
    userAgent: string,
    trackId?: number | string,
    php?: number | string
  ): Promise<GuardResult> {
    // The playlist the card belongs to. `/qrlink2` carries it, the legacy
    // `/qrlink` does not, so it is only sometimes known.
    const playlist = this.parseId(php);
    const context = { userAgent, php: playlist };
    const scanned = `${playlist !== undefined ? `php=${playlist}, ` : ''}userAgent=${
      userAgent || 'unknown'
    }`;

    // Layer 0: whitelisted -> skip every detector. This is the escape hatch
    // for a customer whose own deck trips one of them.
    if (this.isAllowed(clientIp)) {
      return { allowed: true };
    }

    // Layer 1: permanently denied address -> never reaches the data. In
    // practice ipPlugin has already refused this request; the check is here so
    // the endpoint is safe on its own.
    if (clientIp && this.deniedIps.has(clientIp.toLowerCase())) {
      this.logBlockedOnce(clientIp, 'denylist', userAgent);
      return { allowed: false, reason: 'denylist' };
    }

    // Layer 2: known scraper user-agent -> ban on sight.
    if (this.isBlockedUserAgent(userAgent)) {
      await this.ban(
        clientIp,
        `scraper user-agent: ${userAgent}`,
        'user-agent',
        context
      );
      return { allowed: false, reason: 'user-agent' };
    }

    if (!clientIp) {
      return { allowed: true };
    }

    try {
      // Layer 3: fixed-window per-IP counter.
      const countKey = `${this.COUNT_PREFIX}:${clientIp}`;
      const count = await this.cache.increment(countKey, this.windowSeconds);

      if (count > this.maxPerWindow) {
        await this.ban(
          clientIp,
          `rate limit: ${count} qrlink requests in ${this.windowSeconds}s, ${scanned}`,
          'rate-limit',
          context
        );
        return { allowed: false, reason: 'rate-limit' };
      }

      // Layer 4: walking the ids upwards, however slowly.
      const streak = await this.trackSequence(clientIp, trackId);
      if (streak >= this.seqStreak) {
        await this.ban(
          clientIp,
          `sequential track ids: ${streak} ascending requests, last=${trackId}, ${scanned}`,
          'enumeration',
          context
        );
        return { allowed: false, reason: 'enumeration' };
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
