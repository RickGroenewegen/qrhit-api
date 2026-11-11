import { color } from 'console-log-colors';
import { LOCALES, MARKETS } from './shared/shared-data.generated';
import { DataDeps } from './types';

/**
 * The featured list ranked per market: what people in the visitor's own
 * country buy comes first. See CLAUDE.md, "Featured ranking per market".
 *
 * The arithmetic (everything above `loadRankingInput`) is pure, so it can be
 * tested and read without a database. Rankings are computed by the nightly
 * stats job and kept in Redis, one list of playlist ids per market plus
 * `world`.
 */

/** A sale loses half its weight every this many days. */
export const RECENCY_HALF_LIFE_DAYS = 180;
/** Sales this close to today's date one year ago count extra. */
export const SEASON_WINDOW_DAYS = 45;
export const SEASON_WEIGHT = 0.5;
/** Weighted sales a parent ranking is worth when blended into a child's. */
export const BLEND_STRENGTH = 50;
/** Head start of a list in one of the market's own languages. */
export const OWN_LANGUAGE_BOOST = 1.5;
/** A list this young is ranked with at least the median list's sales. */
export const NEW_LIST_DAYS = 60;
/** Places at the top in which a genre may not come three times in a row. */
export const VARIETY_PLACES = 12;
export const VARIETY_RUN = 2;
/** Sales older than this are not read. */
export const SALES_YEARS = 3;

export const WORLD = 'world';
export const CACHE_KEY_MARKET_RANKING = 'featuredMarketRanking_v1_';

export interface RankPlaylist {
  id: number;
  genreId: number | null;
  /** Comma list of languages, or null for an international list. */
  featuredLocale: string | null;
  createdAt: Date;
}

/** Paid orders of one playlist from one country, about `daysAgo` days old. */
export interface SaleBucket {
  playlistId: number;
  /** ISO country of the buyer, or null when unknown (counts for the world only). */
  country: string | null;
  daysAgo: number;
  count: number;
}

export interface RankedPlaylist {
  id: number;
  /** What the order follows: the blended share of sales, boosts included. */
  value: number;
  /** Weighted sales in the market itself (the world's for `world`). */
  ownSales: number;
  worldSales: number;
  ownLanguage: boolean;
  isNew: boolean;
}

const MARKET_CODES = new Set<string>(MARKETS.map((m) => m.code));

/** The market's own playlist languages: its `locales` without the international `en`. */
export function ownLanguages(market: string): string[] {
  const locales = MARKETS.find((m) => m.code === market)?.locales ?? [];
  return locales.filter((l) => l !== 'en');
}

/**
 * The markets that share a first language with `market`, itself included
 * (NL + BE, DE + AT + CH + LI, the English-speaking ones). A thin market leans
 * on these before it leans on the world.
 */
export function languageGroup(market: string): string[] {
  const first = MARKETS.find((m) => m.code === market)?.locales?.[0];
  if (!first) return [market];
  return MARKETS.filter((m) => m.locales?.[0] === first).map((m) => m.code);
}

/** The country a site or app language implies (nl → NL), or null (jp, cn). */
export function countryOfLocale(locale: string): string | null {
  const l = LOCALES.find(
    (x) => x.code === locale || (x.aliases ?? []).includes(locale)
  );
  return l?.country ?? null;
}

/**
 * Which ranking a request gets. The first two-letter country among the
 * candidates decides (an explicit `?country=`, CloudFront's header, the IP's
 * country, the language's country, in that order at the call site); a country
 * that is not one of our markets gets the world's ranking.
 */
export function pickMarket(candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    if (typeof c !== 'string' || !/^[A-Za-z]{2}$/.test(c)) continue;
    const code = c.toUpperCase();
    return MARKET_CODES.has(code) ? code : WORLD;
  }
  return WORLD;
}

