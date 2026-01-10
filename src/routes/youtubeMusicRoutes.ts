import { FastifyInstance } from 'fastify';
import { YouTubeMusicProvider } from '../providers';
import Utils from '../utils';
import TrackEnrichment from '../trackEnrichment';
import ProgressWebSocketServer from '../progress-websocket';
import { ServiceType } from '../enums/ServiceType';

export default async function youtubeMusicRoutes(fastify: FastifyInstance) {
  const ytMusicProvider = YouTubeMusicProvider.getInstance();
  const utils = new Utils();
  const trackEnrichment = TrackEnrichment.getInstance();

  // Get YouTube Music playlist info
  fastify.post('/youtube-music/playlists', async (request: any, reply) => {
    const { playlistId, url, cache } = request.body;

    let resolvedPlaylistId = playlistId;

    // If URL is provided instead of playlistId, extract the ID
    if (!resolvedPlaylistId && url) {
      resolvedPlaylistId = ytMusicProvider.extractPlaylistId(url);
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

    const result = await ytMusicProvider.getPlaylist(resolvedPlaylistId, utils.parseBoolean(cache));
    return result;
  });

  // Get YouTube Music playlist tracks
  fastify.post('/youtube-music/playlists/tracks', async (request: any, reply) => {
    const { playlistId, url, cache, requestId } = request.body;

    let resolvedPlaylistId = playlistId;

    if (!resolvedPlaylistId && url) {
      resolvedPlaylistId = ytMusicProvider.extractPlaylistId(url);
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
          progressWs.broadcastProgress(resolvedPlaylistId, ServiceType.YOUTUBE_MUSIC, requestId, {
            stage: progress.stage as 'fetching_ids' | 'fetching_metadata',
            percentage: progress.percentage,
            message: progress.message,
            current: progress.current,
            total: progress.total ?? undefined,
          });
        }
      : undefined;

    const result = await ytMusicProvider.getTracks(resolvedPlaylistId, utils.parseBoolean(cache), undefined, onProgress);

    // Broadcast completion or error (only if requestId provided)
    if (progressWs && requestId) {
      if (result.success && result.data) {
        progressWs.broadcastComplete(resolvedPlaylistId, ServiceType.YOUTUBE_MUSIC, requestId, {
          trackCount: result.data.tracks.length,
        });
      } else {
        progressWs.broadcastError(resolvedPlaylistId, ServiceType.YOUTUBE_MUSIC, requestId, result.error);
      }
    }

    // Enrich tracks with year data from the database using artist+title matching
    if (result.success && result.data?.tracks) {
      result.data.tracks = trackEnrichment.enrichTracksByArtistTitle(result.data.tracks);
    }

    return result;
  });

  // Search YouTube Music tracks
  fastify.post('/youtube-music/search', async (request: any, reply) => {
    const { query, limit = 20, offset = 0 } = request.body;

    if (!query) {
      return {
        success: false,
        error: 'Missing query parameter',
      };
    }

    const result = await ytMusicProvider.searchTracks(query, limit, offset);
    return result;
  });
}
