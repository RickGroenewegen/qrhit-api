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
// Every play per hour, kept for good (the hour buckets above live 8 days):
// a hash, field = the hour as `2026100315` (UTC), value = plays in that hour.
// The Analytics page's chart of "plays in the last 24 hours" is built from it.
const PLAYS_HOURLY_KEY = 'plays:hourly';
// The first hour the hash covers; hours after it without a field had no plays.
const PLAYS_HOURLY_SINCE_KEY = 'plays:hourly:since';
// Set once the hours still in the buckets were copied into the hash.
const PLAYS_HOURLY_BACKFILLED_KEY = 'plays:hourly:backfilled';
const DAY_HOURS = 24;
/** The longest history the chart may ask for, in days. */
export const PLAY_HISTORY_MAX_DAYS = 730;

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

/**
 * The plays per hour over a range, oldest first, one entry per hour from
 * `start`. `plays` is that hour alone; `day` the 24 hours ending with it (the
 * Analytics page's "last 24 hours" figure as it stood that hour); `average`
 * the mean of `day` over the 24 hours ending there. `day` is null where the
 * 24 hours reach back before counting per hour began, `average` where it has
 * no `day` to average.
 */
export interface PlayHistory {
  /** The first hour counted per hour, or null before any play. */
  since: string | null;
  /** The hour of the first entry. */
  start: string;
  plays: number[];
  day: (number | null)[];
  average: (number | null)[];
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

/** The hash field of an hour: `2026100315` (UTC). */
export function playsHourField(at: Date): string {
  return at.toISOString().slice(0, 13).replace(/[-T]/g, '');
}

function startOfHour(at: Date): number {
  return Math.floor(at.getTime() / HOUR_MS) * HOUR_MS;
}

/**
 * The rolling 24-hour plays and their 24-hour moving average for the last
 * `hours` entries of `perHour` (plays per hour, oldest first, hour by hour).
 * `known` is how many entries at the end of `perHour` are counted hours;
 * the ones before it are from before counting began, so a window that
 * reaches into them has no figure.
 */
export function rollingPlays(
  perHour: number[],
  hours: number,
  known: number
): { plays: number[]; day: (number | null)[]; average: (number | null)[] } {
  const firstKnown = perHour.length - known;
  const allDay: (number | null)[] = [];
  let sum = 0;
  perHour.forEach((count, i) => {
    sum += count;
    if (i >= DAY_HOURS) sum -= perHour[i - DAY_HOURS];
    allDay.push(i - (DAY_HOURS - 1) >= firstKnown ? sum : null);
  });

  const allAverage: (number | null)[] = [];
  let total = 0;
  let counted = 0;
  allDay.forEach((value, i) => {
    if (value !== null) {
      total += value;
      counted++;
    }
    const leaving = i >= DAY_HOURS ? allDay[i - DAY_HOURS] : null;
    if (leaving !== null) {
      total -= leaving;
      counted--;
    }
    allAverage.push(
      value !== null && counted > 0 ? Math.round((total / counted) * 10) / 10 : null
    );
  });

  const from = Math.max(0, perHour.length - hours);
  return {
    plays: perHour.slice(from),
    day: allDay.slice(from),
    average: allAverage.slice(from),
  };
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
      .hincrby(PLAYS_HOURLY_KEY, playsHourField(at), 1)
      .set(PLAYS_HOURLY_SINCE_KEY, new Date(startOfHour(at)).toISOString(), 'NX')
      .exec();
  }

  /**
   * The plays per hour of the last `days` days up to this hour, with the
   * rolling 24-hour figure and its moving average (see PlayHistory).
   */
  public async getPlayHistory(
    days: number,
    now: Date = new Date()
  ): Promise<PlayHistory> {
    await this.backfillHourlyPlays(now);

    const hours =
      Math.min(PLAY_HISTORY_MAX_DAYS, Math.max(1, Math.floor(days) || 1)) *
      DAY_HOURS;
    // Two days more than shown: the first point's 24-hour figure needs the 23
    // hours before it, and its average the 23 figures before that.
    const lead = 2 * (DAY_HOURS - 1);
    const end = startOfHour(now);
    const first = end - (hours + lead - 1) * HOUR_MS;
    const fields = Array.from({ length: hours + lead }, (_, i) =>
      playsHourField(new Date(first + i * HOUR_MS))
    );
    const [values, since] = await Promise.all([
      this.client.hmget(PLAYS_HOURLY_KEY, ...fields),
      this.client.get(PLAYS_HOURLY_SINCE_KEY),
    ]);
    const perHour = values.map((value) => Number(value) || 0);
    const sinceMs = since ? new Date(since).getTime() : NaN;
    const known = Number.isFinite(sinceMs)
      ? Math.min(perHour.length, Math.max(0, (end - sinceMs) / HOUR_MS + 1))
      : 0;

    return {
      since: Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null,
      start: new Date(end - (hours - 1) * HOUR_MS).toISOString(),
      ...rollingPlays(perHour, hours, known),
    };
  }

  /**
   * Once: copies the hours still in the 8-day buckets into the hourly hash,
   * so the chart starts with a week of history instead of empty. It adds the
   * difference per hour, so plays the hash already counted are not doubled.
   */
  private async backfillHourlyPlays(now: Date): Promise<void> {
    if (await this.client.get(PLAYS_HOURLY_BACKFILLED_KEY)) return;
    const claimed = await this.client.set(
      PLAYS_HOURLY_BACKFILLED_KEY,
      now.toISOString(),
      'NX'
    );
    if (claimed === null) return;

    // Oldest first.
    const moments = Array.from(
      { length: 168 },
      (_, i) => new Date(startOfHour(now) - (167 - i) * HOUR_MS)
    );
    // One MULTI, so no play lands between reading a bucket and the hash.
    const read = this.client.multi();
    for (const at of moments) read.zrange(playsHourKey(at), 0, '-1', 'WITHSCORES');
    read.hmget(PLAYS_HOURLY_KEY, ...moments.map(playsHourField));
    read.get(PLAYS_HOURLY_SINCE_KEY);
    read.get(PLAYS_SINCE_KEY);
    const replies = (await read.exec()) || [];
    const failed = replies.find(([error]) => error);
    if (failed) throw failed[0];
    const kept = (replies[moments.length]?.[1] as (string | null)[]) || [];

    const write = this.client.multi();
    let oldest: Date | null = null;
    moments.forEach((at, i) => {
      const counts = new Map<number, number>();
      addScores(counts, replies[i]?.[1]);
      let plays = 0;
      for (const count of counts.values()) plays += count;
      if (plays <= 0) return;
      oldest ??= at;
      const missing = plays - (Number(kept[i]) || 0);
      if (missing > 0) write.hincrby(PLAYS_HOURLY_KEY, playsHourField(at), missing);
    });

    // The buckets cover every hour they reach back to, the quiet ones too,
    // when plays were already counted by then; otherwise from the first play.
    const countingSince = replies[moments.length + 2]?.[1] as string | null;
    const countedFrom = countingSince ? new Date(countingSince).getTime() : NaN;
    const covered: Date | null =
      Number.isFinite(countedFrom) && countedFrom <= moments[0].getTime()
        ? moments[0]
        : oldest;
    if (!covered) return;
    // The hash usually started later than the buckets reach back.
    const since = replies[moments.length + 1]?.[1] as string | null;
    if (!since || covered.getTime() < new Date(since).getTime()) {
      write.set(PLAYS_HOURLY_SINCE_KEY, covered.toISOString());
    }
    await write.exec();
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
