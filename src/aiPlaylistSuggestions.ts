import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import Cache from './cache';
import Data from './data';
import Translation from './translation';
import { llm, LlmOutputError } from './llm';

/**
 * Featured playlists that match what a customer asked the playlist generator
 * for.
 *
 * Customers often describe something the catalogue already has ("Disney
 * songs", "Schlager", "Eurovision", "all Taylor Swift songs"): a curated
 * list they can order straight away. So the progress page shows up to three
 * of them while their own playlist is being put together.
 *
 * The matching is one LLM call over the whole catalogue (about 600 lines,
 * 37k tokens, 1.5 s on luna with reasoning off, measured 2026-09-30). Word
 * matching cannot do it: the request is in any language, and half the
 * playlist names say nothing about what is in them ("Timeless Mix", "Wann
 * war das nochmal?"). The catalogue is the start of the prompt and the same
 * for every request that day; OpenAI caches such a prefix on its own. The
 * model is the aiSuggestFeatured route in src/llm/tasks.ts.
 */

const MAX_SUGGESTIONS = 3;
// The model is asked for more than is shown: some of its answers are for
// another market, or smaller than the customer asked for, and are dropped.
const MAX_MATCHES = 8;
const MIN_PROMPT_LENGTH = 3;
const DESCRIPTION_LENGTH = 240;
const CATALOGUE_TTL_SECONDS = 6 * 3600;
const RESULT_TTL_SECONDS = 6 * 3600;
const CATALOGUE_KEY = 'aiPlaylistSuggestCatalogue_v1_';
const RESULT_KEY = 'aiPlaylistSuggest_v1_';

export interface CataloguePlaylist {
  id: number;
  name: string;
  numberOfTracks: number;
  featuredLocale: string | null;
  genreName: string | null;
  description: string | null;
  promotionalTitle: string | null;
  promotionalDescription: string | null;
  decadePercentage1950: number;
  decadePercentage1960: number;
  decadePercentage1970: number;
  decadePercentage1980: number;
  decadePercentage1990: number;
  decadePercentage2000: number;
  decadePercentage2010: number;
  decadePercentage2020: number;
}

const DECADES: [keyof CataloguePlaylist, string][] = [
  ['decadePercentage1950', '50s'],
  ['decadePercentage1960', '60s'],
  ['decadePercentage1970', '70s'],
  ['decadePercentage1980', '80s'],
  ['decadePercentage1990', '90s'],
  ['decadePercentage2000', '00s'],
  ['decadePercentage2010', '10s'],
  ['decadePercentage2020', '20s'],
];

export const oneLine = (value: string | null | undefined): string =>
  String(value || '').replace(/\s+/g, ' ').trim();

/**
 * Cut by characters, not UTF-16 units: half an emoji is a lone surrogate, and
 * the LLM APIs answer a request body that holds one with a 400.
 */
export const truncate = (value: string, length: number): string =>
  Array.from(value).slice(0, length).join('');

