import { FastifyInstance } from 'fastify';
import { color } from 'console-log-colors';
import FeaturedCopies from '../featuredCopy';
import Logger from '../logger';
import Utils from '../utils';
import Cache from '../cache';

// "Change the songs" copies per IP per hour.
const COPIES_PER_HOUR = 10;

/**
 * "Change the songs" on a product page: a temporary copy of the featured
 * playlist in our Spotify account, unfollowed after 5 minutes (see
 * featuredCopy.ts). Each call writes to the Spotify account the AI playlists
 * and Excel imports use too, hence the captcha and the limit.
 */
export default async function featuredCopyRoutes(fastify: FastifyInstance) {
  const logger = new Logger();
  const utils = new Utils();
  const cache = Cache.getInstance();
  // Starts the cleanup cron of the temporary copies.
  const featuredCopies = FeaturedCopies.getInstance();

  fastify.post('/featured/copy', async (request: any, reply: any) => {
    const body = (request.body || {}) as { slug?: unknown; captchaToken?: unknown };
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    const captchaToken = typeof body.captchaToken === 'string' ? body.captchaToken : '';
    if (!slug || slug.length > 200) {
      return reply.status(400).send({ success: false, error: 'slug is required' });
    }
    if (!captchaToken) {
      return reply.status(400).send({ success: false, error: 'reCAPTCHA verification failed' });
    }
    const { isHuman } = await utils.verifyRecaptcha(captchaToken);
    if (!isHuman) {
      return reply.status(400).send({ success: false, error: 'reCAPTCHA verification failed' });
    }

    const ip = utils.getClientIp(request);
    const exempt = process.env['ENVIRONMENT'] === 'development' || utils.isTrustedIp(ip);
    if (!exempt) {
      try {
        const used = await cache.increment(`featuredCopy:rate:${ip}`, 3600);
        if (used > COPIES_PER_HOUR) {
          return reply.status(429).send({ success: false, error: 'Too many copies, try again later' });
        }
      } catch (err) {
        logger.log(color.yellow.bold(`[Featured copy] rate-limit check failed (allowing through): ${err}`));
      }
    }

    const result = await featuredCopies.createCopy(slug);
    if (!result.success) {
      const status = result.reason === 'spotify' ? 502 : 404;
      return reply.status(status).send({ success: false, error: result.error, reason: result.reason });
    }
    return { success: true, data: result.data };
  });
}
