import axios from 'axios';

/**
 * Asks a music service whether a featured playlist's source playlist is still
 * there. One probe is one request (Apple Music: one per storefront until one
 * answers), and it never retries: pacing, Retry-After and the second look at
 * a "gone" are the run's job (run.ts).
 *
 * Only an answer the service gives about the playlist itself is "gone": a
 * 404 in the service's own error format, Deezer's "no data", YouTube's empty
 * playlist page. Everything that could be us or a bad minute (429, 5xx, a
 * timeout, no answer, our own token refused) is "unknown" and `transient`,
 * which counts towards stopping the run for that service. An answer that is
 * definite but not understood (an unexpected 4xx, a Spotify-owned playlist
 * the Web API cannot see) is "unknown" and not transient: it changes nothing
 * and does not stop the run.
 */

export type LinkVerdict = 'available' | 'gone' | 'unknown';

export interface LinkProbeResult {
  verdict: LinkVerdict;
  /** Might be us or a bad minute; enough of these in a row stop the service. */
  transient: boolean;
  /** What the service said, for the log and the notification. */
  reason: string;
  /** A 429: the service wants us to slow down. */
  rateLimited?: boolean;
  /** Seconds from the 429's Retry-After (or the service's documented window). */
  retryAfterSeconds?: number;
}

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

/** Status 0: no answer at all (timeout, DNS, connection refused). */
export interface HttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: any;
  error?: string;
}

/** Never throws: a failure without an answer is status 0. */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

export interface LinkTarget {
  playlistId: string;
  serviceType: string;
  featuredLocale: string | null;
}

export interface ProbeContext {
  http: HttpClient;
  tokens: {
    spotify(): Promise<string | null>;
    apple(): Promise<string | null>;
    tidal(): Promise<string | null>;
  };
  /** The Spotify GraphQL scraper (SPOTIFY_SCRAPER_URL), null when not configured. */
  scraper: { url: string; apiKey: string } | null;
  /** The Apple Music storefronts a playlist is looked up in, in order. */
  appleStorefronts(featuredLocale: string | null): string[];
}

export const SERVICE_LABELS: Record<string, string> = {
  spotify: 'Spotify',
  deezer: 'Deezer',
  apple_music: 'Apple Music',
  tidal: 'Tidal',
  youtube_music: 'YouTube Music',
};

const TIMEOUT_MS = 15000;
const SCRAPER_TIMEOUT_MS = 30000;

/** Same public innertube client as YouTubeMusicProvider.buildRequestBody. */
const YT_MUSIC_BROWSE_URL =
  'https://www.youtube.com/youtubei/v1/browse?key=AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const YT_MUSIC_CLIENT = {
  clientName: 'WEB_REMIX',
  clientVersion: '1.20231219.01.00',
  hl: 'en',
  gl: 'US',
};

/**
 * Spotify's own editorial and algorithmic playlists (37i9dQZF1DX…, 37i9dQZEVX…).
 * The Web API answers 404 to our app for all of them, so a 404 there says
 * nothing; they are asked through the scraper instead.
 */
export function isSpotifyOwnedPlaylist(playlistId: string): boolean {
  return playlistId.startsWith('37i9dQZ');
}

/** The link Rick can open to see for himself. */
export function playlistLink(
  serviceType: string,
  playlistId: string,
  storefront: string = 'nl'
): string {
  const id = encodeURIComponent(playlistId);
  switch (serviceType) {
    case 'deezer':
      return `https://www.deezer.com/playlist/${id}`;
    case 'apple_music':
      return `https://music.apple.com/${storefront}/playlist/${id}`;
    case 'tidal':
      return `https://tidal.com/browse/playlist/${id}`;
    case 'youtube_music':
      return `https://music.youtube.com/playlist?list=${id}`;
    case 'spotify':
    default:
      return `https://open.spotify.com/playlist/${id}`;
  }
}

/** Seconds from a Retry-After header: a number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  return undefined;
}

function available(reason: string): LinkProbeResult {
  return { verdict: 'available', transient: false, reason };
}

function gone(reason: string): LinkProbeResult {
  return { verdict: 'gone', transient: false, reason };
}

function unknown(reason: string, transient: boolean): LinkProbeResult {
  return { verdict: 'unknown', transient, reason };
}

/**
 * Any answer a probe did not recognise. Only statuses that can be a bad
 * minute or our own credentials are transient.
 */
