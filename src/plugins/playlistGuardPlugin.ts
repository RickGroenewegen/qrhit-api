import { color } from 'console-log-colors';
import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import Cache from '../cache';
import Logger from '../logger';
import Utils from '../utils';

/**
 * Guards the playlist endpoints: `/<service>/playlists` and
 * `/<service>/playlists/tracks` for every music service. Those load a
 * playlist from the service itself, so each uncached call spends our Spotify
 * (Tidal, Deezer, ...) quota, and a client loading playlists in bulk can get
 * the whole account rate limited for a day.
 *
 * Two things:
 *  1. User agents on the list below are refused (403).
 *  2. The `cache` flag in the body. The routes read it with
 *     `parseBoolean`, so a missing flag meant "skip the cache": any client
 *     that left it out got a fresh Spotify fetch every time. A missing flag
 *     now means "use the cache" (our frontend always sends it), and an
 *     explicit reload (`cache: 0`) is honoured `RELOADS_PER_WINDOW` times
 *     per IP per window. After that it is quietly served from the cache, so
 *     the customer's "refresh" and language switch keep working and a script
 *     cannot force reloads in bulk. A playlist that is not cached yet is
 *     always fetched: this only limits reloads.
 *
 * This is not AbuseGuard. That one protects the card links (`/qrlink`) and
 * bans addresses; this one refuses or downgrades the request and bans nobody.
 *
 * Patterns are case-insensitive substrings, so one pattern covers every
 * version ("okhttp" matches "okhttp/4.12.0"). Never add "node": our own SSR
 * server loads playlists with that agent.
 */
export const FORBIDDEN_PLAYLIST_USER_AGENTS = [
  // Android's HTTP library. The QRSong app sends its WebView's agent, never
  // this. On 2026-10-01 a client with it loaded ~50 playlists from one IP in
  // two minutes, up to seven at a time, every one a fresh Spotify fetch.
  'okhttp',
];

const PLAYLIST_PATH = /^\/[a-z-]+\/playlists(\/tracks)?$/;

// A reload in the order flow is two requests (playlist, then tracks), so this
// is ten reloads an hour, which no customer gets near.
const RELOADS_PER_WINDOW = 20;
const RELOAD_WINDOW_SECONDS = 3600;
const RELOAD_COUNT_PREFIX = 'playlist_reload';

/** The forbidden pattern a user agent matches, or null. */
export function forbiddenPlaylistAgent(userAgent: string): string | null {
  const ua = (userAgent || '').toLowerCase();
  if (!ua) {
    return null;
  }
  return FORBIDDEN_PLAYLIST_USER_AGENTS.find((p) => ua.includes(p)) ?? null;
}

export function isPlaylistPath(url: string): boolean {
  return PLAYLIST_PATH.test(url.split('?')[0]);
}

const playlistGuardPlugin: FastifyPluginAsync = async (fastify) => {
  const logger = new Logger();
  const cache = Cache.getInstance();
  const utils = new Utils();

  // A refused client keeps going (the first one fired seven requests at
  // once), so each address is reported once per worker and then refused
  // silently. Cleared when it gets large rather than kept forever.
  const reported = new Set<string>();

  fastify.addHook('onRequest', (request, reply, done) => {
    if (!isPlaylistPath(request.url)) {
      done();
      return;
    }

    const userAgent = (request.headers['user-agent'] as string) || '';
    const pattern = forbiddenPlaylistAgent(userAgent);
    if (!pattern) {
      done();
      return;
    }

    if (!reported.has(request.clientIp)) {
      if (reported.size >= 1000) {
        reported.clear();
      }
      reported.add(request.clientIp);
      logger.log(
        color.red.bold(
          `Refusing playlist requests from ip=${color.white.bold(
            request.clientIp || 'unknown'
          )} (forbidden user agent ${color.white.bold(
            pattern
          )}), userAgent=${color.white.bold(userAgent)}, path=${color.white.bold(
            request.url.split('?')[0]
          )}. Further requests from this ip are refused silently.`
        )
      );
    }

    reply.status(403).send({ error: 'Forbidden' });
  });

  // preHandler, not onRequest: the body is parsed by now.
  fastify.addHook('preHandler', async (request) => {
    if (!isPlaylistPath(request.url)) {
      return;
    }
    const body = request.body as Record<string, any> | undefined;
    if (!body || typeof body !== 'object') {
      return;
    }

    if (body['cache'] === undefined || body['cache'] === null) {
      body['cache'] = 1;
      return;
    }
    if (utils.parseBoolean(body['cache'])) {
      return;
    }

    // An explicit reload. Fails open: a Redis problem must not turn the
    // customer's refresh button into a no-op.
    let count: number;
    try {
      count = await cache.increment(
        `${RELOAD_COUNT_PREFIX}:${request.clientIp}`,
        RELOAD_WINDOW_SECONDS
      );
    } catch {
      return;
    }
    if (count <= RELOADS_PER_WINDOW) {
      return;
    }

    body['cache'] = 1;
    // The counter is shared by every worker, so this is one line per IP per
    // window however hard the client keeps trying.
    if (count === RELOADS_PER_WINDOW + 1) {
      logger.log(
        color.yellow.bold(
          `Serving playlist reloads from cache for ip=${color.white.bold(
            request.clientIp || 'unknown'
          )}: more than ${color.white.bold(
            RELOADS_PER_WINDOW
          )} in ${color.white.bold(
            RELOAD_WINDOW_SECONDS
          )}s, userAgent=${color.white.bold(
            (request.headers['user-agent'] as string) || 'unknown'
          )}`
        )
      );
    }
  });
};

export default fp(playlistGuardPlugin);
