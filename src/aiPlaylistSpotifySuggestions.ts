import OpenAI from 'openai';
import { createHash } from 'crypto';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import Cache from './cache';
import Spotify, { PlaylistSearchHit } from './spotify';
import { estimateCostUsd } from './aiPricing';
import { LLM_MODEL_FAST } from './llmModels';
import { oneLine, truncate } from './aiPlaylistSuggestions';

/**
 * Playlists on Spotify that match what a customer asked the playlist
 * generator for, shown on the progress page next to the featured ones
 * (aiPlaylistSuggestions.ts).
 *
 * A customer who picks one goes into the order flow with that playlist, the
 * same as pasting its link on step 1. Nothing is generated and no playlist
 * is created on our Spotify account.
 *
 * It works the other way round from the featured matcher, which shows the
 * model a whole catalogue. Spotify cannot be shown, only asked, so:
 *   1. the model turns the description into a search query (how would a
 *      playlist with this music be titled?),
 *   2. Spotify is asked once (see `Spotify.searchPlaylists` for what keeps
 *      that from getting in the way of the order flow),
 *   3. the model picks from what came back, strictly: most of it is somebody's
 *      private mix with a lookalike name.
 */

const MODEL = LLM_MODEL_FAST;
const MAX_SUGGESTIONS = 3;
const MIN_PROMPT_LENGTH = 3;
// A playlist has at least as many tracks as the customer asked for (never
// fewer than the form's minimum), and not absurdly more: up to the form's
// maximum, or twice what was asked when that is more. A 5,000-song
// collection is not a card game.
const MIN_TRACKS = 25;
const MAX_TRACKS = 500;
// A second search only when the first found next to nothing.
const ENOUGH_CANDIDATES = 4;
const SEARCH_LIMIT = 30;
const DESCRIPTION_LENGTH = 100;
// Two caches keep the same question from being asked twice in a day: this
// one holds the playlists picked for a description, and Spotify.searchPlaylists
// holds what each search query found. A description that comes back, or
// another one that leads to the same query, costs Spotify nothing.
const RESULT_TTL_SECONDS = 24 * 3600;
// When Spotify could not be asked (rate limited, budget used up): try again
// soon rather than remembering "nothing" for a day.
const UNAVAILABLE_TTL_SECONDS = 5 * 60;
const RESULT_KEY = 'aiPlaylistSpotifySuggest_v1_';

export interface SpotifySuggestion {
  id: string;
  name: string;
  owner: string;
  trackCount: number;
  image: string | null;
}

/** Spotify sends descriptions with HTML entities (`Raw &amp; extra raw`). */
function plainText(value: string): string {
  return oneLine(
    value
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
  );
}

/** One found playlist as the model reads it: `id | name | size | owner | description`. */
export function candidateLine(hit: PlaylistSearchHit): string {
  const parts = [hit.id, truncate(oneLine(hit.name), 120), `${hit.trackCount} tracks`];
  if (hit.owner) parts.push(`by ${truncate(oneLine(hit.owner), 40)}`);
  const description = plainText(hit.description);
  if (description) parts.push(truncate(description, DESCRIPTION_LENGTH));
  return parts.join(' | ');
}

/**
 * A playlist a customer could order as it is: it has a cover and the size
 * they asked for or more (`minTracks`, 0 when unknown).
 */
export function isUsable(hit: PlaylistSearchHit, minTracks: number = 0): boolean {
  return (
    hit.trackCount >= Math.max(MIN_TRACKS, minTracks) &&
    hit.trackCount <= Math.max(MAX_TRACKS, minTracks * 2) &&
    !!hit.image &&
    // Temporary playlists from earlier runs of our own generator.
    !/^qrsong! AI\b/i.test(hit.name)
  );
}

class AIPlaylistSpotifySuggestions {
  private static instance: AIPlaylistSpotifySuggestions;
  private logger = new Logger();
  private cache = Cache.getInstance();
  private spotify = Spotify.getInstance();
  private openai = new OpenAI({ apiKey: process.env['OPENAI_TOKEN'] });

