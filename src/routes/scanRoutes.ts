import { FastifyInstance } from 'fastify';
import Cache from '../cache';
import Utils from '../utils';
import ScanPreview from '../scanPreview';

// A scan asks once per card; a party with a few phones on one connection
// stays far below this. Over it the caller just gets no preview for a minute:
// no ban, because this route gives away nothing a card does not already hold.
const PREVIEW_RATE_MAX = 60;
const PREVIEW_RATE_WINDOW_SECONDS = 60;

export default async function scanRoutes(fastify: FastifyInstance) {
  const cache = Cache.getInstance();
  const utils = new Utils();
  const scanPreview = ScanPreview.getInstance();

  // The 30-second preview for a scanned card, used by the site's web scanner.
  // Body: { links: { link?, am?, dz? }, prefer?: 'spotify' | 'apple_music' | 'deezer' | ... }
  // The links are the ones /qrlink2, /qrlink or /qrlink_unknown returned for
  // the card (or the card's own link), so nothing here counts as a play.
  fastify.post('/scan/preview', async (request: any, reply) => {
    const ip = utils.resolveTrustedClientIp(request);
    try {
      const count = await cache.increment(`scan_preview_rl:${ip}`, PREVIEW_RATE_WINDOW_SECONDS);
      if (count > PREVIEW_RATE_MAX) {
        reply.status(429);
        return { success: false, error: 'rate_limited' };
      }
    } catch {
      // Redis down: let the lookup through rather than break playback
    }

    const { links, prefer } = request.body || {};
    if (!links || typeof links !== 'object') {
      reply.status(400);
      return { success: false, error: 'missing_links' };
    }

    const result = await scanPreview.resolve(
      {
        link: typeof links.link === 'string' ? links.link : null,
        am: typeof links.am === 'string' ? links.am : null,
        dz: typeof links.dz === 'string' ? links.dz : null,
      },
      typeof prefer === 'string' ? prefer : null
    );
    if (!result) return { success: false, error: 'no_preview' };
    return { success: true, url: result.url, source: result.source };
  });
}
