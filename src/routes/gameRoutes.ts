import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Game from '../game';

interface CreateGameBody {
  hostName: string;
  hostAvatar?: string;
  gameType: string;
  playMode: 'home' | 'remote';
  settings: {
    numberOfRounds: number;
    roundCountdown?: number;
    roundTypes?: string[];
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
      if (!userHash) {
        // No userHash provided, return basic playlists only
        const result = await game.getBasicPlaylists();
        return reply.send(result);
      }
      
      // UserHash provided, return user playlists (which includes basic)
      const result = await game.getUserPlaylists(userHash);
      return reply.send(result);
    } catch (error: any) {
      fastify.log.error(error);
      
      if (error.message === 'User not found') {
        return reply.status(404).send({ error: 'User not found' });
      }
      
      return reply.status(500).send({ 
        error: 'Failed to get playlists',
        message: error.message,
      });
    }
  };

  // Get playlists without userHash - returns basic playlists only
  fastify.get('/api/games/playlists', playlistHandler);

  // Get playlists with userHash - returns basic + user playlists
  fastify.get<{ Params: { userHash: string } }>(
    '/api/games/playlists/:userHash',
    playlistHandler
  );
};

export default gameRoutes;
