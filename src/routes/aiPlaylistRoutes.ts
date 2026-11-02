import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { isIPv6 } from 'net';
import AIPlaylistGenerator, { aiPlaylistJobKey } from '../aiPlaylist';
import AIPlaylistSuggestions from '../aiPlaylistSuggestions';
import AIPlaylistSpotifySuggestions from '../aiPlaylistSpotifySuggestions';
import Logger from '../logger';
import Utils from '../utils';
import Cache from '../cache';
import { color, white } from 'console-log-colors';

const MIN_TRACKS = 25;
const MAX_TRACKS = 500;
const MAX_PROMPT_LEN = 250;
const DAILY_LIMIT = 5;
// The id the website keeps per browser (a UUID in localStorage).
const CLIENT_ID_PATTERN = /^[A-Za-z0-9-]{16,64}$/;
// How long a job's prompt is kept for the progress page's suggestions.
const JOB_TTL_SECONDS = 30 * 60;

function isDev(): boolean {
  return process.env['ENVIRONMENT'] === 'development';
}

function parseClientId(value: unknown): string {
  return typeof value === 'string' && CLIENT_ID_PATTERN.test(value) ? value : '';
}

/**
 * An IPv6 address counts by its /64: a home or phone connection gets a whole
 * /64, and the device moves to a new temporary address within it from time
 * to time, each with a fresh quota (2026-10-29: 5 playlists, then 5 more from
 * the same connection on a new address). IPv4, also mapped into IPv6, counts
 * as the address itself.
 */
