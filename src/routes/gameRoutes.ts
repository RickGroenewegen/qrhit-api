import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Game from '../game';
import { Socket } from 'socket.io';

interface CreateGameBody {
  hostName: string;
  hostAvatar?: string;
  gameType: string;
  playMode: 'home' | 'remote';
  settings: {
    numberOfRounds: number;
    playlistIds?: number[];
    userHash?: string;
  };
}

interface JoinGameBody {
  gameId: string;
  playerName: string;
  playerAvatar?: string;
}

interface GameQuery {
  trackId?: string;
  gameId?: string;
}

const gameRoutes = async (fastify: FastifyInstance) => {
  const game = new Game();

  // Test endpoint
  fastify.get('/api/games/test', async (request, reply) => {
    return reply.send({ status: 'ok', message: 'Game routes are working' });
  });

  // Create a new game
  fastify.post<{ Body: CreateGameBody }>(
    '/api/games/create',
    async (request, reply) => {
      try {
        const { hostName, hostAvatar, gameType, playMode, settings } =
          request.body;

        const gameId = await game.createGame({
          hostName,
          hostAvatar,
          gameType,
          playMode,
          settings,
        });

        const response = { gameId };
        return reply.code(200).send(response);
      } catch (error: any) {
        fastify.log.error(error);
        return reply
          .status(500)
          .send({ error: error.message || 'Failed to create game' });
      }
    }
  );

  // Join an existing game
  fastify.post<{ Body: JoinGameBody }>(
    '/api/games/join',
    async (request, reply) => {
      try {
        const { gameId, playerName, playerAvatar } = request.body;

        const gameInfo = await game.joinGame(gameId, playerName, playerAvatar);

        if (!gameInfo) {
          return reply.status(404).send({ error: 'Game not found' });
        }

        return reply.send(gameInfo);
      } catch (error: any) {
        fastify.log.error(error);
        return reply
          .status(500)
          .send({ error: error.message || 'Failed to join game' });
      }
    }
  );

  // Get game info
  fastify.get<{ Params: { gameId: string } }>(
    '/api/games/:gameId',
    async (request, reply) => {
      try {
        const { gameId } = request.params;

        const gameInfo = await game.getGame(gameId);

        if (!gameInfo) {
          return reply.status(404).send({ error: 'Game not found' });
        }

        return reply.send(gameInfo);
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to get game info' });
      }
    }
  );

  // Get random track from database for the game
  fastify.get<{ Querystring: GameQuery }>(
    '/api/games/random-track',
    async (request, reply) => {
      try {
        const { gameId } = request.query;
        const track = await game.getRandomTrack(gameId);

        if (!track) {
          return reply.status(404).send({ error: 'No tracks available' });
        }

        return reply.send(track);
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to get random track' });
      }
    }
  );

  // Shared handler for playlist routes
  const playlistHandler = async (request: any, reply: any) => {
    const requestId = Math.random().toString(36).substring(7);
    const timestamp = new Date().toISOString();
    
    try {
      const userHash = request.params?.userHash;
      console.log(`[${requestId}] Playlist request at ${timestamp}`);
      console.log(`[${requestId}] Route: ${request.url}`);
      console.log(`[${requestId}] UserHash: ${userHash || 'none'}`);
      
      if (!userHash) {
        console.log(`[${requestId}] No userHash - fetching basic playlists only`);
        // No userHash provided, return basic playlists only
        const result = await game.getBasicPlaylists();
        console.log(`[${requestId}] Basic playlists result:`, JSON.stringify(result, null, 2));
        return reply.send(result);
      }
      
      console.log(`[${requestId}] UserHash provided - fetching user playlists`);
      // UserHash provided, return user playlists (which includes basic)
      const result = await game.getUserPlaylists(userHash);
      console.log(`[${requestId}] User playlists result:`, JSON.stringify(result, null, 2));
      return reply.send(result);
    } catch (error: any) {
      console.error(`[${requestId}] Error in playlist handler:`, error);
      console.error(`[${requestId}] Error stack:`, error.stack);
      fastify.log.error(error);
      
      if (error.message === 'User not found') {
        console.log(`[${requestId}] Returning 404 - User not found`);
        return reply.status(404).send({ error: 'User not found' });
      }
      
      console.log(`[${requestId}] Returning 500 - General error`);
      return reply.status(500).send({ 
        error: 'Failed to get playlists',
        message: error.message,
      });
    }
  };

  // Get playlists without userHash - returns basic playlists only
  console.log('Registering route: GET /api/games/playlists');
  fastify.get('/api/games/playlists', playlistHandler);

  // Get playlists with userHash - returns basic + user playlists
  console.log('Registering route: GET /api/games/playlists/:userHash');
  fastify.get<{ Params: { userHash: string } }>(
    '/api/games/playlists/:userHash',
    playlistHandler
  );
};

export default gameRoutes;
