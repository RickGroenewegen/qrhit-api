import { FastifyInstance } from 'fastify';
import Spotify from '../spotify';
import Utils from '../utils';

export default async function spotifyRoutes(fastify: FastifyInstance) {
  const spotify = Spotify.getInstance();
  const utils = new Utils();

  // Get Spotify authorization URL
  fastify.get('/spotify/auth-url', async (_request, reply) => {
    const authUrl = spotify.getAuthorizationUrl();
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
