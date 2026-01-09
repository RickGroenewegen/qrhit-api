import { FastifyInstance } from 'fastify';
import { AppleMusicProvider } from '../providers';
import Utils from '../utils';
import TrackEnrichment from '../trackEnrichment';

export default async function appleMusicRoutes(fastify: FastifyInstance) {
  const appleMusicProvider = AppleMusicProvider.getInstance();
  const utils = new Utils();
  const trackEnrichment = TrackEnrichment.getInstance();

  // Resolve Apple Music shortlink
  fastify.post('/apple-music/resolve-shortlink', async (request: any, reply) => {
    const { url } = request.body;

    if (!url) {
      return { success: false, error: 'Missing url parameter' };
    }

    return await appleMusicProvider.resolveShortlink(url);
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

    const result = await appleMusicProvider.getPlaylist(resolvedPlaylistId, 'us', utils.parseBoolean(cache));
    return result;
  });

  // Get Apple Music playlist tracks
  fastify.post('/apple-music/playlists/tracks', async (request: any, reply) => {
    const { playlistId, url, cache } = request.body;

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

    const result = await appleMusicProvider.getTracks(resolvedPlaylistId, 'us', utils.parseBoolean(cache));

    // Enrich tracks with additional data from database
    if (result.success && result.data?.tracks) {
      result.data.tracks = trackEnrichment.enrichTracksByArtistTitle(result.data.tracks);
    }

    return result;
  });
}