function addressKey(ip: string): string {
  const address = ip.split('%')[0].toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return mapped[1];
  if (!isIPv6(address)) return ip;
  const [head, tail] = address.split('::');
  const groups = head ? head.split(':') : [];
  if (tail !== undefined) {
    const tailGroups = tail ? tail.split(':') : [];
    // An IPv4 tail ("::1.2.3.4") holds two groups.
    const tailSize = tailGroups.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
    groups.push(...Array(8 - groups.length - tailSize).fill('0'), ...tailGroups);
  }
  const prefix = groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

/**
 * The counters of the daily limit: the address, and the browser (the id the
 * form sends; the status check may come without). The address alone let one person make 29 playlists in a
 * day (2026-10-26): iCloud Private Relay gives Safari a new one every few
 * requests. Clearing the site's data drops the browser id, so it only holds
 * people who were not trying to get round the limit, which is most of them.
 */
function dailyKeys(ip: string, clientId: string): string[] {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(
    2,
    '0'
  )}${String(d.getUTCDate()).padStart(2, '0')}`;
  const keys = [`aiPlaylist:rate:${addressKey(ip)}:${ymd}`];
  if (clientId) {
    keys.push(`aiPlaylist:rate:client:${clientId}:${ymd}`);
  }
  return keys;
}

function parseLocale(value: unknown): string {
  return typeof value === 'string' && /^[a-z]{2}$/i.test(value)
    ? value.toLowerCase()
    : 'en';
}

export default async function aiPlaylistRoutes(fastify: FastifyInstance) {
  const generator = AIPlaylistGenerator.getInstance();
  const suggestions = AIPlaylistSuggestions.getInstance();
  const spotifySuggestions = AIPlaylistSpotifySuggestions.getInstance();
  const logger = new Logger();
  const utils = new Utils();
  const cache = Cache.getInstance();

  fastify.post('/ai-playlist/generate', async (request: any, reply: any) => {
    const body = (request.body || {}) as {
      prompt?: unknown;
      trackCount?: unknown;
      captchaToken?: unknown;
      locale?: unknown;
      clientId?: unknown;
    };
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const trackCount =
      typeof body.trackCount === 'number'
        ? Math.floor(body.trackCount)
        : Number.parseInt(String(body.trackCount), 10);
    const captchaToken =
      typeof body.captchaToken === 'string' ? body.captchaToken : '';
    const locale = parseLocale(body.locale);
    const clientId = parseClientId(body.clientId);

    if (!prompt || prompt.length > MAX_PROMPT_LEN) {
      return reply.status(400).send({
        success: false,
        error: `Prompt must be 1-${MAX_PROMPT_LEN} characters`,
      });
    }

    if (!Number.isFinite(trackCount) || trackCount < MIN_TRACKS || trackCount > MAX_TRACKS) {
      return reply.status(400).send({
        success: false,
        error: `trackCount must be between ${MIN_TRACKS} and ${MAX_TRACKS}`,
      });
    }

    // Only the website's form generates, and it always sends its browser id
    // (Rick, 2026-11-02: not for other applications to call directly). A
    // request without one gets the captcha's refusal, which names nothing.
    if (!clientId) {
      return reply
        .status(400)
        .send({ success: false, error: 'reCAPTCHA verification failed' });
    }

    // reCAPTCHA v3 — match the pattern used by /contact and the public
    // chat init route. Each AI run costs real OpenAI tokens, so we want
    // a soft bot gate before we kick off the job.
    if (!captchaToken) {
      return reply
        .status(400)
        .send({ success: false, error: 'reCAPTCHA verification failed' });
    }
    const { isHuman } = await utils.verifyRecaptcha(captchaToken);
    if (!isHuman) {
      return reply
        .status(400)
        .send({ success: false, error: 'reCAPTCHA verification failed' });
    }

    // Daily generation limit, per address and per browser (dailyKeys).
    // Bypassed in development and for TRUSTED_IPS so local testing / office
    // IPs aren't capped. Bumps each counter atomically with INCR; if one
    // lands over the limit we DECR them all back so the rejected attempt
    // doesn't count.
    const ip = utils.getClientIp(request);
    const rateLimitExempt = isDev() || utils.isTrustedIp(ip);
    // Returned so the form can update its counter without a follow-up GET.
    let remaining: number | null = null;
    if (!rateLimitExempt) {
      const keys = dailyKeys(ip, clientId);
      try {
        let used = 0;
        for (const key of keys) {
          const count = parseInt(await cache.executeCommand('incr', key), 10);
          if (count === 1) {
            await cache.executeCommand('expire', key, 24 * 3600);
          }
          used = Math.max(used, count);
        }
        if (used > DAILY_LIMIT) {
          for (const key of keys) {
            await cache.executeCommand('decr', key);
          }
          return reply.status(429).send({
            success: false,
            error: 'Daily AI generation limit reached',
            data: { used: DAILY_LIMIT, limit: DAILY_LIMIT, remaining: 0 },
          });
        }
        remaining = DAILY_LIMIT - used;
      } catch (err) {
        logger.log(
          color.yellow.bold(`[AI] Rate-limit check failed (allowing through): ${err}`)
        );
      }
    }

    const jobId = `ai-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

    logger.log(
      color.blue.bold(
        `[AI] Enqueued job ${white.bold(jobId)} prompt="${white.bold(
          prompt
        )}" trackCount=${white.bold(trackCount.toString())}`
      )
    );

    // The progress page asks for matching featured playlists by job id, and
    // it can get there before the background run has written anything.
    try {
      await cache.set(
        aiPlaylistJobKey(jobId),
        JSON.stringify({ prompt, locale, trackCount }),
        JOB_TTL_SECONDS
      );
    } catch (err) {
      logger.log(
        color.yellow.bold(`[AI] Could not store job ${white.bold(jobId)}: ${err}`)
      );
    }

    // Return immediately. Generation runs as fire-and-forget in this HTTP
    // child worker — same pattern as the summary music-provider routes —
    // so `ProgressWebSocketServer.getInstance()` is set and progress events
    // flow over the existing /progress-ws channel.
    reply.send({
      success: true,
      data: {
        jobId,
        rateLimit: rateLimitExempt
          ? null
          : { remaining, limit: DAILY_LIMIT, enforced: true },
      },
    });

    (async () => {
      try {
        await generator.run({ jobId, prompt, trackCount, locale });
      } catch (error: any) {
        logger.log(
          color.red.bold(
            `[AI] Background generation crashed for ${white.bold(jobId)}: ${error?.message || error}`
          )
        );
      }
    })();
  });

  // Existing playlists that match what a job was asked for: our featured
  // ones, and ones found on Spotify. The progress page shows them while the
  // customer waits.
  //
  // Asked by job, never by free text: nothing is searched before the
  // customer has pressed the button (Rick, 2026-09-30), and a job only
  // exists behind the captcha and the daily limit of /generate. So there is
  // no public endpoint that makes an LLM or Spotify call for whoever asks.
  // Always answers with a list: a suggestion is an extra, so a model that is
  // down shows nothing instead of an error.
  // A suggestion has at least as many tracks as the customer asked for: a
  // 42-song playlist is no answer to a request for 100.
  interface Suggester {
    suggest(prompt: string, locale: string, minTracks: number): Promise<unknown[]>;
  }

  const suggestForJob = (source: Suggester) => async (request: any, reply: any) => {
    const jobId = String(request.params?.jobId || '');
    let job: { prompt?: unknown; locale?: unknown; trackCount?: unknown } | null = null;
    try {
      const raw = jobId ? await cache.get(aiPlaylistJobKey(jobId), false) : null;
      job = raw ? JSON.parse(raw) : null;
    } catch {
      job = null;
    }
    if (!job || typeof job.prompt !== 'string') {
      return reply.send({ success: true, data: [] });
    }
    const minTracks =
      typeof job.trackCount === 'number' && job.trackCount > 0 ? job.trackCount : 0;
    return reply.send({
      success: true,
      data: await source.suggest(job.prompt, parseLocale(job.locale), minTracks),
    });
  };

  fastify.get('/ai-playlist/suggestions/:jobId', suggestForJob(suggestions));
  fastify.get('/ai-playlist/spotify-suggestions/:jobId', suggestForJob(spotifySuggestions));

  // Daily quota status — the form polls this on init (with its browser id
  // as `clientId`) so it can show "X of 5 playlists left today" under the
  // char counter. The fuller of the two counters is what is left.
  fastify.get('/ai-playlist/rate-limit-status', async (request: any, reply: any) => {
    const ip = utils.getClientIp(request);
    const exempt = isDev() || utils.isTrustedIp(ip);
    if (exempt) {
      return reply.send({
        success: true,
        data: {
          enforced: false,
          used: 0,
          limit: DAILY_LIMIT,
          remaining: DAILY_LIMIT,
        },
      });
    }
    let used = 0;
    try {
      for (const key of dailyKeys(ip, parseClientId(request.query?.clientId))) {
        const count = parseInt((await cache.executeCommand('get', key)) || '0', 10);
        used = Math.max(used, count);
      }
    } catch {
      used = 0;
    }
    return reply.send({
      success: true,
      data: {
        enforced: true,
        used,
        limit: DAILY_LIMIT,
        remaining: Math.max(0, DAILY_LIMIT - used),
      },
    });
  });

  // Resume endpoint — the frontend ai-progress page hits this on init so
  // a page reload during generation can replay the current snapshot
  // before subscribing to incremental WS updates.
  fastify.get('/ai-playlist/progress/:jobId', async (request: any, reply: any) => {
    const jobId = String(request.params?.jobId || '');
    if (!jobId) {
      return reply.status(400).send({ success: false, error: 'Missing jobId' });
    }
    const snapshot = await generator.getSnapshot(jobId);
    if (!snapshot) {
      return reply.status(404).send({ success: false, error: 'Unknown jobId' });
    }
    return reply.send({ success: true, data: snapshot });
  });
}
