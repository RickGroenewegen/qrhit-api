import Redis from 'ioredis';
import PrismaInstance from './prisma';

// Card plays per order line (payment_has_playlist.id), for the rankings on the
// admin Analytics page. A php belongs to one playlist, so the same playlist
// bought by two customers is two members. The keys are not under `analytics:`:
// getAllCounters() GETs every key there, and a sorted set answers WRONGTYPE.
const PLAYS_TOTAL_KEY = 'plays:php:total';
const PLAYS_HOUR_PREFIX = 'plays:php:hour:';
// When counting started: the first live play, or the oldest seeded one.
const PLAYS_SINCE_KEY = 'plays:php:since';
// Set by the one-off seed from the scan log, so it can never run twice.
const PLAYS_SEEDED_KEY = 'plays:php:seeded';
// An hour bucket outlives the 7-day window by a day.
const PLAYS_HOUR_TTL_SECONDS = 8 * 24 * 60 * 60;
const HOUR_MS = 60 * 60 * 1000;

export interface PlayCount {
  php: number;
  plays: number;
}

export interface PlayWindow {
  /** Every play in the window, not only those of the listed top. */
  plays: number;
  /** Order lines with at least one play in the window. */
  orders: number;
  top: PlayCount[];
}

export interface PlayRanking {
  since: string | null;
  day: PlayWindow;
  week: PlayWindow;
  total: PlayWindow;
}

/** Every order line's plays per window: php id → plays. */
export interface PlayCounts {
  since: string | null;
  day: Map<number, number>;
  week: Map<number, number>;
  total: Map<number, number>;
}

export interface SeedPlay {
  php: number;
  at: Date;
}

export interface PlaySeedResult {
  alreadySeeded: boolean;
  /** Only scans before this are seeded: later ones were counted live. */
  cutoff: string;
  scans: number;
  orders: number;
  oldest: string | null;
  newest: string | null;
  written: boolean;
}

/**
 * The order line id of a scan, or null. It arrives as a string from the
 * `/qrlink2/:trackId/:php` route params.
 */
export function playPhpId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(String(value ?? ''));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The hour bucket of a moment, in UTC: `plays:php:hour:2026100315`. */
export function playsHourKey(at: Date): string {
  return PLAYS_HOUR_PREFIX + at.toISOString().slice(0, 13).replace(/[-T]/g, '');
}

function toPlayWindow(counts: Map<number, number>, limit: number): PlayWindow {
  let plays = 0;
  const all: PlayCount[] = [];
  for (const [php, count] of counts) {
    if (count <= 0) continue;
    plays += count;
    all.push({ php, plays: count });
  }
  all.sort((a, b) => b.plays - a.plays || a.php - b.php);
  return { plays, orders: all.length, top: all.slice(0, limit) };
}

/**
 * Adds a `ZRANGE ... WITHSCORES` reply to counts. RESP2 (and ioredis's
 * default "legacy" mapping) answers `[member, score, ...]`; RESP3 proper
 * answers `[[member, score], ...]`. Both are read.
 */
function addScores(counts: Map<number, number>, reply: unknown) {
  if (!Array.isArray(reply)) return;
  const pairs: [unknown, unknown][] = Array.isArray(reply[0])
    ? (reply as [unknown, unknown][])
    : Array.from({ length: Math.floor(reply.length / 2) }, (_, i) => [
        reply[2 * i],
        reply[2 * i + 1],
      ]);
  for (const [member, score] of pairs) {
    const php = Number(member);
    const plays = Number(score);
    if (!Number.isFinite(php) || !Number.isFinite(plays)) continue;
    counts.set(php, (counts.get(php) || 0) + plays);
  }
}

class AnalyticsClient {
  private static instance: AnalyticsClient;
  private client: Redis;
  private prisma = PrismaInstance.getInstance();

