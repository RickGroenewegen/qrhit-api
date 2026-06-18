import { FastifyInstance } from 'fastify';
import Spotify from '../spotify';
import Utils from '../utils';
import ProgressWebSocketServer from '../progress-websocket';
import { ServiceType } from '../enums/ServiceType';

export default async function spotifyRoutes(fastify: FastifyInstance) {
  const spotify = Spotify.getInstance();
  const utils = new Utils();

  // Get Spotify authorization URL (returns the URL so a caller/admin can start re-auth)
  fastify.get('/spotify/auth-url', async (_request, reply) => {
    const authUrl = spotify.getAuthorizationUrl();
    if (!authUrl) {
      reply.send({ success: false, error: 'Missing Spotify Client ID' });
      return;
    }
    reply.send({ success: true, authUrl });
  });

  // One-click re-authorization: redirect the browser straight to Spotify's login.
  // After login Spotify redirects to GET /spotify_callback, which stores the new
  // access + refresh token. Use this to manually mint a fresh refresh token (e.g.
  // after the previous one expires under Spotify's 6-month limit).
  fastify.get('/spotify/login', async (_request, reply) => {
    const authUrl = spotify.getAuthorizationUrl();
    if (!authUrl) {
      reply
        .code(500)
        .type('text/html')
        .send('<html><body><h1>Spotify login unavailable</h1><p>Missing Spotify Client ID.</p></body></html>');
      return;
    }
    reply.redirect(authUrl);
  });

  // Get Spotify playlist tracks
  fastify.post('/spotify/playlists/tracks', async (request: any, _reply) => {
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
      onProgress
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
