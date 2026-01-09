import { FastifyInstance } from 'fastify';
import { YouTubeMusicProvider } from '../providers';
import Utils from '../utils';
import TrackEnrichment from '../trackEnrichment';

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
    const { playlistId, url, cache } = request.body;

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

    const result = await ytMusicProvider.getTracks(resolvedPlaylistId, utils.parseBoolean(cache));

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
