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
  };
}

interface JoinGameBody {
  gameId: string;
  playerName: string;
  playerAvatar?: string;
}

interface GameQuery {
  trackId: string;
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
        const track = await game.getRandomTrack();

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
};

export default gameRoutes;
