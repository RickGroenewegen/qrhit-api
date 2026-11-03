import { Prisma } from '@prisma/client';
import PrismaInstance from './prisma';

/**
 * The statistics at the top of the admin's Broadcasts page
 * (`GET /push/stats`): devices per platform, new ones per month, and how many
 * turned out unreachable.
 *
 * What the data can and cannot say:
 * - The app registers its token once, when the user accepts the push prompt
 *   (qrhit-app `push.service.ts`), and never again on a later start. So
 *   `updatedAt` is not a "last seen" and there is no "active devices" figure.
 * - A token is only found dead when a live broadcast fails on it: any send
 *   error marks it invalid (`push.ts`), which also stamps `updatedAt`. So
 *   "reachable" is "not known to be dead", and the unreachable tokens land in
 *   the month (and on the broadcast) that found them.
 * - A browser that unsubscribes is deleted, not marked, so web subscriptions
 *   only show up as unreachable when a send got a 404 or 410.
 */

export type PushPlatform = 'ios' | 'android' | 'web';

export interface PlatformStats {
  reachable: number;
  unreachable: number;
  test: number;
  new7d: number;
  new30d: number;
  /** Reachable devices registered after the last live broadcast: never sent one yet. */
  sinceLastLive: number;
}

export interface MonthStats {
  /** 'YYYY-MM', UTC */
  month: string;
  ios: number;
  android: number;
  web: number;
  /** Devices found unreachable in that month (by a broadcast). */
  unreachable: number;
}

export interface BroadcastLoss {
  id: number;
  ios: number;
  android: number;
  web: number;
}

export interface PushStats {
  platforms: Record<PushPlatform, PlatformStats>;
  firstRegisteredAt: Date | null;
  lastLive: { id: number; createdAt: Date; numberOfDevices: number } | null;
  months: MonthStats[];
  webLocales: { locale: string | null; count: number }[];
  /** Per live broadcast: the devices it found unreachable. */
  unreachableByBroadcast: BroadcastLoss[];
}

export const STATS_MONTHS = 24;
const DAY_MS = 86_400_000;

interface PlatformRow {
  platform: string;
  reachable: unknown;
  unreachable: unknown;
  test: unknown;
  new7d: unknown;
  new30d: unknown;
  sinceLastLive: unknown;
  first: Date | null;
}

interface MonthRow {
  month: string;
  platform: string;
  n: unknown;
}

interface LossRow {
  id: number;
  platform: string;
  n: unknown;
}

function isPlatform(value: string): value is PushPlatform {
  return value === 'ios' || value === 'android' || value === 'web';
}

