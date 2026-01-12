import { FastifyInstance } from 'fastify';
import Spotify from '../spotify';
import Data from '../data';
import Hitlist from '../hitlist';
import Top40 from '../top40';
import { color } from 'console-log-colors';
import Logger from '../logger';
import Utils from '../utils';
import Translation from '../translation';
import MusicServiceRegistry from '../services/MusicServiceRegistry';
import TrackEnrichment from '../trackEnrichment';

// Import service-specific routes
import spotifyRoutes from './spotifyRoutes';
import youtubeMusicRoutes from './youtubeMusicRoutes';
import tidalRoutes from './tidalRoutes';
import deezerRoutes from './deezerRoutes';
import appleMusicRoutes from './appleMusicRoutes';

export default async function musicRoutes(fastify: FastifyInstance) {
  const spotify = Spotify.getInstance();
  const data = Data.getInstance();
  const hitlist = Hitlist.getInstance();
  const logger = new Logger();
  const utils = new Utils();
  const translation = new Translation();
  const musicRegistry = MusicServiceRegistry.getInstance();
  const trackEnrichment = TrackEnrichment.getInstance();

  // Register service-specific routes
  await fastify.register(spotifyRoutes);
  await fastify.register(youtubeMusicRoutes);
  await fastify.register(tidalRoutes);
  await fastify.register(deezerRoutes);
  await fastify.register(appleMusicRoutes);

  // ============================================
  // Unified Music Service Routes (Auto-detect service from URL)
  // ============================================

  // Get playlist info from any supported service
  fastify.post('/music/playlists', async (request: any, reply) => {
    const { url, serviceType, playlistId } = request.body;

    // If URL is provided, auto-detect service
    if (url) {
      const result = await musicRegistry.getPlaylistFromUrl(url);
      return result;
    }

    // If serviceType and playlistId are provided, use specific provider
    if (serviceType && playlistId) {
      const provider = musicRegistry.getProviderByString(serviceType);
      if (!provider) {
        return {
          success: false,
          error: `Unsupported service type: ${serviceType}`,
        };
      }
      return await provider.getPlaylist(playlistId);
    }

    return {
      success: false,
      error: 'Missing url or (serviceType and playlistId) parameters',
    };
  });

  // Get tracks from any supported service
  fastify.post('/music/playlists/tracks', async (request: any, reply) => {
    const { url, serviceType, playlistId } = request.body;

    let result: any;

    // If URL is provided, auto-detect service
    if (url) {
      result = await musicRegistry.getTracksFromUrl(url);
    } else if (serviceType && playlistId) {
      // If serviceType and playlistId are provided, use specific provider
      const provider = musicRegistry.getProviderByString(serviceType);
      if (!provider) {
        return {
          success: false,
          error: `Unsupported service type: ${serviceType}`,
        };
      }
      result = await provider.getTracks(playlistId);
    } else {
      return {
        success: false,
        error: 'Missing url or (serviceType and playlistId) parameters',
      };
    }

    // Enrich tracks with year data from the database using artist+title matching
    if (result?.success && result.data?.tracks) {
      result.data.tracks = trackEnrichment.enrichTracksByArtistTitle(result.data.tracks);
    }

    return result;
  });

  // Recognize URL and return service info
  fastify.post('/music/recognize-url', async (request: any, reply) => {
    const { url } = request.body;

    if (!url) {
      return {
        success: false,
        error: 'Missing url parameter',
      };
    }

    const result = musicRegistry.recognizeUrl(url);

    if (!result.recognized) {
      return {
        success: false,
        error: 'URL not recognized as a supported music service',
      };
    }

    return {
      success: true,
      data: {
        serviceType: result.serviceType,
        playlistId: result.playlistId,
        isValid: result.validation?.isValid,
        resourceType: result.validation?.resourceType,
        errorType: result.validation?.errorType,
        serviceConfig: result.provider?.config,
      },
    };
  });

  // Get list of available music services
  fastify.get('/music/services', async (_request, reply) => {
    return {
      success: true,
      data: {
        services: musicRegistry.getAvailableServiceTypes(),
        configs: musicRegistry.getServiceConfigs(),
      },
    };
  });

  // ============================================
  // Shared/Legacy Routes
  // ============================================

  // Resolve Spotify shortlink by following redirects
  fastify.post('/resolve_shortlink', async (request: any, reply: any) => {
    const { url } = request.body;
    if (!url || typeof url !== 'string') {
      reply
        .status(400)
        .send({ success: false, error: 'Missing or invalid url parameter' });
      return;
    }

    try {
      const result = await spotify.resolveShortlink(url);

      if (result.success) {
        reply.send({ success: true, url: result.url });
      } else {
        reply.status(404).send({
          success: false,
          error: result.error || 'URL did not resolve to a Spotify playlist',
        });
      }
    } catch (e: any) {
      logger.log(
        `Error resolving shortlink: url="${url}", error=${e.message || e}`
      );
      reply
        .status(500)
        .send({ success: false, error: e.message || 'Internal error' });
    }
  });

  // Resolve unknown Spotify URL - returns all available music service links
  fastify.post('/qrlink_unknown', async (request: any, reply: any) => {
    const { url } = request.body;
    if (!url || typeof url !== 'string') {
      reply
        .status(400)
        .send({ success: false, error: 'Missing or invalid url parameter' });
      return;
    }
    try {
      const result = await spotify.resolveSpotifyUrl(url);

      // Log the unknown link scan, indicate if cached
      logger.log(
        color.blue.bold(
          `Unknown link scanned${result.cached ? ' (CACHED)' : ''}: ` +
            color.white.bold(`url="${url}"`) +
            color.blue.bold(', result=') +
            color.white.bold(
              JSON.stringify({
                success: result.success,
                spotifyUri: result.spotifyUri,
                error: result.error,
              })
            )
        )
      );
      if (result.success) {
        // Return all available music service links
        reply.send({
          success: true,
          spotifyUri: result.spotifyUri,
          link: result.links?.spotifyLink || null,
          am: result.links?.appleMusicLink || null,
          td: result.links?.tidalLink || null,
          ym: result.links?.youtubeMusicLink || null,
          dz: result.links?.deezerLink || null,
          az: result.links?.amazonMusicLink || null,
          r: true,
        });
      } else {
        reply.status(404).send({
          success: false,
          error: result.error || 'No Spotify URI found',
        });
      }
    } catch (e: any) {
      logger.log(
        `Error scanning unknown link: url="${url}", error=${e.message || e}`
      );
      reply
        .status(500)
        .send({ success: false, error: e.message || 'Internal error' });
    }
  });

  // Get featured playlists
  fastify.get('/featured/:locale', async (request: any, _reply) => {
    const playlists = await data.getFeaturedPlaylists(request.params.locale);
    return { success: true, data: playlists };
  });

  // Get link coverage for a playlist (by database ID)
  fastify.get('/playlist/:playlistId/link-coverage', async (request: any, reply) => {
    try {
      const playlistId = parseInt(request.params.playlistId, 10);
      if (isNaN(playlistId)) {
        return reply.status(400).send({ success: false, error: 'Invalid playlist ID' });
      }
      const coverage = await data.getPlaylistLinkCoverage(playlistId);
      return { success: true, data: coverage };
    } catch (e: any) {
      logger.log(`Error getting link coverage: ${e.message || e}`);
      return reply.status(500).send({ success: false, error: 'Failed to get link coverage' });
    }
  });

  // Get link coverage for a playlist by slug
  fastify.get('/playlist/slug/:slug/link-coverage', async (request: any, reply) => {
    try {
      const slug = request.params.slug;
      const playlist = await data.getPlaylistBySlug(slug);
      if (!playlist) {
        return reply.status(404).send({ success: false, error: 'Playlist not found' });
      }
      const coverage = await data.getPlaylistLinkCoverage(playlist.id);
      return { success: true, data: coverage };
    } catch (e: any) {
      logger.log(`Error getting link coverage by slug: ${e.message || e}`);
      return reply.status(500).send({ success: false, error: 'Failed to get link coverage' });
    }
  });

  // QR code routes
  fastify.get('/qr/:trackId', async (request: any, reply) => {
    const locale = utils.parseAcceptLanguage(
      request.headers['accept-language']
    );
    const translations = await translation.getTranslationsByPrefix(
      locale,
      'countdown'
    );
    let useVersion = '1.0.0'; // Default version
    if (process.env['ENVIRONMENT'] === 'development') {
      useVersion = new Date().getTime().toString();
    }
    await reply.view(`countdown.ejs`, {
      translations,
      version: useVersion,
      domain: process.env['FRONTEND_URI'],
    });
  });

  fastify.get('/qr2/:trackId/:php', async (request: any, reply) => {
    const locale = utils.parseAcceptLanguage(
      request.headers['accept-language']
    );
    const translations = await translation.getTranslationsByPrefix(
      locale,
      'countdown'
    );
    let useVersion = '1.0.0'; // Default version
    if (process.env['ENVIRONMENT'] === 'development') {
      useVersion = new Date().getTime().toString();
    }
    await reply.view(`countdown.ejs`, {
      translations,
      version: useVersion,
      domain: process.env['FRONTEND_URI'],
    });
  });

  fastify.get('/qrvibe/:trackId', async (request: any, reply) => {
    const locale = utils.parseAcceptLanguage(
      request.headers['accept-language']
    );
    const translations = await translation.getTranslationsByPrefix(
      locale,
      'countdown_onzevibe'
    );
    let useVersion = '1.0.0'; // Default version
    if (process.env['ENVIRONMENT'] === 'development') {
      useVersion = new Date().getTime().toString();
    }
    await reply.view(`countdown_vibe.ejs`, {
      translations,
      version: useVersion,
      domain: process.env['FRONTEND_URI'],
    });
  });

  // Get track link
  fastify.get('/qrlink/:trackId', async (request: any, reply) => {
    const headers = request.headers;
    const userAgent = headers['user-agent'] || '';

    const result = await data.getLink(
      request.params.trackId,
      request.clientIp,
      true,
      userAgent
    );
    let link = '';
    let yt = '';
    let appleMusicLink = '';
    let st = null;
    if (result.success) {
      link = result.data.link;
      yt = result.data.youtubeLink;
      appleMusicLink = result.data.appleMusicLink;
      st = result.data.st || null;
    }
    const useSpotifyRemote = true; // Default value
    return { link: link, yt: yt, am: appleMusicLink, r: useSpotifyRemote, st };
  });

  fastify.get('/qrlink2/:trackId/:php', async (request: any, reply) => {
    const headers = request.headers;
    const userAgent = headers['user-agent'] || '';
    const result = await data.getLink(
      request.params.trackId,
      request.clientIp,
      true,
      userAgent,
      request.params.php
    );
    let link = '';
    let yt = null;
    let ym = null;
    let am = null;
    let az = null;
    let dz = null;
    let td = null;
    let t = null;
    let st = null;

    if (result.success) {
      link = result.data.link;
      yt = result.data.youtubeLink || null;
      ym = result.data.youtubeMusicLink || null;
      am = result.data.appleMusicLink || null;
      az = result.data.amazonMusicLink || null;
      dz = result.data.deezerLink || null;
      td = result.data.tidalLink || null;
      t = result.data.t || null;
      st = result.data.st || null;
    }
    const useSpotifyRemote = true; // Default value
    return { link, yt, ym, am, az, dz, td, r: useSpotifyRemote, t, st };
  });

  // Hitlist routes
  fastify.post('/hitlist', async (request: any, _reply) => {
    return await hitlist.getCompanyListByDomain(
      request.body.domain,
      request.body.hash,
      request.body.slug
    );
  });

  fastify.post('/hitlist/search', async (request: any, _reply) => {
    const { searchString, limit = 10, offset = 0 } = request.body;
    return await hitlist.searchTracks(searchString);
    //return await spotify.searchTracks(searchString);
  });

  fastify.post('/hitlist/search-musicfetch', async (request: any, _reply) => {
    const { searchString } = request.body;
    return await hitlist.searchTracksMusicFetch(searchString);
  });

  // Get the #1 song for a given date (for birthday #1 feature)
  fastify.get('/hitlist/number-one/:date', async (request: any, reply) => {
    const { date } = request.params;
    const top40 = Top40.getInstance();
    const result = await top40.getNumberOneOnDate(new Date(date));
    if (!result) {
      return reply.status(404).send({ error: 'No #1 found for this date' });
    }
    return result;
  });

  fastify.post('/hitlist/tracks', async (request: any, _reply) => {
    const { trackIds } = request.body;

    if (!trackIds || !Array.isArray(trackIds) || trackIds.length === 0) {
      return { success: false, error: 'Invalid track IDs' };
    }

    return await spotify.getTracksByIds(trackIds);
  });

  fastify.post('/hitlist/submit', async (request: any, reply) => {
    const {
      hitlist: hitlistTracks,
      companyListId,
      submissionHash,
      firstname,
      lastname,
      locale,
      email,
      agreeToUseName,
      marketingEmails,
      birthDate,
      birthdayTrackId,
    } = request.body;

    // Add companyListId, submissionHash, firstname, lastname, email, agreeToUseName, and marketingEmails to each track
    const enrichedHitlist = hitlistTracks.map((track: any) => ({
      ...track,
      companyListId,
      submissionHash,
      firstname,
      lastname,
      email,
      locale,
      agreeToUseName,
      marketingEmails,
      birthDate,
      birthdayTrackId,
    }));

    const result = await hitlist.submit(enrichedHitlist);
    if (!result.success) {
      return result;
    }

    return {
      success: true,
      message: email
        ? 'Please check your email to verify your submission'
        : 'Submission received',
    };
  });

  // Verify hitlist submission
  fastify.post('/hitlist/verify', async (request: any, reply) => {
    const { hash } = request.body;

    if (!hash) {
      return { success: false, error: 'Missing verification hash' };
    }

    const success = await hitlist.verifySubmission(hash);

    return {
      success: success,
      message: success
        ? 'Verificatie succesvol. Je wordt nu terug gestuurd naar je lijst ...'
        : 'Verificatie mislukt',
    };
  });

  // Complete Spotify authorization
  fastify.post(
    '/hitlist/spotify-auth-complete',
    async (request: any, reply) => {
      const { code } = request.body;

      if (!code) {
        return { success: false, error: 'Missing authorization code' };
      }

      const token = await spotify.getTokensFromAuthCode(code);

      if (token) {
        logger.log(
          color.green.bold(
            'Spotify authorization successful via POST. Token stored.'
          )
        );
        return {
          success: true,
          message: 'Spotify authorization successful.',
        };
      } else {
        logger.log(
          color.red.bold('Failed to exchange Spotify auth code via POST.')
        );
        return {
          success: false,
          error: 'Failed to complete Spotify authorization.',
        };
      }
    }
  );

  // Spotify callback
  fastify.get('/spotify_callback', async (request: any, reply) => {
    const { code } = request.query;

    if (!code) {
      reply.type('text/html').send(`
        <html>
          <head><title>Spotify Authorization Failed</title></head>
          <body>
            <h1>Authorization Failed</h1>
            <p>No authorization code was received from Spotify.</p>
          </body>
        </html>
      `);
      return;
    }

    const tokenResult = await spotify.getTokensFromAuthCode(code);

    if (tokenResult) {
      logger.log(
        color.green.bold(
          'Spotify authorization successful via callback. Token stored.'
        )
      );
      reply.type('text/html').send(`
        <html>
          <head><title>Spotify Authorization Complete</title></head>
          <body>
            <h1>Authorization Complete</h1>
            <p>Your Spotify account has been successfully linked.</p>
          </body>
        </html>
      `);
    } else {
      logger.log(
        color.red.bold('Failed to exchange Spotify auth code during callback.')
      );
      reply.type('text/html').send(`
        <html>
          <head><title>Spotify Authorization Error</title></head>
          <body>
            <h1>Authorization Error</h1>
            <p>There was an error completing the Spotify authorization. Please try again.</p>
          </body>
        </html>
      `);
    }
  });

  // Development routes
  if (process.env['ENVIRONMENT'] == 'development') {
    fastify.get('/youtube/:artist/:title', async (request: any, reply: any) => {
      const result = await data.getYouTubeLink(
        request.params.artist,
        request.params.title
      );
      reply.send({
        success: true,
        youtubeLink: result,
      });
    });
  }
}
