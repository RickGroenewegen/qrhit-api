/**
 * What the year lookup (music.ts, task yearLookup) reads before it answers:
 * a Google search through Serper and the Wikipedia pages of the song, with
 * Wikidata's dates for them. Pasted into the prompt, so the model needs no
 * web search of its own (Anthropic's cost $0.01 a search; Serper about
 * $0.001, Wikipedia and Wikidata nothing).
 */
import axios from 'axios';
import { color } from 'console-log-colors';
import Logger from './logger';

const logger = new Logger();

const SERPER_URL = 'https://google.serper.dev/search';
/** Wikimedia answers a generic client (axios' own User-Agent) with a 403. */
const WIKI_USER_AGENT = 'QRHit/1.0 (info@rickgroenewegen.nl)';
const TIMEOUT_MS = 10_000;
/** Wikipedia pages read per song, in different languages. */
const MAX_WIKI_PAGES = 2;
const MAX_EXTRACT_CHARS = 1500;

/** One search result, in the shape the admin year-check page lists (tracks.googleResults). */
export interface GoogleResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

export interface WikipediaPage {
  lang: string;
  title: string;
  url: string;
  extract: string;
  /** Wikidata P577 (publication date), as precise as Wikidata has it. */
  published: string[];
  /** Wikidata P571 (inception): when a classical work was composed. */
  composed: string[];
}

export interface YearEvidence {
  google: GoogleResult[];
  /** Google's information panel ("Released: 1982"), when it shows one. */
  knowledgeGraph: Record<string, string> | null;
  wikipedia: WikipediaPage[];
}

let warnedNoSerperKey = false;

/** Google results for the song from Serper; none without SERPER_API_KEY or when Serper fails. */
export async function searchGoogle(
  artist: string,
  title: string
): Promise<Pick<YearEvidence, 'google' | 'knowledgeGraph'>> {
  const apiKey = process.env['SERPER_API_KEY'];
  if (!apiKey) {
    if (!warnedNoSerperKey) {
      logger.log(color.yellow('SERPER_API_KEY is not set: the year lookup reads Wikipedia only'));
      warnedNoSerperKey = true;
    }
    return { google: [], knowledgeGraph: null };
  }
  try {
    const response = await axios.post(
      SERPER_URL,
      { q: `${artist} - ${title} (song) release date`, num: 10 },
      { headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS }
    );
    const organic: any[] = Array.isArray(response.data?.organic) ? response.data.organic : [];
    const google = organic
      .filter((result) => typeof result?.link === 'string')
      .map((result) => ({
        title: String(result.title ?? ''),
        url: result.link,
        snippet: [result.date, result.snippet].filter(Boolean).join(' · '),
        domain: hostname(result.link),
      }));
    return { google, knowledgeGraph: knowledgeGraph(response.data?.knowledgeGraph) };
  } catch (error: any) {
    logger.log(color.red(`Serper search failed for ${artist} - ${title}: ${error.message}`));
    return { google: [], knowledgeGraph: null };
  }
}

/** Title, type and attributes of Google's panel, flattened; null when there is none. */
function knowledgeGraph(panel: any): Record<string, string> | null {
  if (!panel || typeof panel !== 'object') return null;
  const flat: Record<string, string> = {};
  if (panel.title) flat['Title'] = String(panel.title);
  if (panel.type) flat['Type'] = String(panel.type);
  if (panel.attributes && typeof panel.attributes === 'object') {
    for (const [key, value] of Object.entries(panel.attributes)) {
      flat[key] = String(value);
    }
  }
  return Object.keys(flat).length ? flat : null;
}