/** COUNT comes back from MySQL as a BigInt, SUM as a Decimal or null. */
export function toCount(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 'YYYY-MM' of the `count` months up to and including the one `now` is in (UTC), oldest first. */
export function monthKeys(now: Date, count: number): string[] {
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

/**
 * One row per month in `keys` with zeros filled in, starting at the first
 * month that has anything: months before the first device say nothing.
 */
export function buildMonths(keys: string[], added: MonthRow[], lost: MonthRow[]): MonthStats[] {
  const months = new Map<string, MonthStats>(
    keys.map((month) => [month, { month, ios: 0, android: 0, web: 0, unreachable: 0 }])
  );
  for (const row of added) {
    const month = months.get(row.month);
    if (month && isPlatform(row.platform)) month[row.platform] += toCount(row.n);
  }
  for (const row of lost) {
    const month = months.get(row.month);
    if (month) month.unreachable += toCount(row.n);
  }
  const list = [...months.values()];
  const first = list.findIndex((m) => m.ios + m.android + m.web + m.unreachable > 0);
  return first === -1 ? [] : list.slice(first);
}

function emptyPlatform(): PlatformStats {
  return { reachable: 0, unreachable: 0, test: 0, new7d: 0, new30d: 0, sinceLastLive: 0 };
}

export function buildPlatforms(rows: PlatformRow[]): {
  platforms: Record<PushPlatform, PlatformStats>;
  firstRegisteredAt: Date | null;
} {
  const platforms: Record<PushPlatform, PlatformStats> = {
    ios: emptyPlatform(),
    android: emptyPlatform(),
    web: emptyPlatform(),
  };
  let firstRegisteredAt: Date | null = null;
  for (const row of rows) {
    if (!isPlatform(row.platform)) continue;
    const stats = platforms[row.platform];
    stats.reachable += toCount(row.reachable);
    stats.unreachable += toCount(row.unreachable);
    stats.test += toCount(row.test);
    stats.new7d += toCount(row.new7d);
    stats.new30d += toCount(row.new30d);
    stats.sinceLastLive += toCount(row.sinceLastLive);
    if (row.first && (!firstRegisteredAt || row.first < firstRegisteredAt)) {
      firstRegisteredAt = row.first;
    }
  }
  return { platforms, firstRegisteredAt };
}

export function buildLosses(rows: LossRow[]): BroadcastLoss[] {
  const byId = new Map<number, BroadcastLoss>();
  for (const row of rows) {
    if (!isPlatform(row.platform)) continue;
    const id = Number(row.id);
    const loss = byId.get(id) ?? { id, ios: 0, android: 0, web: 0 };
    loss[row.platform] += toCount(row.n);
    byId.set(id, loss);
  }
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

class PushStatsService {
  private static instance: PushStatsService;
  private prisma = PrismaInstance.getInstance();

  public static getInstance(): PushStatsService {
    if (!PushStatsService.instance) {
      PushStatsService.instance = new PushStatsService();
    }
    return PushStatsService.instance;
  }

  public async get(now = new Date()): Promise<PushStats> {
    const lastLive = await this.prisma.pushMessage.findFirst({
      where: { test: false, dry: false },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, numberOfDevices: true },
    });
    const since7 = new Date(now.getTime() - 7 * DAY_MS);
    const since30 = new Date(now.getTime() - 30 * DAY_MS);
    const lastLiveAt = lastLive?.createdAt ?? new Date(0);
    const keys = monthKeys(now, STATS_MONTHS);
    const [year, month] = keys[0].split('-').map(Number);
    const start = new Date(Date.UTC(year, month - 1, 1));

    const [appRows, webRows, appAdded, webAdded, appLost, webLost, appLoss, webLoss, locales] =
      await Promise.all([
        this.prisma.$queryRaw<PlatformRow[]>(Prisma.sql`
          SELECT type AS platform,
            SUM(valid = 1) AS reachable,
            SUM(valid = 0) AS unreachable,
            SUM(valid = 1 AND test = 1) AS test,
            SUM(createdAt >= ${since7}) AS new7d,
            SUM(createdAt >= ${since30}) AS new30d,
            SUM(valid = 1 AND createdAt > ${lastLiveAt}) AS sinceLastLive,
            MIN(createdAt) AS first
          FROM push_tokens
          GROUP BY type`),
        this.prisma.$queryRaw<PlatformRow[]>(Prisma.sql`
          SELECT 'web' AS platform,
            SUM(valid = 1) AS reachable,
            SUM(valid = 0) AS unreachable,
            SUM(valid = 1 AND test = 1) AS test,
            SUM(createdAt >= ${since7}) AS new7d,
            SUM(createdAt >= ${since30}) AS new30d,
            SUM(valid = 1 AND createdAt > ${lastLiveAt}) AS sinceLastLive,
            MIN(createdAt) AS first
          FROM web_push_subscriptions`),
        this.prisma.$queryRaw<MonthRow[]>(Prisma.sql`
          SELECT DATE_FORMAT(createdAt, '%Y-%m') AS month, type AS platform, COUNT(*) AS n
          FROM push_tokens
          WHERE createdAt >= ${start}
          GROUP BY month, platform`),
        this.prisma.$queryRaw<MonthRow[]>(Prisma.sql`
          SELECT DATE_FORMAT(createdAt, '%Y-%m') AS month, 'web' AS platform, COUNT(*) AS n
          FROM web_push_subscriptions
          WHERE createdAt >= ${start}
          GROUP BY month`),
        this.prisma.$queryRaw<MonthRow[]>(Prisma.sql`
          SELECT DATE_FORMAT(updatedAt, '%Y-%m') AS month, type AS platform, COUNT(*) AS n
          FROM push_tokens
          WHERE valid = 0 AND updatedAt >= ${start}
          GROUP BY month, platform`),
        this.prisma.$queryRaw<MonthRow[]>(Prisma.sql`
          SELECT DATE_FORMAT(updatedAt, '%Y-%m') AS month, 'web' AS platform, COUNT(*) AS n
          FROM web_push_subscriptions
          WHERE valid = 0 AND updatedAt >= ${start}
          GROUP BY month`),
        // A broadcast's sends start a moment before its row is written, and
        // end well within the day; the next live broadcast closes the window
        this.prisma.$queryRaw<LossRow[]>(Prisma.sql`
          WITH live AS (
            SELECT id, createdAt, LEAD(createdAt) OVER (ORDER BY createdAt) AS nextAt
            FROM push_messages
            WHERE test = 0 AND dry = 0
          )
          SELECT live.id AS id, t.type AS platform, COUNT(*) AS n
          FROM live
          JOIN push_tokens t
            ON t.valid = 0
            AND t.updatedAt >= live.createdAt - INTERVAL 5 MINUTE
            AND t.updatedAt < LEAST(live.createdAt + INTERVAL 1 DAY, COALESCE(live.nextAt, live.createdAt + INTERVAL 1 DAY))
          GROUP BY live.id, t.type`),
        this.prisma.$queryRaw<LossRow[]>(Prisma.sql`
          WITH live AS (
            SELECT id, createdAt, LEAD(createdAt) OVER (ORDER BY createdAt) AS nextAt
            FROM push_messages
            WHERE test = 0 AND dry = 0
          )
          SELECT live.id AS id, 'web' AS platform, COUNT(*) AS n
          FROM live
          JOIN web_push_subscriptions w
            ON w.valid = 0
            AND w.updatedAt >= live.createdAt - INTERVAL 5 MINUTE
            AND w.updatedAt < LEAST(live.createdAt + INTERVAL 1 DAY, COALESCE(live.nextAt, live.createdAt + INTERVAL 1 DAY))
          GROUP BY live.id`),
        this.prisma.webPushSubscription.groupBy({
          by: ['locale'],
          where: { valid: true },
          _count: { _all: true },
        }),
      ]);

    const { platforms, firstRegisteredAt } = buildPlatforms([...appRows, ...webRows]);
    return {
      platforms,
      firstRegisteredAt,
      lastLive,
      months: buildMonths(keys, [...appAdded, ...webAdded], [...appLost, ...webLost]),
      webLocales: locales
        .map((row) => ({ locale: row.locale, count: row._count._all }))
        .sort((a, b) => b.count - a.count),
      unreachableByBroadcast: buildLosses([...appLoss, ...webLoss]),
    };
  }
}

export default PushStatsService;
