import { FastifyInstance } from 'fastify';
import Spotify from '../spotify';
import Data from '../data';
import Utils from '../utils';
import ProgressWebSocketServer from '../progress-websocket';
import { ServiceType } from '../enums/ServiceType';

export default async function spotifyRoutes(fastify: FastifyInstance) {
  const spotify = Spotify.getInstance();
  const data = Data.getInstance();
  const utils = new Utils();

  /**
   * The product page (`/:lang/product/:slug`) loads its playlist and tracks
   * here with `slug: 1`, for every service. A slug whose playlist is not
   * featured, or whose source is gone (`linkBroken`, src/linkCheck), answers
   * `playlistNotFound` like an unknown slug, whatever the playlist caches
   * still hold: the same answer as GET /product-page/:slug, from the same
   * short cache, which the link check drops when a flag changes. A failing
   * lookup lets the request through: the check never takes a page down.
   */
  const productPageGone = async (body: any): Promise<boolean> => {
    if (!utils.parseBoolean(body?.slug) || !body?.playlistId) return false;
    try {
      return !(await data.getProductPageLocale(String(body.playlistId))).exists;
    } catch {
      return false;
    }
  };

  // Get Spotify playlist tracks
  fastify.post('/spotify/playlists/tracks', async (request: any, _reply) => {
    if (await productPageGone(request.body)) {
      return { success: false, error: 'playlistNotFound' };
    }
    const userAgent = request.headers['user-agent'] || '';
    const { playlistId, requestId } = request.body;

    // Get WebSocket server for progress broadcasting (must be inside handler, not at module level)
    const progressWs = ProgressWebSocketServer.getInstance();

    // Set up progress callback if requestId is provided
    const onProgress = progressWs && requestId
      ? (progress: any) => {
          progressWs.broadcastProgress(playlistId, ServiceType.SPOTIFY, requestId, {
            stage: progress.stage,
            percentage: progress.percentage,
            message: progress.message,
            current: progress.current,
            total: progress.total,
          });
        }
      : undefined;

    const result = await spotify.getTracks(
      playlistId,
      utils.parseBoolean(request.body.cache),
      request.body.captchaToken,
      true,
      utils.parseBoolean(request.body.slug),
      request.clientIp,
      userAgent,
      onProgress,
      utils.parseBoolean(request.body.allowDuplicates)
    );

    // Broadcast completion if requestId provided
    if (progressWs && requestId && result.success) {
      progressWs.broadcastComplete(playlistId, ServiceType.SPOTIFY, requestId, {
        trackCount: result.data?.totalTracks || result.data?.tracks?.length || 0,
      });
    }

    return result;
  });

  // Get Spotify playlist info
  fastify.post('/spotify/playlists', async (request: any, _reply) => {
    if (await productPageGone(request.body)) {
      return { success: false, error: 'playlistNotFound' };
    }
    const userAgent = request.headers['user-agent'] || '';
    return await spotify.getPlaylist(
      request.body.playlistId,
      utils.parseBoolean(request.body.cache),
      request.body.captchaToken,
      true,
      utils.parseBoolean(request.body.featured),
      utils.parseBoolean(request.body.slug),
      request.body.locale,
      request.clientIp,
      userAgent
    );
  });
}