/** What one sale of `daysAgo` days old counts for today. */
export function saleWeight(daysAgo: number): number {
  const recency = Math.pow(0.5, Math.max(0, daysAgo) / RECENCY_HALF_LIFE_DAYS);
  const inSeason = Math.abs(daysAgo - 365) <= SEASON_WINDOW_DAYS;
  return recency + (inSeason ? SEASON_WEIGHT : 0);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function localesOf(featuredLocale: string | null): string[] {
  return (featuredLocale ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Weighted sales per playlist, for the world and per country. */
export function weighSales(buckets: SaleBucket[]): {
  world: Map<number, number>;
  perCountry: Map<string, Map<number, number>>;
} {
  const world = new Map<number, number>();
  const perCountry = new Map<string, Map<number, number>>();
  for (const b of buckets) {
    const w = saleWeight(b.daysAgo) * b.count;
    world.set(b.playlistId, (world.get(b.playlistId) ?? 0) + w);
    const country = b.country?.toUpperCase();
    if (!country) continue;
    let own = perCountry.get(country);
    if (!own) perCountry.set(country, (own = new Map()));
    own.set(b.playlistId, (own.get(b.playlistId) ?? 0) + w);
  }
  return { world, perCountry };
}

const sum = (m: Iterable<number>) => {
  let total = 0;
  for (const v of m) total += v;
  return total;
};

/**
 * No more than `VARIETY_RUN` lists of one genre in a row within the first
 * `VARIETY_PLACES`: the next list of another genre moves up. A list without
 * a genre never counts as a run.
 */
export function spreadGenres<T extends { genreId: number | null }>(ranked: T[]): T[] {
  const rest = [...ranked];
  const out: T[] = [];
  while (rest.length > 0) {
    let pick = 0;
    if (out.length < VARIETY_PLACES && out.length >= VARIETY_RUN) {
      const run = out.slice(-VARIETY_RUN).map((p) => p.genreId);
      const blocked = run[0] !== null && run.every((g) => g === run[0]) ? run[0] : null;
      if (blocked !== null) {
        const other = rest.findIndex((p) => p.genreId !== blocked);
        if (other > 0) pick = other;
      }
    }
    out.push(rest.splice(pick, 1)[0]);
  }
  return out;
}

/**
 * The playlists in the order `market` (a market code, or `WORLD`) should see
 * them. Every playlist gets a place, sold or not.
 */
export function rankMarket(
  playlists: RankPlaylist[],
  buckets: SaleBucket[],
  market: string,
  now: Date = new Date()
): RankedPlaylist[] {
  const { world, perCountry } = weighSales(buckets);

  // A young list is ranked as if it sold like the median list, so it is seen.
  const worldMedian = median(playlists.map((p) => world.get(p.id) ?? 0));
  const isNew = (p: RankPlaylist) =>
    (now.getTime() - p.createdAt.getTime()) / 86_400_000 < NEW_LIST_DAYS;
  const worldSales = (p: RankPlaylist) =>
    isNew(p) ? Math.max(world.get(p.id) ?? 0, worldMedian) : world.get(p.id) ?? 0;

  const ids = new Set(playlists.map((p) => p.id));
  const totalOf = (sales: Map<number, number>) =>
    sum([...sales].filter(([id]) => ids.has(id)).map(([, w]) => w));

  const worldTotal = sum(playlists.map(worldSales)) || 1;

  const isWorld = market === WORLD;
  const own = isWorld ? new Map<number, number>() : perCountry.get(market) ?? new Map();
  const ownTotal = totalOf(own);

  const group = new Map<number, number>();
  if (!isWorld) {
    for (const code of languageGroup(market)) {
      for (const [id, w] of perCountry.get(code) ?? []) {
        group.set(id, (group.get(id) ?? 0) + w);
      }
    }
  }
  const groupTotal = totalOf(group);

  const languages = isWorld ? [] : ownLanguages(market);

  const ranked = playlists.map((p) => {
    const worldShare = worldSales(p) / worldTotal;
    let value = worldShare;
    if (!isWorld) {
      const groupShare =
        ((group.get(p.id) ?? 0) + BLEND_STRENGTH * worldShare) /
        (groupTotal + BLEND_STRENGTH);
      value =
        ((own.get(p.id) ?? 0) + BLEND_STRENGTH * groupShare) /
        (ownTotal + BLEND_STRENGTH);
    }
    const ownLanguage = localesOf(p.featuredLocale).some((l) => languages.includes(l));
    if (ownLanguage) value *= OWN_LANGUAGE_BOOST;
    return {
      id: p.id,
      genreId: p.genreId,
      value,
      ownSales: isWorld ? world.get(p.id) ?? 0 : own.get(p.id) ?? 0,
      worldSales: world.get(p.id) ?? 0,
      ownLanguage,
      isNew: isNew(p),
    };
  });

  ranked.sort((a, b) => b.value - a.value || b.worldSales - a.worldSales || a.id - b.id);

  return spreadGenres(ranked).map(({ genreId: _genreId, ...rest }) => rest);
}

/** The score a place in a ranking of `total` gets: 100 for the first, falling, never equal. */
export function scoreForPlace(index: number, total: number): number {
  if (total <= 1) return 100;
  return Math.round(100 * (1 - index / total) * 1000) / 1000;
}

/**
 * Puts a featured list in a ranking's order and rewrites `score` to follow
 * it, with `rank` (1 = first). The released app sorts by `score` itself and
 * takes its "Popular" stickers from it, so the score is how the order reaches
 * it. A playlist the ranking does not know yet (featured today) keeps its
 * place after the ranked ones.
 */
export function applyRanking<T extends { id: number }>(
  list: T[],
  rankedIds: number[]
): Array<T & { score: number; rank: number }> {
  const place = new Map(rankedIds.map((id, i) => [Number(id), i]));
  const ordered = list
    .map((p, i) => ({ p, at: place.get(Number(p.id)) ?? rankedIds.length + i }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.p);
  return ordered.map((p, i) => ({
    ...p,
    score: scoreForPlace(i, ordered.length),
    rank: i + 1,
  }));
}

/* ----------------------------------------------------------------------- */
/* Data                                                                     */
/* ----------------------------------------------------------------------- */

export interface RankingInput {
  playlists: Array<RankPlaylist & { name: string; featuredHidden: boolean }>;
  buckets: SaleBucket[];
}

/**
 * Every featured playlist and its paid consumer orders of the last
 * `SALES_YEARS` years, grouped per playlist, buyer country and week.
 *
 * Left out: business orders, store sandbox purchases, and the orders of the
 * customer who submitted the playlist. One count per payment. The buyer's
 * country is the checkout's, else the shipping country, else the country the
 * order's site language implies.
 */
export async function loadRankingInput(deps: DataDeps): Promise<RankingInput> {
  const playlists = await deps.prisma.playlist.findMany({
    where: { featured: true },
    select: {
      id: true,
      name: true,
      genreId: true,
      featuredLocale: true,
      featuredHidden: true,
      createdAt: true,
    },
  });

  const rows = await deps.prisma.$queryRawUnsafe<
    Array<{
      playlistId: number;
      country: string | null;
      locale: string | null;
      weeksAgo: bigint | number;
      sales: bigint | number;
    }>
  >(`
    SELECT
      php.playlistId AS playlistId,
      UPPER(COALESCE(NULLIF(pay.countrycode, ''), NULLIF(pay.shippingCountry, ''))) AS country,
      pay.locale AS locale,
      FLOOR(DATEDIFF(NOW(), pay.createdAt) / 7) AS weeksAgo,
      COUNT(DISTINCT pay.id) AS sales
    FROM payment_has_playlist php
    JOIN payments pay ON pay.id = php.paymentId
    JOIN playlists p ON p.id = php.playlistId
    WHERE p.featured = 1
      AND pay.status = 'paid'
      AND pay.isBusinessOrder = 0
      AND (pay.storeEnvironment IS NULL OR pay.storeEnvironment <> 'sandbox')
      AND (p.promotionalUserId IS NULL OR pay.userId <> p.promotionalUserId)
      AND pay.createdAt >= DATE_SUB(NOW(), INTERVAL ${SALES_YEARS} YEAR)
    GROUP BY php.playlistId, country, pay.locale, weeksAgo
  `);

  const buckets: SaleBucket[] = rows.map((r) => ({
    playlistId: Number(r.playlistId),
    country:
      r.country && /^[A-Z]{2}$/.test(r.country)
        ? r.country
        : countryOfLocale(r.locale ?? ''),
    // The middle of the week the sales fell in.
    daysAgo: Number(r.weeksAgo) * 7 + 3,
    count: Number(r.sales),
  }));

  return { playlists, buckets };
}

/**
 * Ranks the featured playlists for every market and the world, and stores
 * each ranking in Redis as a list of playlist ids. Returns the world ranking,
 * which the stats job writes to `playlists.score`.
 */
export async function computeMarketRankings(
  deps: DataDeps
): Promise<{ world: RankedPlaylist[]; markets: number }> {
  const { playlists, buckets } = await loadRankingInput(deps);
  const now = new Date();

  const world = rankMarket(playlists, buckets, WORLD, now);
  await deps.cache.set(
    `${CACHE_KEY_MARKET_RANKING}${WORLD}`,
    JSON.stringify(world.map((r) => r.id))
  );
  for (const market of MARKETS) {
    const ranked = rankMarket(playlists, buckets, market.code, now);
    await deps.cache.set(
      `${CACHE_KEY_MARKET_RANKING}${market.code}`,
      JSON.stringify(ranked.map((r) => r.id))
    );
  }

  deps.logger.log(
    color.blue.bold(
      `Ranked ${color.white.bold(playlists.length)} featured playlists for ${color.white.bold(MARKETS.length)} markets`
    )
  );
  return { world, markets: MARKETS.length };
}

let computing: Promise<unknown> | null = null;

/**
 * The stored ranking of a market, or null when there is none to give. When
 * the rankings are missing altogether (a new Redis, a new package version in
 * the cache prefix) they are computed once, on the first request.
 */
export async function getMarketRanking(
  deps: DataDeps,
  market: string
): Promise<number[] | null> {
  const key = `${CACHE_KEY_MARKET_RANKING}${market}`;
  let stored = await deps.cache.get(key);
  if (!stored) {
    try {
      computing ??= computeMarketRankings(deps).finally(() => {
        computing = null;
      });
      await computing;
    } catch (error) {
      deps.logger.log(
        color.red.bold(
          `Market ranking failed: ${error instanceof Error ? error.message : error}`
        )
      );
      return null;
    }
    stored = await deps.cache.get(key);
  }
  if (!stored) return null;
  try {
    const ids = JSON.parse(stored);
    return Array.isArray(ids) ? ids.map(Number) : null;
  } catch {
    return null;
  }
}
