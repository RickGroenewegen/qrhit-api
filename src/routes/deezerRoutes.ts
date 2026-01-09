import { FastifyInstance } from 'fastify';
import { DeezerProvider } from '../providers';
import Utils from '../utils';
import TrackEnrichment from '../trackEnrichment';
import ProgressWebSocketServer from '../progress-websocket';
import { ServiceType } from '../enums/ServiceType';

export default async function deezerRoutes(fastify: FastifyInstance) {
  const deezerProvider = DeezerProvider.getInstance();
  const utils = new Utils();
  const trackEnrichment = TrackEnrichment.getInstance();

  // Helper to resolve Deezer URL (handles shortlinks)
  async function resolveDeezerUrl(url: string): Promise<{ playlistId: string | null; error?: string }> {
    // First try to extract directly
    let playlistId = deezerProvider.extractPlaylistId(url);
    if (playlistId) {
      return { playlistId };
    }

    // Check if it's a shortlink that needs resolution
    const validation = deezerProvider.validateUrl(url);
    if (validation.isValid && validation.isServiceUrl && !validation.resourceId) {
      // It's a shortlink, resolve it
      const resolved = await deezerProvider.resolveShortlink(url);
      if (resolved.success && resolved.data?.resolvedUrl) {
        playlistId = deezerProvider.extractPlaylistId(resolved.data.resolvedUrl);
        if (playlistId) {
          return { playlistId };
        }
      }
      return { playlistId: null, error: resolved.error || 'Could not resolve shortlink' };
    }

    return { playlistId: null, error: 'Could not extract playlist ID from URL' };
  }

  // Resolve Deezer shortlink
  fastify.post('/deezer/resolve-shortlink', async (request: any, reply) => {
    const { url } = request.body;

    if (!url) {
      return { success: false, error: 'Missing url parameter' };
    }

    return await deezerProvider.resolveShortlink(url);
  });

  // Get Deezer playlist info
  fastify.post('/deezer/playlists', async (request: any, reply) => {
    const { playlistId, url, cache } = request.body;

    let resolvedPlaylistId = playlistId;

    // If URL is provided instead of playlistId, extract/resolve the ID
    if (!resolvedPlaylistId && url) {
      const resolved = await resolveDeezerUrl(url);
      if (!resolved.playlistId) {
        return {
          success: false,
          error: resolved.error || 'Could not extract playlist ID from URL',
        };
      }
      resolvedPlaylistId = resolved.playlistId;
    }

    if (!resolvedPlaylistId) {
      return {
        success: false,
        error: 'Missing playlistId or url parameter',
      };
    }

    const result = await deezerProvider.getPlaylist(resolvedPlaylistId, utils.parseBoolean(cache));
    return result;
  });

  // Get Deezer playlist tracks
  fastify.post('/deezer/playlists/tracks', async (request: any, reply) => {
    const { playlistId, url, cache, requestId } = request.body;

    let resolvedPlaylistId = playlistId;

    if (!resolvedPlaylistId && url) {
      const resolved = await resolveDeezerUrl(url);
      if (!resolved.playlistId) {
        return {
          success: false,
          error: resolved.error || 'Could not extract playlist ID from URL',
        };
      }
      resolvedPlaylistId = resolved.playlistId;
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
          progressWs.broadcastProgress(resolvedPlaylistId, ServiceType.DEEZER, requestId, {
            stage: progress.stage as 'fetching_ids' | 'fetching_metadata',
            percentage: progress.percentage,
            message: progress.message,
            current: progress.current,
            total: progress.total ?? undefined,
          });
        }
      : undefined;

    const result = await deezerProvider.getTracks(resolvedPlaylistId, utils.parseBoolean(cache), undefined, onProgress);

    // Broadcast completion or error (only if requestId provided)
    if (progressWs && requestId) {
      if (result.success && result.data) {
        progressWs.broadcastComplete(resolvedPlaylistId, ServiceType.DEEZER, requestId, {
          trackCount: result.data.tracks.length,
        });
      } else {
        progressWs.broadcastError(resolvedPlaylistId, ServiceType.DEEZER, requestId, result.error);
      }
    }

    // Enrich tracks with additional data from database
    if (result.success && result.data?.tracks) {
      result.data.tracks = trackEnrichment.enrichTracksByArtistTitle(result.data.tracks);
    }

    return result;
  });
}
