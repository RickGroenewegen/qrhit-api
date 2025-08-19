import { FastifyInstance } from 'fastify';
import Spotify from '../spotify';
import Data from '../data';
import Hitlist from '../hitlist';
import { color } from 'console-log-colors';
import Logger from '../logger';
import Utils from '../utils';
import Translation from '../translation';
import fs from 'fs/promises';

export default async function musicRoutes(fastify: FastifyInstance) {
  const spotify = Spotify.getInstance();
  const data = Data.getInstance();
  const hitlist = Hitlist.getInstance();
  const logger = new Logger();
  const utils = new Utils();
  const translation = new Translation();

  // Get Spotify authorization URL
  fastify.get('/spotify/auth-url', async (_request, reply) => {
    const authUrl = spotify.getAuthorizationUrl();
    console.log(111, authUrl);
    reply.send({ success: true });
  });

  // Get Spotify playlist tracks
  fastify.post('/spotify/playlists/tracks', async (request: any, _reply) => {
    const userAgent = request.headers['user-agent'] || '';
    return await spotify.getTracks(
      request.body.playlistId,
      utils.parseBoolean(request.body.cache),
      request.body.captchaToken,
      true,
      utils.parseBoolean(request.body.slug),
      request.clientIp,
      userAgent
    );
  });

  // Get Spotify playlist info
  fastify.post('/spotify/playlists', async (request: any, _reply) => {
    return await spotify.getPlaylist(
      request.body.playlistId,
      utils.parseBoolean(request.body.cache),
      request.body.captchaToken,
      true,
      utils.parseBoolean(request.body.featured),
      utils.parseBoolean(request.body.slug),
      request.body.locale
    );
  });

  // Resolve unknown Spotify URL
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
        reply.send({ success: true, spotifyUri: result.spotifyUri });
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
    if (result.success) {
      link = result.data.link;
      yt = result.data.youtubeLink;
    }
    const useSpotifyRemote = true; // Default value
    return { link: link, yt: yt, r: useSpotifyRemote };
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
    let yt = '';
    if (result.success) {
      link = result.data.link;
      yt = result.data.youtubeLink;
    }
    const useSpotifyRemote = true; // Default value
    return { link: link, yt: yt, r: useSpotifyRemote };
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
    return await spotify.searchTracks(searchString);
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