function otherwise(response: HttpResponse, service: string): LinkProbeResult {
  const { status } = response;
  if (status === 429) {
    return {
      verdict: 'unknown',
      transient: true,
      rateLimited: true,
      retryAfterSeconds: parseRetryAfter(response.headers['retry-after']),
      reason: `${service} answers 429 Too Many Requests`,
    };
  }
  if (status === 0) {
    return unknown(`${service} gave no answer (${response.error || 'timeout or network'})`, true);
  }
  if (status >= 500) {
    return unknown(`${service} answers ${status}`, true);
  }
  if (status === 401 || status === 403) {
    return unknown(`${service} refused our credentials (${status})`, true);
  }
  return unknown(`${service} answers ${status}, which the check does not read as gone`, false);
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function probeSpotify(id: string, ctx: ProbeContext): Promise<LinkProbeResult> {
  if (isSpotifyOwnedPlaylist(id)) {
    return probeSpotifyScraper(id, ctx);
  }
  const token = await ctx.tokens.spotify();
  if (!token) {
    return unknown('no Spotify access token (Spotify needs re-authorising)', true);
  }
  const response = await ctx.http({
    method: 'GET',
    url: `https://api.spotify.com/v1/playlists/${encodeURIComponent(id)}?fields=id`,
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: TIMEOUT_MS,
  });
  if (response.status === 200 && isObject(response.body) && response.body.id) {
    return available('Spotify answers 200');
  }
  // {"error":{"status":404,"message":"Resource not found"}}; a 404 without
  // Spotify's error object came from something in between, not Spotify.
  if (response.status === 404 && isObject(response.body) && isObject(response.body.error)) {
    return gone(`Spotify answers 404 "${response.body.error.message || 'Not found'}"`);
  }
  return otherwise(response, 'Spotify');
}

/**
 * Our GraphQL scraper (qrhit-spotify-scraper) answers 404
 * `{ success: false, error: "Playlist not found (NotFound)" }` when Spotify's
 * playlistV2 is a NotFound. "(no data)" means Spotify sent nothing usable,
 * which is not the same thing.
 */
async function probeSpotifyScraper(id: string, ctx: ProbeContext): Promise<LinkProbeResult> {
  if (!ctx.scraper) {
    return unknown('Spotify-owned playlist: the Web API cannot see it and no scraper is configured', false);
  }
  const response = await ctx.http({
    method: 'POST',
    url: `${ctx.scraper.url.replace(/\/+$/, '')}/playlist`,
    headers: { 'x-api-key': ctx.scraper.apiKey, 'Content-Type': 'application/json' },
    body: { playlistId: id },
    timeoutMs: SCRAPER_TIMEOUT_MS,
  });
  if (response.status === 200 && isObject(response.body) && response.body.success === true) {
    return available('Spotify (scraper) finds the playlist');
  }
  if (
    response.status === 404 &&
    isObject(response.body) &&
    response.body.success === false &&
    /^Playlist not found \(NotFound\)/.test(String(response.body.error || ''))
  ) {
    return gone(`Spotify (scraper) answers "${response.body.error}"`);
  }
  return otherwise(response, 'Spotify scraper');
}

/**
 * Deezer answers 200 with an error object. Code 800 (DataException "no data")
 * is a playlist it does not have. Codes 4 (quota: 50 requests per 5 seconds)
 * and 700 (service busy) are a bad minute.
 * https://developers.deezer.com/api/errors
 */
async function probeDeezer(id: string, ctx: ProbeContext): Promise<LinkProbeResult> {
  if (!/^\d+$/.test(id)) {
    return unknown(`"${id}" is not a Deezer playlist id`, false);
  }
  const response = await ctx.http({
    method: 'GET',
    url: `https://api.deezer.com/playlist/${id}?country=NL`,
    timeoutMs: TIMEOUT_MS,
  });
  if (response.status === 200 && isObject(response.body)) {
    const error = response.body.error;
    if (!error && response.body.id) {
      return available('Deezer answers 200');
    }
    if (isObject(error)) {
      const said = `Deezer answers ${error.type || 'error'} "${error.message || ''}" (code ${error.code})`;
      if (error.code === 800) return gone(said);
      if (error.code === 4) {
        return { verdict: 'unknown', transient: true, rateLimited: true, retryAfterSeconds: 5, reason: said };
      }
      if (error.code === 700) return unknown(said, true);
      return unknown(said, false);
    }
  }
  return otherwise(response, 'Deezer');
}

/**
 * Apple's catalog is per storefront: a playlist missing in one may be there in
 * another. Gone only when every storefront answers 404 with Apple's error
 * list (`{"errors":[{"status":"404","code":"40400",...}]}`).
 */
async function probeAppleMusic(target: LinkTarget, ctx: ProbeContext): Promise<LinkProbeResult> {
  const token = await ctx.tokens.apple();
  if (!token) {
    return unknown('no Apple Music developer token', true);
  }
  const storefronts = ctx.appleStorefronts(target.featuredLocale);
  for (const storefront of storefronts) {
    const response = await ctx.http({
      method: 'GET',
      url: `https://api.music.apple.com/v1/catalog/${storefront}/playlists/${encodeURIComponent(target.playlistId)}`,
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: TIMEOUT_MS,
    });
    if (response.status === 200 && Array.isArray(response.body?.data) && response.body.data.length > 0) {
      return available(`Apple Music answers 200 in storefront ${storefront}`);
    }
    if (response.status === 404 && Array.isArray(response.body?.errors)) {
      continue;
    }
    return otherwise(response, 'Apple Music');
  }
  return gone(`Apple Music answers 404 in storefront${storefronts.length > 1 ? 's' : ''} ${storefronts.join(', ')}`);
}

/**
 * Tidal's API is JSON:API: a missing playlist is a 404 with an `errors` list.
 * Asked with countryCode=US, as TidalProvider asks for the product page.
 */
async function probeTidal(id: string, ctx: ProbeContext): Promise<LinkProbeResult> {
  const token = await ctx.tokens.tidal();
  if (!token) {
    return unknown('no Tidal access token (Tidal needs connecting again)', true);
  }
  const response = await ctx.http({
    method: 'GET',
    url: `https://openapi.tidal.com/v2/playlists/${encodeURIComponent(id)}?countryCode=US`,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.api+json' },
    timeoutMs: TIMEOUT_MS,
  });
  if (response.status === 200 && isObject(response.body?.data)) {
    return available('Tidal answers 200');
  }
  if (response.status === 404 && Array.isArray(response.body?.errors)) {
    const detail = response.body.errors[0]?.detail || response.body.errors[0]?.code || 'Not found';
    return gone(`Tidal answers 404 "${detail}"`);
  }
  return otherwise(response, 'Tidal');
}

/** The browse_id YouTube says it answered for, from its tracking params. */
function answeredBrowseId(body: any): string | undefined {
  const services = body?.responseContext?.serviceTrackingParams;
  if (!Array.isArray(services)) return undefined;
  for (const service of services) {
    for (const param of service?.params || []) {
      if (param?.key === 'browse_id') return String(param.value);
    }
  }
  return undefined;
}

function hasErrorAlert(body: any): boolean {
  const alerts = body?.alerts;
  if (!Array.isArray(alerts)) return false;
  return alerts.some((alert: any) => {
    const renderer = alert?.alertRenderer || alert?.alertWithButtonRenderer;
    return renderer?.type === 'ERROR';
  });
}

/**
 * YouTube Music answers 200 either way. A playlist that exists has
 * `contents`; one that does not (deleted, private, or never there) is a page
 * with no `contents` and no `header` whose microformat says
 * `noindex: true` (seen on 2026-11-03), or carries an ERROR alert. The page
 * must name our browse id, so a consent or bot page never reads as gone.
 */
async function probeYouTubeMusic(id: string, ctx: ProbeContext): Promise<LinkProbeResult> {
  const browseId = id.startsWith('VL') ? id : `VL${id}`;
  const response = await ctx.http({
    method: 'POST',
    url: YT_MUSIC_BROWSE_URL,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: { context: { client: YT_MUSIC_CLIENT }, browseId },
    timeoutMs: TIMEOUT_MS,
  });
  if (response.status === 200 && isObject(response.body)) {
    const body = response.body;
    if (body.contents) {
      return available('YouTube Music answers with the playlist page');
    }
    const noindex = body.microformat?.microformatDataRenderer?.noindex === true;
    if (!body.header && (noindex || hasErrorAlert(body)) && answeredBrowseId(body) === browseId) {
      return gone('YouTube Music answers an empty playlist page (no contents, noindex)');
    }
    return unknown('YouTube Music answers a page the check does not recognise', false);
  }
  return otherwise(response, 'YouTube Music');
}

export async function probeLink(target: LinkTarget, ctx: ProbeContext): Promise<LinkProbeResult> {
  try {
    switch (target.serviceType) {
      case 'spotify':
        return await probeSpotify(target.playlistId, ctx);
      case 'deezer':
        return await probeDeezer(target.playlistId, ctx);
      case 'apple_music':
        return await probeAppleMusic(target, ctx);
      case 'tidal':
        return await probeTidal(target.playlistId, ctx);
      case 'youtube_music':
        return await probeYouTubeMusic(target.playlistId, ctx);
      default:
        return unknown(`no link check for service "${target.serviceType}"`, false);
    }
  } catch (error: any) {
    // A token lookup that threw, say: ours, not the playlist's.
    return unknown(`the check failed: ${error?.message || error}`, true);
  }
}

/** The HttpClient the API uses: axios, every status resolved, never a throw. */
export const axiosHttp: HttpClient = async (request) => {
  try {
    const response = await axios.request({
      method: request.method,
      url: request.url,
      headers: request.headers,
      data: request.body,
      timeout: request.timeoutMs,
      validateStatus: () => true,
      // Our scraper and YouTube answer JSON; anything else stays a string.
      responseType: 'json',
    });
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(response.headers || {})) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value == null ? undefined : String(value);
    }
    return { status: response.status, headers, body: response.data };
  } catch (error: any) {
    return { status: 0, headers: {}, body: null, error: error?.code || error?.message || String(error) };
  }
};