  private constructor() {}

  public static getInstance(): AIPlaylistSpotifySuggestions {
    if (!AIPlaylistSpotifySuggestions.instance) {
      AIPlaylistSpotifySuggestions.instance = new AIPlaylistSpotifySuggestions();
    }
    return AIPlaylistSpotifySuggestions.instance;
  }

  private static resultKey(theme: string, locale: string, minTracks: number): string {
    const hash = createHash('sha1')
      .update(`${locale}|${minTracks}|${theme.toLowerCase()}`)
      .digest('hex');
    return `${RESULT_KEY}${hash}`;
  }

  /**
   * Up to three playlists on Spotify that match the theme, best first. Empty
   * when nothing matches, Spotify cannot be asked right now or a model call
   * fails: a suggestion is an extra, it never fails the page.
   *
   * `minTracks` is how many tracks the customer asked for. The same
   * description with another size is picked again, from what the search
   * already found: Spotify is not asked twice.
   */
  public async suggest(
    prompt: string,
    locale: string,
    minTracks: number = 0
  ): Promise<SpotifySuggestion[]> {
    const theme = oneLine(prompt);
    if (theme.length < MIN_PROMPT_LENGTH) return [];

    try {
      const key = AIPlaylistSpotifySuggestions.resultKey(theme, locale, minTracks);
      const cached = await this.cache.get(key, false);
      if (cached) return JSON.parse(cached);

      const t0 = Date.now();
      let costUsd = 0;
      const track = (result: any) => {
        costUsd += estimateCostUsd(
          MODEL,
          result?.usage?.prompt_tokens ?? 0,
          result?.usage?.completion_tokens ?? 0
        );
      };

      const queries = await this.queries(theme, locale, track);
      const candidates = new Map<string, PlaylistSearchHit>();
      let asked = 0;
      let reachable = queries.length === 0;
      for (const query of queries) {
        if (candidates.size >= ENOUGH_CANDIDATES) break;
        const found = await this.spotify.searchPlaylists(query, SEARCH_LIMIT);
        asked += 1;
        if (!found.success) continue;
        reachable = true;
        for (const hit of found.hits) {
          if (isUsable(hit, minTracks) && !candidates.has(hit.id)) {
            candidates.set(hit.id, hit);
          }
        }
      }

      const picked =
        candidates.size > 0
          ? await this.pick(theme, Array.from(candidates.values()), minTracks, track)
          : [];

      await this.cache.set(
        key,
        JSON.stringify(picked),
        reachable ? RESULT_TTL_SECONDS : UNAVAILABLE_TTL_SECONDS
      );
      this.logger.log(
        color.blue.bold(
          `[AI suggest] Spotify "${white.bold(theme)}" → searched ${white.bold(
            queries.slice(0, asked).join(' / ') || 'nothing'
          )}, ${white.bold(picked.length.toString())} of ${white.bold(
            candidates.size.toString()
          )} playlists in ${white.bold(
            ((Date.now() - t0) / 1000).toFixed(1) + 's'
          )}, $${white.bold(costUsd.toFixed(4))}`
        )
      );
      return picked;
    } catch (err) {
      this.logger.log(
        color.yellow.bold(`[AI suggest] Spotify failed for "${white.bold(theme)}": ${err}`)
      );
      return [];
    }
  }