  private constructor() {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not defined');
    }
    this.client = new Redis(redisUrl, { db: 1 });
  }

  public static getInstance(): AnalyticsClient {
    if (!AnalyticsClient.instance) {
      AnalyticsClient.instance = new AnalyticsClient();
    }
    return AnalyticsClient.instance;
  }

  private getKey(category: string, action: string): string {
    return `analytics:${category}:${action}`;
  }

  public async increaseCounter(
    category: string,
    action: string,
    increment: number = 1
  ): Promise<number> {
    const key = this.getKey(category, action);
    return await this.client.incrby(key, increment);
  }

  public async decreaseCounter(
    category: string,
    action: string,
    decrement: number = 1
  ): Promise<number> {
    const key = this.getKey(category, action);
    return await this.client.decrby(key, decrement);
  }

  public async getCounter(category: string, action: string): Promise<number> {
    const key = this.getKey(category, action);
    const value = await this.client.get(key);
    return value ? parseInt(value, 10) : 0;
  }

  public async setCounter(
    category: string,
    action: string,
    value: number
  ): Promise<void> {
    const key = this.getKey(category, action);
    await this.client.set(key, value.toString());
  }

  public async getAllCounters(): Promise<
    Record<string, Record<string, number>>
  > {
    const keys = await this.client.keys('analytics:*');
    const result: Record<string, Record<string, number>> = {};

    for (const key of keys) {
      const [, category, action] = key.split(':');
      const value = await this.client.get(key);

      if (!result[category]) {
        result[category] = {};
      }
      result[category][action] = parseInt(value || '0', 10);
    }

    // Turnover and profit are not computed here: the /analytics route takes
    // them from the sales report (Mollie.getSalesTotals), so the Finance
    // card and the reports agree.
    const soldResult = await this.getTotalPlaylistsSoldByType();

    if (!result['purchase']) result['purchase'] = {};
    result['purchase']['digital'] = soldResult.digital.amount;
    result['purchase']['physical'] = soldResult.physical.amount;
    result['purchase']['cards'] =
      soldResult.physical.tracks + soldResult.digital.tracks;

    return result;
  }

  public async getTotalPlaylistsSoldByType(
    excludedEmails: string[] = ['west14@gmail.com', 'info@rickgroenewegen.nl']
  ): Promise<Record<string, { amount: number; tracks: number }>> {
    const result = await this.prisma.paymentHasPlaylist.groupBy({
      by: ['type'],
      _sum: {
        amount: true,
        numberOfTracks: true,
      },
      where: {
        payment: {
          user: {
            email: {
              notIn: excludedEmails,
            },
          },
        },
      },
    });

    const initialResult: Record<string, { amount: number; tracks: number }> = {
      digital: { amount: 0, tracks: 0 },
      physical: { amount: 0, tracks: 0 },
    };

    return result.reduce((acc, item) => {
      acc[item.type] = {
        amount: item._sum.amount || 0,
        tracks: item._sum.numberOfTracks || 0,
      };
      return acc;
    }, initialResult);
  }

  /** Counts one card play for an order line, in the total and its hour. */
  public async recordPlaylistPlay(php: number, at: Date = new Date()): Promise<void> {
    const hourKey = playsHourKey(at);
    await this.client
      .multi()
      .zincrby(PLAYS_TOTAL_KEY, 1, String(php))
      .zincrby(hourKey, 1, String(php))
      .expire(hourKey, PLAYS_HOUR_TTL_SECONDS)
      .set(PLAYS_SINCE_KEY, at.toISOString(), 'NX')
      .exec();
  }

  /**
   * The most played order lines in the last 24 hours (this hour and the 23
   * before it), the last 7 days (168 hours) and since counting began.
   */
  public async getPlaylistPlayRanking(
    now: Date = new Date(),
    limit: number = 50
  ): Promise<PlayRanking> {
    const counts = await this.getPlayCounts(now);
    return {
      since: counts.since,
      day: toPlayWindow(counts.day, limit),
      week: toPlayWindow(counts.week, limit),
      total: toPlayWindow(counts.total, limit),
    };
  }

  /**
   * The plays of every order line in each window, unranked. The per-playlist
   * ranking adds these up by playlist.
   */
  public async getPlayCounts(now: Date = new Date()): Promise<PlayCounts> {
    // Newest first, so the first 24 are also the day window.
    const hourKeys = Array.from({ length: 168 }, (_, i) =>
      playsHourKey(new Date(now.getTime() - i * HOUR_MS))
    );
    const pipeline = this.client.pipeline();
    for (const key of hourKeys) pipeline.zrange(key, 0, '-1', 'WITHSCORES');
    pipeline.zrange(PLAYS_TOTAL_KEY, 0, '-1', 'WITHSCORES');
    pipeline.get(PLAYS_SINCE_KEY);
    const replies = (await pipeline.exec()) || [];
    const failed = replies.find(([error]) => error);
    if (failed) throw failed[0];

    const day = new Map<number, number>();
    const week = new Map<number, number>();
    hourKeys.forEach((_, i) => {
      const reply = replies[i]?.[1];
      if (i < 24) addScores(day, reply);
      addScores(week, reply);
    });
    const total = new Map<number, number>();
    addScores(total, replies[hourKeys.length]?.[1]);

    return {
      since: (replies[hourKeys.length + 1]?.[1] as string | null) ?? null,
      day,
      week,
      total,
    };
  }

  /**
   * Adds plays from before counting began (the scan log) to the total and,
   * when younger than the hour buckets' lifetime, to their hour. Only plays
   * before the cutoff count: from then on they were counted live. Without
   * `write` it only reports. It claims `plays:php:seeded` first, so it adds
   * nothing a second time.
   */
  public async seedPlaylistPlays(
    plays: SeedPlay[],
    options: { write?: boolean; now?: Date } = {}
  ): Promise<PlaySeedResult> {
    const now = options.now ?? new Date();
    const [seeded, since] = await Promise.all([
      this.client.get(PLAYS_SEEDED_KEY),
      this.client.get(PLAYS_SINCE_KEY),
    ]);
    const cutoff = since ? new Date(since) : now;
    const eligible = plays
      .filter((play) => play.at.getTime() < cutoff.getTime())
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const result: PlaySeedResult = {
      alreadySeeded: seeded !== null,
      cutoff: cutoff.toISOString(),
      scans: eligible.length,
      orders: new Set(eligible.map((play) => play.php)).size,
      oldest: eligible[0]?.at.toISOString() ?? null,
      newest: eligible[eligible.length - 1]?.at.toISOString() ?? null,
      written: false,
    };
    if (!options.write || result.alreadySeeded || eligible.length === 0) {
      return result;
    }

    const claimed = await this.client.set(
      PLAYS_SEEDED_KEY,
      JSON.stringify({ at: now.toISOString(), scans: eligible.length }),
      'NX'
    );
    if (claimed === null) {
      return { ...result, alreadySeeded: true };
    }

    const oldestHourKept = now.getTime() - PLAYS_HOUR_TTL_SECONDS * 1000;
    const multi = this.client.multi();
    const hourKeys = new Set<string>();
    for (const play of eligible) {
      multi.zincrby(PLAYS_TOTAL_KEY, 1, String(play.php));
      if (play.at.getTime() > oldestHourKept) {
        const hourKey = playsHourKey(play.at);
        multi.zincrby(hourKey, 1, String(play.php));
        hourKeys.add(hourKey);
      }
    }
    for (const hourKey of hourKeys) {
      multi.expire(hourKey, PLAYS_HOUR_TTL_SECONDS);
    }
    multi.set(PLAYS_SINCE_KEY, result.oldest!);
    await multi.exec();
    return { ...result, written: true };
  }
}

export default AnalyticsClient;
