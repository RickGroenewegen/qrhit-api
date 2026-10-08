import { color } from 'console-log-colors';
import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import Cache from '../cache';
import Logger from '../logger';
import PrismaInstance from '../prisma';
import Settings from '../settings';
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
 *  3. Abuse protection, off unless switched on in the dashboard (Bulk
 *     actions, "Require reCAPTCHA for playlists", setting captcha_required).
 *     Then a playlist request needs a valid reCAPTCHA token (`captchaToken`
 *     in the body): anything else gets 403 `captchaRequired`, on which the
 *     site solves one and retries. One solved check covers the address for
 *     half an hour. Featured playlists (the catalogue, which our own server
 *     also renders) and trusted IPs are exempt. If the setting cannot be
 *     read, the check is skipped: an outage must not stop every playlist.
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

const CAPTCHA_PASS_PREFIX = 'playlist_captcha_ok';
const CAPTCHA_PASS_SECONDS = 1800;

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
  const settings = Settings.getInstance();
  const utils = new Utils();
  // Addresses asked for a reCAPTCHA, logged once per worker like `reported`.
  const captchaAsked = new Set<string>();

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

  // A playlist from our own catalogue: the product pages load these, also
  // when our server renders them, and they are cached anyway.
  async function isFeaturedRequest(body: Record<string, any> | undefined): Promise<boolean> {
    const id = typeof body?.['playlistId'] === 'string' ? body['playlistId'].trim() : '';
    if (!id) {
      return false;
    }
    try {
      const playlist = await PrismaInstance.getInstance().playlist.findFirst({
        where: { featured: true, OR: [{ playlistId: id }, { slug: id }] },
        select: { id: true },
      });
      return !!playlist;
    } catch {
      return false;
    }
  }

  async function passesCaptcha(
    clientIp: string,
    body: Record<string, any> | undefined
  ): Promise<boolean> {
    try {
      if (!(await settings.isCaptchaRequired())) {
        return true;
      }
    } catch {
      return true;
    }
    if (utils.isTrustedIp(clientIp) || (await isFeaturedRequest(body))) {
      return true;
    }

    const passKey = `${CAPTCHA_PASS_PREFIX}:${clientIp}`;
    try {
      if (await cache.get(passKey)) {
        return true;
      }
    } catch {
      // No pass to read: ask for a token.
    }

    const token = typeof body?.['captchaToken'] === 'string' ? body['captchaToken'] : '';
    if (!token || !(await utils.verifyRecaptcha(token)).isHuman) {
      return false;
    }
    try {
      await cache.set(passKey, '1', CAPTCHA_PASS_SECONDS);
    } catch {
      // The next request just asks again.
    }
    return true;
  }

  // preHandler, not onRequest: the body is parsed by now.
  fastify.addHook('preHandler', async (request, reply) => {
    if (!isPlaylistPath(request.url)) {
      return;
    }
    const body = request.body as Record<string, any> | undefined;

    if (!(await passesCaptcha(request.clientIp || '', body))) {
      if (!captchaAsked.has(request.clientIp)) {
        if (captchaAsked.size >= 1000) {
          captchaAsked.clear();
        }
        captchaAsked.add(request.clientIp);
        logger.log(
          color.yellow.bold(
            `Asking ip=${color.white.bold(
              request.clientIp || 'unknown'
            )} for a reCAPTCHA before loading playlists, userAgent=${color.white.bold(
              (request.headers['user-agent'] as string) || 'unknown'
            )}`
          )
        );
      }
      return reply.status(403).send({ success: false, error: 'captchaRequired' });
    }

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