/** `{ lang, title }` of a Wikipedia article URL (mobile links too), or null. */
export function wikipediaArticle(url: string): { lang: string; title: string } | null {
  const match = url.match(/^https?:\/\/([a-z]{2,3})(?:\.m)?\.wikipedia\.org\/wiki\/([^?#]+)/);
  if (!match) return null;
  try {
    return { lang: match[1], title: decodeURIComponent(match[2]).replace(/_/g, ' ') };
  } catch {
    return null;
  }
}

/** The title of Wikipedia's first search hit, or null. */
async function searchWikipedia(lang: string, query: string): Promise<string | null> {
  try {
    const response = await axios.get(`https://${lang}.wikipedia.org/w/api.php`, {
      params: { action: 'query', list: 'search', srsearch: query, srlimit: 1, format: 'json' },
      headers: { 'User-Agent': WIKI_USER_AGENT },
      timeout: TIMEOUT_MS,
    });
    return response.data?.query?.search?.[0]?.title ?? null;
  } catch (error: any) {
    logger.log(color.yellow(`Wikipedia search failed (${lang}) for ${query}: ${error.message}`));
    return null;
  }
}

/** A page's summary with its Wikidata dates; null for a missing or disambiguation page. */
async function wikipediaPage(lang: string, title: string): Promise<WikipediaPage | null> {
  try {
    const response = await axios.get(
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      { headers: { 'User-Agent': WIKI_USER_AGENT }, timeout: TIMEOUT_MS }
    );
    const summary = response.data;
    if (!summary?.extract || summary.type === 'disambiguation') return null;
    const dates = summary.wikibase_item
      ? await wikidataDates(summary.wikibase_item)
      : { published: [], composed: [] };
    return {
      lang,
      title: String(summary.title ?? title),
      url: summary.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      extract: String(summary.extract).slice(0, MAX_EXTRACT_CHARS),
      ...dates,
    };
  } catch (error: any) {
    logger.log(color.yellow(`Wikipedia page failed (${lang}) ${title}: ${error.message}`));
    return null;
  }
}

/** Publication (P577) and inception (P571) dates of a Wikidata item. */
async function wikidataDates(itemId: string): Promise<Pick<WikipediaPage, 'published' | 'composed'>> {
  try {
    const response = await axios.get('https://www.wikidata.org/w/api.php', {
      params: { action: 'wbgetclaims', entity: itemId, format: 'json' },
      headers: { 'User-Agent': WIKI_USER_AGENT },
      timeout: TIMEOUT_MS,
    });
    const claims = response.data?.claims ?? {};
    return { published: claimDates(claims['P577']), composed: claimDates(claims['P571']) };
  } catch (error: any) {
    logger.log(color.yellow(`Wikidata failed for ${itemId}: ${error.message}`));
    return { published: [], composed: [] };
  }
}

/** Wikidata time values as 1982, 1982-04 or 1982-04-08, by their precision, oldest first. */
export function claimDates(claims: any): string[] {
  if (!Array.isArray(claims)) return [];
  const dates = claims
    .map((claim) => claim?.mainsnak?.datavalue?.value)
    .filter((value) => typeof value?.time === 'string')
    .map((value) => {
      const match = value.time.match(/^\+?(-?\d{1,4})-(\d{2})-(\d{2})/);
      if (!match) return null;
      const [, year, month, day] = match;
      if (value.precision >= 11) return `${year}-${month}-${day}`;
      if (value.precision === 10) return `${year}-${month}`;
      return year;
    })
    .filter((date): date is string => Boolean(date));
  return [...new Set(dates)].sort();
}

/**
 * Everything the year lookup reads about a song: one Serper search, then the
 * Wikipedia pages Google found (up to two languages), or Wikipedia's own
 * search in English when Google found none.
 */
export async function gatherYearEvidence(artist: string, title: string): Promise<YearEvidence> {
  const { google, knowledgeGraph } = await searchGoogle(artist, title);

  const articles: Array<{ lang: string; title: string }> = [];
  for (const result of google) {
    const article = wikipediaArticle(result.url);
    if (article && !articles.some((a) => a.lang === article.lang)) articles.push(article);
    if (articles.length === MAX_WIKI_PAGES) break;
  }
  if (articles.length === 0) {
    const found = await searchWikipedia('en', `${artist} ${title}`);
    if (found) articles.push({ lang: 'en', title: found });
  }

  const pages = await Promise.all(articles.map((a) => wikipediaPage(a.lang, a.title)));
  return { google, knowledgeGraph, wikipedia: pages.filter((p): p is WikipediaPage => p !== null) };
}

/**
 * The results for tracks.googleResults (the admin year-check page): Google's,
 * plus a Wikipedia page Google did not list, so the page's Wikipedia button
 * still finds it.
 */
export function evidenceForReview(evidence: YearEvidence): GoogleResult[] {
  const results = [...evidence.google];
  for (const page of evidence.wikipedia) {
    if (results.some((r) => wikipediaArticle(r.url)?.lang === page.lang)) continue;
    results.push({
      title: page.title,
      url: page.url,
      snippet: page.extract.slice(0, 200),
      domain: hostname(page.url),
    });
  }
  return results;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
