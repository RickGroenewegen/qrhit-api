import { FastifyInstance } from 'fastify';
import { color } from 'console-log-colors';
import { TidalProvider } from '../providers';
import Logger from '../logger';
import Utils from '../utils';
import TrackEnrichment from '../trackEnrichment';
import ProgressWebSocketServer from '../progress-websocket';
import { ServiceType } from '../enums/ServiceType';

export default async function tidalRoutes(fastify: FastifyInstance) {
  const tidalProvider = TidalProvider.getInstance();
  const logger = new Logger();
  const utils = new Utils();
  const trackEnrichment = TrackEnrichment.getInstance();

  // Get Tidal OAuth authorization URL
  fastify.get('/tidal/auth', async (_request, reply) => {
    const authUrl = tidalProvider.getAuthorizationUrl();
    if (authUrl) {
      return { success: true, authUrl };
    }
    return { success: false, error: 'Failed to generate authorization URL' };
  });

  // Check Tidal connection status
  fastify.get('/tidal/status', async (_request, reply) => {
    const connected = await tidalProvider.isConnected();
    return { success: true, connected };
  });

  // Handle Tidal OAuth callback
  fastify.post('/tidal/callback', async (request: any, reply) => {
    const { code } = request.body;

    if (!code) {
      return { success: false, error: 'Missing authorization code' };
    }

    const result = await tidalProvider.handleAuthCallback(code);

    if (result.success) {
      logger.log(
        color.green.bold('Tidal authorization successful. Token stored.')
      );
      return { success: true, message: 'Tidal authorization successful' };
    }

    logger.log(
      color.red.bold(`Tidal authorization failed: ${result.error}`)
    );
    return { success: false, error: result.error };
  });

  // Tidal OAuth callback (GET - for direct browser redirects)
  fastify.get('/tidal/callback', async (request: any, reply) => {
    const { code, error, error_description } = request.query;

    if (error) {
      logger.log(
        color.red.bold(`Tidal authorization error: ${error} - ${error_description}`)
      );
      reply.type('text/html').send(`
        <html>
          <head><title>Tidal Authorization Failed</title></head>
          <body>
            <h1>Authorization Failed</h1>
            <p>${error_description || error}</p>
          </body>
        </html>
      `);
      return;
    }

    if (!code) {
      reply.type('text/html').send(`
        <html>
          <head><title>Tidal Authorization Failed</title></head>
          <body>
            <h1>Authorization Failed</h1>
            <p>No authorization code was received from Tidal.</p>
          </body>
        </html>
      `);
      return;
    }

    const result = await tidalProvider.handleAuthCallback(code);

    if (result.success) {
      logger.log(
        color.green.bold('Tidal authorization successful via callback. Token stored.')
      );
      reply.type('text/html').send(`
        <html>
          <head><title>Tidal Authorization Complete</title></head>
          <body>
            <h1>Authorization Complete</h1>
            <p>Your Tidal account has been successfully linked.</p>
            <script>window.close();</script>
          </body>
        </html>
      `);
    } else {
      logger.log(
        color.red.bold(`Tidal callback auth failed: ${result.error}`)
      );
      reply.type('text/html').send(`
        <html>
          <head><title>Tidal Authorization Error</title></head>
          <body>
            <h1>Authorization Error</h1>
            <p>There was an error completing the Tidal authorization: ${result.error}</p>
          </body>
        </html>
      `);
    }
  });

  // Disconnect Tidal (clear tokens)
  fastify.post('/tidal/disconnect', async (_request, reply) => {
    await tidalProvider.disconnect();
    logger.log(color.yellow.bold('Tidal account disconnected'));
    return { success: true, message: 'Tidal account disconnected' };
  });

  // Get Tidal playlist info
  fastify.post('/tidal/playlists', async (request: any, reply) => {
    const { playlistId, url, cache } = request.body;

    let resolvedPlaylistId = playlistId;

    // If URL is provided instead of playlistId, extract the ID
    if (!resolvedPlaylistId && url) {
      resolvedPlaylistId = tidalProvider.extractPlaylistId(url);
      if (!resolvedPlaylistId) {
        return {
          success: false,
          error: 'Could not extract playlist ID from URL',
        };
      }
    }

    if (!resolvedPlaylistId) {
      return {
        success: false,
        error: 'Missing playlistId or url parameter',
      };
    }

    const result = await tidalProvider.getPlaylist(resolvedPlaylistId, utils.parseBoolean(cache));
    return result;
  });

  // Get Tidal playlist tracks
  fastify.post('/tidal/playlists/tracks', async (request: any, reply) => {
    const { playlistId, url, cache, limit, requestId } = request.body;

    let resolvedPlaylistId = playlistId;

    if (!resolvedPlaylistId && url) {
      resolvedPlaylistId = tidalProvider.extractPlaylistId(url);
      if (!resolvedPlaylistId) {
        return {
          success: false,
          error: 'Could not extract playlist ID from URL',
        };
      }
    }

    if (!resolvedPlaylistId) {
      return {
        success: false,
        error: 'Missing playlistId or url parameter',
      };
    }

    // Get WebSocket server for progress broadcasting
    const progressWs = ProgressWebSocketServer.getInstance();

    // Create progress callback that broadcasts to WebSocket (only if requestId provided)
    const onProgress = progressWs && requestId
      ? (progress: { stage: string; current: number; total: number | null; percentage: number; message?: string }) => {
          progressWs.broadcastProgress(resolvedPlaylistId, ServiceType.TIDAL, requestId, {
            stage: progress.stage as 'fetching_ids' | 'fetching_metadata',
            percentage: progress.percentage,
            message: progress.message,
            current: progress.current,
            total: progress.total ?? undefined,
          });
        }
      : undefined;

    const result = await tidalProvider.getTracks(resolvedPlaylistId, utils.parseBoolean(cache), limit, onProgress);

    // Broadcast completion or error (only if requestId provided)
    if (progressWs && requestId) {
      if (result.success && result.data) {
        progressWs.broadcastComplete(resolvedPlaylistId, ServiceType.TIDAL, requestId, {
          trackCount: result.data.tracks.length,
        });
      } else {
        progressWs.broadcastError(resolvedPlaylistId, ServiceType.TIDAL, requestId, result.error);
      }
    }

    // Tidal provides release dates, but we can still enrich with additional data
    if (result.success && result.data?.tracks) {
      result.data.tracks = trackEnrichment.enrichTracksByArtistTitle(result.data.tracks);
    }

    return result;
  });
}