/** The markets a playlist is meant for; empty for an international one. */
export function playlistMarkets(featuredLocale: string | null | undefined): string[] {
  return String(featuredLocale || '')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * One playlist as the model reads it:
 * `id | name | size | main decades | genre | market | description`.
 */
export function catalogueLine(p: CataloguePlaylist): string {
  const ownName = oneLine(p.name);
  const name = oneLine(p.promotionalTitle) || ownName;
  // The English page copy says what is in the list (genre, years, artists).
  // It opens with the playlist's name, which the line already has.
  let description = oneLine(p.description) || oneLine(p.promotionalDescription);
  if (ownName && description.toLowerCase().startsWith(ownName.toLowerCase())) {
    description = description.slice(ownName.length).trim();
  }
  const decades = DECADES.filter(([key]) => Number(p[key]) >= 20)
    .map(([, label]) => label)
    .join('/');
  const markets = playlistMarkets(p.featuredLocale);

  const parts = [String(p.id), name, `${p.numberOfTracks} tracks`];
  if (decades) parts.push(decades);
  if (p.genreName) parts.push(oneLine(p.genreName));
  parts.push(markets.length > 0 ? `market ${markets.join(',')}` : 'international');
  if (description) parts.push(truncate(description, DESCRIPTION_LENGTH));
  return parts.join(' | ');
}

/**
 * A playlist made for one market is only offered to a visitor of that market:
 * someone who uses the site in that language, wrote in it, or asked for music
 * from that country. Without it an English "80s hits" was answered with three
 * German lists.
 */
export function fitsMarket(
  featuredLocale: string | null | undefined,
  allowed: Set<string>
): boolean {
  const markets = playlistMarkets(featuredLocale);
  return markets.length === 0 || markets.some((m) => allowed.has(m));
}

class AIPlaylistSuggestions {
  private static instance: AIPlaylistSuggestions;
  private logger = new Logger();
  private prisma = PrismaInstance.getInstance();
  private cache = Cache.getInstance();
  private data = Data.getInstance();

  private constructor() {}

  public static getInstance(): AIPlaylistSuggestions {
    if (!AIPlaylistSuggestions.instance) {
      AIPlaylistSuggestions.instance = new AIPlaylistSuggestions();
    }
    return AIPlaylistSuggestions.instance;
  }

  private static resultKey(theme: string, locale: string): string {
    const hash = createHash('sha1')
      .update(`${locale}|${theme.toLowerCase()}`)
      .digest('hex');
    return `${RESULT_KEY}${hash}`;
  }

  /**
   * Up to three featured playlists that match the theme, best first, in the
   * shape `/featured/:locale` returns so the site's playlist card renders
   * them. Empty when nothing matches or the model cannot be reached: a
   * suggestion is an extra, it never fails the page.
   *
   * `minTracks` is how many tracks the customer asked for; a playlist with
   * fewer is not offered. The size is checked here and not by the model, so
   * what it matched is remembered once for every size.
   */
  public async suggest(
    prompt: string,
    locale: string,
    minTracks: number = 0
  ): Promise<any[]> {
    const theme = oneLine(prompt);
    if (theme.length < MIN_PROMPT_LENGTH) return [];

    try {
      const key = AIPlaylistSuggestions.resultKey(theme, locale);
      const cached = await this.cache.get(key, false);
      let ids: number[];
      if (cached) {
        ids = JSON.parse(cached);
      } else {
        ids = await this.match(theme, locale);
        await this.cache.set(key, JSON.stringify(ids), RESULT_TTL_SECONDS);
      }
      if (ids.length === 0) return [];

      // Names and descriptions as the visitor sees them everywhere else on
      // the site: their language, brand terms replaced.
      const featured: any[] = await this.data.getFeaturedPlaylists(locale, true);
      const byId = new Map(featured.map((p) => [Number(p.id), p]));
      return ids
        .map((id) => byId.get(id))
        .filter((p) => p && (minTracks <= 0 || Number(p.numberOfTracks) >= minTracks))
        .slice(0, MAX_SUGGESTIONS);
    } catch (err) {
      this.logger.log(
        color.yellow.bold(`[AI suggest] failed for "${white.bold(theme)}": ${err}`)
      );
      return [];
    }
  }

  /** The featured catalogue as the model reads it, the same all day. */
  private async catalogue(): Promise<CataloguePlaylist[]> {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const key = `${CATALOGUE_KEY}${today}`;
    const cached = await this.cache.get(key, false);
    if (cached) return JSON.parse(cached);

    // Same visibility rule as getFeaturedPlaylists. Read here and not from
    // that list, because it serves the customer's own blurb for a promotional
    // playlist where the English page copy says far more about the content.
    const rows = await this.prisma.$queryRaw<CataloguePlaylist[]>(Prisma.sql`
      SELECT
        p.id,
        p.name,
        p.numberOfTracks,
        p.featuredLocale,
        g.name_en AS genreName,
        p.description_en AS description,
        p.promotionalTitle,
        p.promotionalDescription,
        p.decadePercentage1950,
        p.decadePercentage1960,
        p.decadePercentage1970,
        p.decadePercentage1980,
        p.decadePercentage1990,
        p.decadePercentage2000,
        p.decadePercentage2010,
        p.decadePercentage2020
      FROM playlists p
      LEFT JOIN genres g ON p.genreId = g.id
      WHERE p.featured = 1
        AND p.featuredHidden = 0
        AND (p.promotionalActive = 0 OR p.promotionalAccepted = 1)
      ORDER BY p.score DESC, p.id
    `);
    await this.cache.set(key, JSON.stringify(rows), CATALOGUE_TTL_SECONDS);
    return rows;
  }

  private async match(theme: string, locale: string): Promise<number[]> {
    const playlists = await this.catalogue();
    if (playlists.length === 0) return [];

    const codes = Translation.ALL_LOCALES;
    const t0 = Date.now();
    type MatchAnswer = {
      promptLanguage?: unknown;
      musicMarket?: unknown;
      playlistIds?: unknown;
    };
    const answer = await llm.json<MatchAnswer>('aiSuggestFeatured', {
      messages: [
        {
          role: 'system',
          content:
            'You match what a customer wants in a music playlist against a catalogue of ready-made playlists.\n\n' +
            `Return the ids of the playlists that give the customer what they describe: the same artist, genre, era, country, language or occasion. At most ${MAX_MATCHES}, best match first.\n\n` +
            'Be strict. A playlist matches only when someone who asked for this theme would say "yes, that is what I meant".\n' +
            '  • A broad mix (all-time hits, party mixes, "best songs ever") does NOT match a specific request.\n' +
            '  • Sharing only a decade, or containing one of the artists the customer names, is not a match.\n' +
            '  • Numbers must agree: a playlist for a 60th birthday does not match an 80th birthday, a playlist for 1976 does not match 1986.\n' +
            '  • When nothing matches, return an empty list. That is the normal answer for an unusual request.\n\n' +
            'Also report:\n' +
            '  • promptLanguage: the language the customer wrote in.\n' +
            '  • musicMarket: set only when the customer asks for music from one country or in one language (German Schlager, Dutch hits, Italian classics); otherwise null.\n' +
            `Both use these codes: ${codes.join(', ')} (jp = Japanese, cn = Chinese), or "other".\n\n` +
            'In playlist names "Cartoon" stands for Disney. Only return ids that appear in the catalogue.\n\n' +
            'Catalogue, one playlist per line (id | name | size | main decades | genre | market | description):\n' +
            playlists.map(catalogueLine).join('\n'),
        },
        {
          role: 'user',
          content: `What the customer wants:\n${theme}`,
        },
      ],
      schema: {
        name: 'returnMatches',
        schema: {
          type: 'object',
          properties: {
            promptLanguage: { type: 'string', enum: [...codes, 'other'] },
            musicMarket: {
              type: ['string', 'null'],
              enum: [...codes, 'other', null],
            },
            playlistIds: { type: 'array', items: { type: 'integer' } },
          },
          required: ['promptLanguage', 'musicMarket', 'playlistIds'],
        },
      },
    }).catch((err) => {
      // An unusable answer matches nothing; its cost still counts.
      if (err instanceof LlmOutputError) return err;
      throw err;
    });
    const parsed: MatchAnswer =
      answer instanceof LlmOutputError ? {} : answer.data ?? {};

    const allowed = new Set<string>([locale]);
    for (const code of [parsed.promptLanguage, parsed.musicMarket]) {
      if (typeof code === 'string' && codes.includes(code)) allowed.add(code);
    }

    const byId = new Map(playlists.map((p) => [Number(p.id), p]));
    const ids: number[] = [];
    for (const raw of Array.isArray(parsed.playlistIds) ? parsed.playlistIds : []) {
      const id = Number(raw);
      const playlist = byId.get(id);
      // An id the model made up, or one for another market.
      if (!playlist || ids.includes(id)) continue;
      if (!fitsMarket(playlist.featuredLocale, allowed)) continue;
      ids.push(id);
      if (ids.length >= MAX_MATCHES) break;
    }

    this.logger.log(
      color.blue.bold(
        `[AI suggest] "${white.bold(theme)}" (${white.bold(locale)}) → ${white.bold(
          ids.length.toString()
        )} of ${white.bold(playlists.length.toString())} playlists in ${white.bold(
          ((Date.now() - t0) / 1000).toFixed(1) + 's'
        )}, $${white.bold(answer.costUsd.toFixed(4))}`
      )
    );

    return ids;
  }
}

export default AIPlaylistSuggestions;
