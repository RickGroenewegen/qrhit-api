import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import AIPlaylistGenerator from '../aiPlaylist';
import Logger from '../logger';
import Utils from '../utils';
import Cache from '../cache';
import { color, white } from 'console-log-colors';

const MIN_TRACKS = 25;
const MAX_TRACKS = 500;
const MAX_PROMPT_LEN = 250;
const DAILY_LIMIT_PER_IP = 25;

function isDev(): boolean {
  return process.env['ENVIRONMENT'] === 'development';
}

function dailyKeyForIp(ip: string): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(
    2,
    '0'
  )}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `aiPlaylist:rate:${ip}:${ymd}`;
}

export default async function aiPlaylistRoutes(fastify: FastifyInstance) {
  const generator = AIPlaylistGenerator.getInstance();
  const logger = new Logger();
  const utils = new Utils();
  const cache = Cache.getInstance();

  fastify.post('/ai-playlist/generate', async (request: any, reply: any) => {
    const body = (request.body || {}) as {
      prompt?: unknown;
      trackCount?: unknown;
      captchaToken?: unknown;
      locale?: unknown;
    };
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const trackCount =
      typeof body.trackCount === 'number'
        ? Math.floor(body.trackCount)
        : Number.parseInt(String(body.trackCount), 10);
    const captchaToken =
      typeof body.captchaToken === 'string' ? body.captchaToken : '';
    const locale =
      typeof body.locale === 'string' && /^[a-z]{2}$/i.test(body.locale)
        ? body.locale.toLowerCase()
        : 'en';

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

    // Per-IP daily generation limit. Bypassed in development and for
    // TRUSTED_IPS so local testing / office IPs aren't capped. Bumps the
    // counter atomically with INCR; if it lands over the limit we DECR
    // it back so the rejected attempt doesn't count.
    const ip = utils.getClientIp(request);
    const rateLimitExempt = isDev() || utils.isTrustedIp(ip);
    if (!rateLimitExempt) {
      const key = dailyKeyForIp(ip);
      try {
        const used = parseInt(await cache.executeCommand('incr', key), 10);
        if (used === 1) {
          await cache.executeCommand('expire', key, 24 * 3600);
        }
        if (used > DAILY_LIMIT_PER_IP) {
          await cache.executeCommand('decr', key);
          return reply.status(429).send({
            success: false,
            error: 'Daily AI generation limit reached',
            data: { used: DAILY_LIMIT_PER_IP, limit: DAILY_LIMIT_PER_IP, remaining: 0 },
          });
        }
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

    // Compute remaining for the response so the form can update its
    // counter without a follow-up GET.
    let remaining: number | null = null;
    if (!rateLimitExempt) {
      try {
        const used = parseInt(
          (await cache.executeCommand('get', dailyKeyForIp(ip))) || '0',
          10
        );
        remaining = Math.max(0, DAILY_LIMIT_PER_IP - used);
      } catch {
        remaining = null;
      }
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
          : { remaining, limit: DAILY_LIMIT_PER_IP, enforced: true },
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

  // Per-IP daily quota status — the form polls this on init so it can
  // show "X of 25 daily generations used" under the char counter.
  fastify.get('/ai-playlist/rate-limit-status', async (request: any, reply: any) => {
    const ip = utils.getClientIp(request);
    const exempt = isDev() || utils.isTrustedIp(ip);
    if (exempt) {
      return reply.send({
        success: true,
        data: {
          enforced: false,
          used: 0,
          limit: DAILY_LIMIT_PER_IP,
          remaining: DAILY_LIMIT_PER_IP,
        },
      });
    }
    let used = 0;
    try {
      used = parseInt(
        (await cache.executeCommand('get', dailyKeyForIp(ip))) || '0',
        10
      );
    } catch {
      used = 0;
    }
    return reply.send({
      success: true,
      data: {
        enforced: true,
        used,
        limit: DAILY_LIMIT_PER_IP,
        remaining: Math.max(0, DAILY_LIMIT_PER_IP - used),
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
