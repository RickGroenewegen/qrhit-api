import { FastifyInstance } from 'fastify';
import { AppleMusicProvider } from '../providers';
import Utils from '../utils';
import TrackEnrichment from '../trackEnrichment';
import ProgressWebSocketServer from '../progress-websocket';
import { ServiceType } from '../enums/ServiceType';
import Cache from '../cache';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';

const APPLE_MUSIC_TOKEN_CACHE_KEY = 'apple_music_developer_token';
const APPLE_MUSIC_TOKEN_CACHE_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const APPLE_MUSIC_TOKEN_EXPIRY = 180 * 24 * 60 * 60; // 180 days in seconds (max allowed by Apple)

export default async function appleMusicRoutes(fastify: FastifyInstance) {
  const appleMusicProvider = AppleMusicProvider.getInstance();
  const utils = new Utils();
  const trackEnrichment = TrackEnrichment.getInstance();
  const cache = Cache.getInstance();

  // Get or generate Apple Music developer token (cached in Redis for 30 days)
  fastify.get('/apple-music/token', async (request: any, reply) => {
    // Check Redis cache first
    const cached = await cache.get(APPLE_MUSIC_TOKEN_CACHE_KEY);
    if (cached) {
      return { token: cached };
    }

    // Generate a new JWT
    const keyPath = path.join(process.env['APP_ROOT'] || '', '..', 'apple_music.p8');
    if (!fs.existsSync(keyPath)) {
      reply.status(500);
      return { error: 'Apple Music key not configured' };
    }

    const privateKey = fs.readFileSync(keyPath, 'utf8');

    const teamId = process.env['APPLE_MUSIC_TEAM_ID'];
    const keyId = process.env['APPLE_MUSIC_KEY_ID'];

    if (!teamId || !keyId) {
      reply.status(500);
      return { error: 'Apple Music Team ID or Key ID not configured' };
    }

    const token = jwt.sign({}, privateKey, {
      algorithm: 'ES256',
      expiresIn: APPLE_MUSIC_TOKEN_EXPIRY,
      issuer: teamId,
      header: {
        alg: 'ES256',
        kid: keyId,
      },
    });

    // Cache in Redis for 30 days
    await cache.set(APPLE_MUSIC_TOKEN_CACHE_KEY, token, APPLE_MUSIC_TOKEN_CACHE_TTL);

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
