import { FastifyInstance } from 'fastify';
import QuizCardGame, { QuizSettings } from '../games/quiz-card';
import PrismaInstance from '../prisma';

interface ValidateOrderBody {
  orderId: string;
  email: string;
}

interface CreateQuizBody {
  phpId: number;
  playlistIds: number[];
  settings?: Partial<QuizSettings>;
}

interface UpdateSettingsBody {
  settings: Partial<QuizSettings>;
}

const quizRoutes = async (fastify: FastifyInstance) => {
  const quizGame = QuizCardGame.getInstance();
  const prisma = PrismaInstance.getInstance();

  // Validate order by orderId + email and return playlists
  fastify.post<{ Body: ValidateOrderBody }>(
    '/api/quiz/validate-order',
    async (request, reply) => {
      try {
        const { orderId, email } = request.body;

        if (!orderId || !email) {
          return reply.status(400).send({
            success: false,
            error: 'MISSING_FIELDS',
            message: 'Both orderId and email are required',
          });
        }

        // Find payment by orderId and email
        // MySQL is case-insensitive by default, but normalize for safety
        const payment = await prisma.payment.findFirst({
          where: {
            orderId: orderId,
            email: email.toLowerCase(),
            status: 'paid',
          },
          include: {
            PaymentHasPlaylist: {
              include: {
                playlist: {
                  select: {
                    id: true,
                    playlistId: true,
                    name: true,
                    image: true,
                    numberOfTracks: true,
                  },
                },
              },
            },
            user: {
              select: {
                id: true,
                hash: true,
                displayName: true,
              },
            },
          },
        });

        if (!payment) {
          return reply.status(404).send({
            success: false,
            error: 'INVALID_ORDER',
            message: 'Order not found or email does not match',
          });
        }

        // Extract playlists with their PHP IDs
        const playlists = payment.PaymentHasPlaylist.map((php) => ({
          phpId: php.id,
          playlistId: php.playlist.id,
          spotifyPlaylistId: php.playlist.playlistId,
          name: php.playlist.name,
          image: php.playlist.image,
          numberOfTracks: php.playlist.numberOfTracks,
        }));

        return reply.send({
          success: true,
          data: {
            paymentId: payment.paymentId,
            orderId: payment.orderId,
            fullname: payment.fullname,
            email: payment.email,
            userHash: payment.user?.hash,
            playlists,
          },
        });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: 'SERVER_ERROR',
          message: 'Failed to validate order',
        });
      }
    }
  );

  // Create a new quiz game
  fastify.post<{ Body: CreateQuizBody }>(
    '/api/quiz/create',
    async (request, reply) => {
      try {
        const { phpId, playlistIds, settings } = request.body;

        if (!phpId || !playlistIds || playlistIds.length === 0) {
          return reply.status(400).send({
            success: false,
            error: 'MISSING_FIELDS',
            message: 'phpId and playlistIds are required',
          });
        }

        // Verify the PHP exists
        const php = await prisma.paymentHasPlaylist.findUnique({
          where: { id: phpId },
        });

        if (!php) {
          return reply.status(404).send({
            success: false,
            error: 'PHP_NOT_FOUND',
            message: 'Payment has playlist record not found',
          });
        }

        // Check if there's already an active game for this PHP - end it and create new one
        const existingGame = await quizGame.getActiveGameForPhp(phpId);
        if (existingGame) {
          console.log(`[Quiz] Ending existing game ${existingGame.id} for phpId ${phpId} to create new one`);
          // End the existing game (players will get disconnected when WebSocket closes)
          await quizGame.endGame(existingGame.id);
        }

        // Create the game (hostConnectionId will be set when host connects via WebSocket)
        const gameId = await quizGame.createGame(
          phpId,
          playlistIds,
          '', // Host connection ID will be set via WebSocket
          settings
        );

        const baseUrl = process.env.FRONTEND_URL || 'https://www.qrsong.io';
        const joinUrl = `${baseUrl}/game/join/${gameId}`;

        return reply.send({
          success: true,
          data: {
            gameId,
            joinUrl,
            phpId,
            playlistIds,
          },
        });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: 'SERVER_ERROR',
          message: error.message || 'Failed to create quiz game',
        });
      }
    }
  );

  // Get quiz game state
  fastify.get<{ Params: { gameId: string } }>(
    '/api/quiz/:gameId',
    async (request, reply) => {
      try {
        const { gameId } = request.params;

        const game = await quizGame.getGame(gameId);

        if (!game) {
          return reply.status(404).send({
            success: false,
            error: 'GAME_NOT_FOUND',
            message: 'Quiz game not found',
          });
        }

        const players = await quizGame.getPlayers(gameId);

        // Return sanitized game state (no secret track info)
        return reply.send({
          success: true,
          data: {
            id: game.id,
            phpId: game.phpId,
            state: game.state,
            settings: game.settings,
            currentRound: game.currentRound,
            tracksScanned: game.tracksScanned,
            createdAt: game.createdAt,
            startedAt: game.startedAt,
            players: players.map((p) => ({
              id: p.id,
              name: p.name,
              avatar: p.avatar,
              score: p.score,
              isHost: p.isHost,
              hasSubmitted: p.hasSubmitted,
            })),
          },
        });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: 'SERVER_ERROR',
          message: 'Failed to get quiz game',
        });
      }
    }
  );

  // Check if quiz game exists for PHP
  fastify.get<{ Params: { phpId: string } }>(
    '/api/quiz/php/:phpId/exists',
    async (request, reply) => {
      try {
        const phpId = parseInt(request.params.phpId, 10);

        if (isNaN(phpId)) {
          return reply.status(400).send({
            success: false,
            error: 'INVALID_PHP_ID',
            message: 'Invalid phpId',
          });
        }

        const game = await quizGame.getActiveGameForPhp(phpId);

        return reply.send({
          success: true,
          data: {
            exists: game !== null,
            gameId: game?.id || null,
            state: game?.state || null,
          },
        });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: 'SERVER_ERROR',
          message: 'Failed to check quiz game existence',
        });
      }
    }
  );

  // Get game by PHP ID
  fastify.get<{ Params: { phpId: string } }>(
    '/api/quiz/php/:phpId',
    async (request, reply) => {
      try {
        const phpId = parseInt(request.params.phpId, 10);

        if (isNaN(phpId)) {
          return reply.status(400).send({
            success: false,
            error: 'INVALID_PHP_ID',
            message: 'Invalid phpId',
          });
        }

        const game = await quizGame.getActiveGameForPhp(phpId);

        if (!game) {
          return reply.status(404).send({
            success: false,
            error: 'GAME_NOT_FOUND',
            message: 'No active quiz game for this playlist',
          });
        }

        const players = await quizGame.getPlayers(game.id);

        return reply.send({
          success: true,
          data: {
            id: game.id,
            phpId: game.phpId,
            state: game.state,
            settings: game.settings,
            currentRound: game.currentRound,
            tracksScanned: game.tracksScanned,
            createdAt: game.createdAt,
            startedAt: game.startedAt,
            players: players.map((p) => ({
              id: p.id,
              name: p.name,
              avatar: p.avatar,
              score: p.score,
              isHost: p.isHost,
              hasSubmitted: p.hasSubmitted,
            })),
          },
        });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: 'SERVER_ERROR',
          message: 'Failed to get quiz game',
        });
      }
    }
  );

  // Update game settings (before game starts)
  fastify.patch<{ Params: { gameId: string }; Body: UpdateSettingsBody }>(
    '/api/quiz/:gameId/settings',
    async (request, reply) => {
      try {
        const { gameId } = request.params;
        const { settings } = request.body;

        const game = await quizGame.getGame(gameId);

        if (!game) {
          return reply.status(404).send({
            success: false,
            error: 'GAME_NOT_FOUND',
            message: 'Quiz game not found',
          });
        }

        if (game.state !== 'lobby') {
          return reply.status(400).send({
            success: false,
            error: 'GAME_STARTED',
            message: 'Cannot update settings after game has started',
          });
        }

        // Update settings
        if (settings.maxPlayers !== undefined) {
          game.settings.maxPlayers = Math.min(settings.maxPlayers, 100);
        }
        if (settings.roundTimer !== undefined) {
          game.settings.roundTimer = Math.max(15, Math.min(settings.roundTimer, 90));
        }
        if (settings.totalRounds !== undefined) {
          game.settings.totalRounds = settings.totalRounds;
        }
        if (settings.yearTolerance !== undefined) {
          game.settings.yearTolerance = Math.max(0, Math.min(settings.yearTolerance, 10));
        }
        if (settings.hostPlays !== undefined) {
          game.settings.hostPlays = settings.hostPlays;
        }

        await quizGame.updateGame(gameId, game);

        return reply.send({
          success: true,
          data: {
            settings: game.settings,
          },
        });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: 'SERVER_ERROR',
          message: 'Failed to update settings',
        });
      }
    }
  );

  // Get leaderboard for a game
  fastify.get<{ Params: { gameId: string } }>(
    '/api/quiz/:gameId/leaderboard',
    async (request, reply) => {
      try {
        const { gameId } = request.params;

        const game = await quizGame.getGame(gameId);

        if (!game) {
          return reply.status(404).send({
            success: false,
            error: 'GAME_NOT_FOUND',
            message: 'Quiz game not found',
          });
        }

        const leaderboard = await quizGame.getLeaderboard(gameId);

        return reply.send({
          success: true,
          data: {
            leaderboard: leaderboard.map((p, index) => ({
              rank: index + 1,
              id: p.id,
              name: p.name,
              avatar: p.avatar,
              score: p.score,
              artistPoints: p.artistPoints,
              titlePoints: p.titlePoints,
              yearPoints: p.yearPoints,
              isHost: p.isHost,
            })),
          },
        });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: 'SERVER_ERROR',
          message: 'Failed to get leaderboard',
        });
      }
    }
  );
};

export default quizRoutes;