  /** Step 1: what to type into Spotify's playlist search. */
  private async queries(
    theme: string,
    locale: string,
    track: (result: any) => void
  ): Promise<string[]> {
    const result = await this.openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You turn what a customer wants in a music playlist into a query for Spotify\'s playlist search.\n\n' +
            'That search matches the words of a query against playlist titles, so write the title a playlist with exactly this music would have: 2 to 5 plain words ("80s rock hits", "Deutsche Schlager 70er", "Disney songs", "Taylor Swift all songs").\n' +
            '  • Use the language such playlists are titled in: the customer\'s own language for music from their country, English otherwise.\n' +
            '  • Leave out everything that is an instruction to us and not a kind of music: how many tracks, "one song per artist", "no duplicates", "well known songs only".\n' +
            '  • Return the best query first and one alternative with different words. One is enough when there is no sensible alternative.\n' +
            '  • Return an empty list when no public playlist could be this: a personal mix of many unrelated artists, a private occasion.',
        },
        {
          role: 'user',
          content: `Customer's language: ${locale}\nWhat the customer wants:\n${theme}`,
        },
      ],
      reasoning_effort: 'none',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'returnQueries',
          schema: {
            type: 'object',
            properties: {
              queries: { type: 'array', items: { type: 'string' } },
            },
            required: ['queries'],
          },
        },
      },
    });
    track(result);

    let parsed: { queries?: unknown } = {};
    try {
      parsed = JSON.parse(result?.choices[0]?.message?.content || '{}');
    } catch {
      parsed = {};
    }
    const seen = new Set<string>();
    const queries: string[] = [];
    for (const raw of Array.isArray(parsed.queries) ? parsed.queries : []) {
      const query = typeof raw === 'string' ? truncate(oneLine(raw), 80) : '';
      const key = query.toLowerCase();
      if (query.length < 2 || seen.has(key)) continue;
      seen.add(key);
      queries.push(query);
      if (queries.length >= 2) break;
    }
    return queries;
  }

  /** Step 3: which of the playlists Spotify found are what the customer meant. */
  private async pick(
    theme: string,
    candidates: PlaylistSearchHit[],
    minTracks: number,
    track: (result: any) => void
  ): Promise<SpotifySuggestion[]> {
    // Every candidate is large enough already; among good matches the one
    // nearest to what was asked is the better offer.
    const size =
      minTracks > 0
        ? `\nThe customer asked for ${minTracks} tracks. Of playlists that fit equally well, prefer the one closest to that size.`
        : '';
    const result = await this.openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content:
            'A customer describes the music they want. Below are playlists that people made on Spotify. Pick the ones that give the customer what they describe.\n\n' +
            `Return at most ${MAX_SUGGESTIONS} ids, best match first. Be strict:\n` +
            '  • The name or description has to say clearly that the playlist is about this music. Skip a private mix with a vague name ("my favourites", "car", "for mum"), a joke name, and anything rude or offensive.\n' +
            '  • The era, country, language and artists the customer asks for have to agree with the playlist. A playlist about something nearby is not a match.\n' +
            '  • Of two playlists that fit equally well, prefer the one with the clearer name and a description.\n' +
            '  • When none fits, return an empty list. That is a normal answer.\n' +
            'Only return ids from the list.',
        },
        {
          role: 'user',
          content: `What the customer wants:\n${theme}${size}\n\nPlaylists (id | name | size | owner | description):\n${candidates
            .map(candidateLine)
            .join('\n')}`,
        },
      ],
      reasoning_effort: 'none',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'returnPlaylists',
          schema: {
            type: 'object',
            properties: {
              playlistIds: { type: 'array', items: { type: 'string' } },
            },
            required: ['playlistIds'],
          },
        },
      },
    });
    track(result);

    let parsed: { playlistIds?: unknown } = {};
    try {
      parsed = JSON.parse(result?.choices[0]?.message?.content || '{}');
    } catch {
      parsed = {};
    }
    const byId = new Map(candidates.map((hit) => [hit.id, hit]));
    const picked: SpotifySuggestion[] = [];
    for (const id of Array.isArray(parsed.playlistIds) ? parsed.playlistIds : []) {
      const hit = typeof id === 'string' ? byId.get(id) : undefined;
      if (!hit || picked.some((p) => p.id === hit.id)) continue;
      picked.push({
        id: hit.id,
        name: oneLine(hit.name),
        owner: oneLine(hit.owner),
        trackCount: hit.trackCount,
        image: hit.image,
      });
      if (picked.length >= MAX_SUGGESTIONS) break;
    }
    return picked;
  }
}

export default AIPlaylistSpotifySuggestions;
