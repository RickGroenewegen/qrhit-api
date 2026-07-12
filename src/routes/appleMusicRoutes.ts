import { FastifyInstance } from 'fastify';
import { AppleMusicProvider } from '../providers';
import Utils from '../utils';
import TrackEnrichment from '../trackEnrichment';
import ProgressWebSocketServer from '../progress-websocket';
import { ServiceType } from '../enums/ServiceType';

export default async function appleMusicRoutes(fastify: FastifyInstance) {
  const appleMusicProvider = AppleMusicProvider.getInstance();
  const utils = new Utils();
  const trackEnrichment = TrackEnrichment.getInstance();

  // Get or generate the Apple Music developer token.
  // Generation + Redis caching live in AppleMusicProvider so the frontend
  // MusicKit token and the server-side API calls always share one valid token.
  fastify.get('/apple-music/token', async (request: any, reply) => {
    const token = await appleMusicProvider.getDeveloperToken();
    if (!token) {
      reply.status(500);
      return { error: 'Apple Music token not configured' };
    }
    return { token };
  });

  // Resolve Apple Music shortlink
  fastify.post('/apple-music/resolve-shortlink', async (request: any, reply) => {
    const { url } = request.body;

    if (!url) {
      return { success: false, error: 'Missing url parameter' };
    }

    return await appleMusicProvider.resolveShortlink(url);
  });

  // Resolve an Apple Music song URL to the user's storefront.
  // Body: { url: string, storefront: string }  storefront is the user's ISO country code (e.g. "us", "nl")
  fastify.post('/apple-music/resolve-storefront', async (request: any, reply) => {
    const { url, storefront } = request.body || {};

    if (!url || !storefront) {
      return { success: false, error: 'Missing url or storefront parameter' };
    }

    const resolvedUrl = await appleMusicProvider.resolveSongToStorefront(
      url,
      storefront.toLowerCase()
    );

    return { success: true, data: { url: resolvedUrl } };
  });

  // Get Apple Music playlist info
  fastify.post('/apple-music/playlists', async (request: any, reply) => {
    const { playlistId, url, cache } = request.body;

    let resolvedPlaylistId = playlistId;

    // If URL is provided instead of playlistId, extract the ID
    if (!resolvedPlaylistId && url) {
      // Check for shortlinks first
      const validation = appleMusicProvider.validateUrl(url);
      if (validation.isValid && !validation.resourceId) {
        // It's a shortlink, resolve it
        const resolved = await appleMusicProvider.resolveShortlink(url);
        if (resolved.success && resolved.data?.resolvedUrl) {
          resolvedPlaylistId = appleMusicProvider.extractPlaylistId(resolved.data.resolvedUrl);
        }
      } else {
        resolvedPlaylistId = appleMusicProvider.extractPlaylistId(url);
      }

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

    const storefront = appleMusicProvider.getStorefrontForLocale(request.body.locale);
    const result = await appleMusicProvider.getPlaylist(resolvedPlaylistId, storefront, utils.parseBoolean(cache));
    return result;
  });

  // Get Apple Music playlist tracks
  fastify.post('/apple-music/playlists/tracks', async (request: any, reply) => {
    const { playlistId, url, cache, requestId } = request.body;

    let resolvedPlaylistId = playlistId;

    if (!resolvedPlaylistId && url) {
      // Check for shortlinks first
      const validation = appleMusicProvider.validateUrl(url);
      if (validation.isValid && !validation.resourceId) {
        // It's a shortlink, resolve it
        const resolved = await appleMusicProvider.resolveShortlink(url);
        if (resolved.success && resolved.data?.resolvedUrl) {
          resolvedPlaylistId = appleMusicProvider.extractPlaylistId(resolved.data.resolvedUrl);
        }
      } else {
        resolvedPlaylistId = appleMusicProvider.extractPlaylistId(url);
      }

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
          progressWs.broadcastProgress(resolvedPlaylistId, ServiceType.APPLE_MUSIC, requestId, {
            stage: progress.stage as 'fetching_ids' | 'fetching_metadata',
            percentage: progress.percentage,
            message: progress.message,
            current: progress.current,
            total: progress.total ?? undefined,
          });
        }
      : undefined;

    const storefront = appleMusicProvider.getStorefrontForLocale(request.body.locale);
    const result = await appleMusicProvider.getTracks(resolvedPlaylistId, utils.parseBoolean(cache), undefined, onProgress, storefront);

    // Broadcast completion or error (only if requestId provided)
    if (progressWs && requestId) {
      if (result.success && result.data) {
        progressWs.broadcastComplete(resolvedPlaylistId, ServiceType.APPLE_MUSIC, requestId, {
          trackCount: result.data.tracks.length,
        });
      } else {
        progressWs.broadcastError(resolvedPlaylistId, ServiceType.APPLE_MUSIC, requestId, result.error);
      }
    }

    // Enrich tracks with additional data from database
    if (result.success && result.data?.tracks) {
      result.data.tracks = trackEnrichment.enrichTracksByArtistTitle(result.data.tracks);
    }

    return result;
  });
}
