import { FastifyInstance } from 'fastify';
import FeaturedLinkCheck from '../linkCheck';

/**
 * The featured link check's admin side (src/linkCheck). The Featured page
 * reads `linkBroken`, `linkBrokenAt` and `linkCheckedAt` from
 * POST /admin/featured/search.
 */
export default async function linkCheckRoutes(fastify: FastifyInstance, getAuthHandler: any) {
  /**
   * POST /admin/featured/:playlistId/link-broken/reset (no body)
   * Undoes a playlist's `linkBroken` and forgets its first "gone" night, so
   * the check needs two new nights in a row before it marks it again.
   * `:playlistId` is the service's playlist id (`playlists.playlistId`), as
   * in the other /admin/featured/:playlistId routes.
   * 200 { success: true, linkBroken, linkBrokenAt, linkCheckedAt }
   * 404 { success: false, error: 'Playlist not found' }
   */
  fastify.post(
    '/admin/featured/:playlistId/link-broken/reset',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      const playlistId = String(request.params.playlistId || '');
      if (!playlistId) {
        return reply.status(400).send({ success: false, error: 'Playlist ID is required' });
      }
      try {
        const state = await FeaturedLinkCheck.getInstance().resetLinkBroken(playlistId);
        if (!state) {
          return reply.status(404).send({ success: false, error: 'Playlist not found' });
        }
        return { success: true, ...state };
      } catch (error: any) {
        return reply.status(500).send({ success: false, error: error?.message || 'Reset failed' });
      }
    }
  );
}
