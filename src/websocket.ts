import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import Game from './game';
import PartyGame from './games/party';
import Logger from './logger';

interface JoinGameData {
  gameId: string;
  playerName: string;
  playerAvatar?: string;
  isHost: boolean;
}

interface SubmitAnswerData {
  gameId: string;
  answer: string;
  questionType: string;
}

interface RequestQuestionData {
  gameId: string;
  round: number;
}

class WebSocketServer {
  private io: SocketIOServer;
  private game: Game;
  private partyGame: PartyGame;
  private leaderboardTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private logger: Logger;
  private redis: Redis;

  constructor(server: HTTPServer) {
    this.io = new SocketIOServer(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    // Initialize services first
    this.game = new Game();
    this.partyGame = new PartyGame();
    this.logger = new Logger();

    // Set up Redis adapter for clustering support
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not defined');
    } else {
      // Initialize Redis client for game state
      this.redis = new Redis(redisUrl);

      const pubClient = new Redis(redisUrl);
      const subClient = pubClient.duplicate();

      pubClient.on('error', (err) => {
        this.logger.log(`Redis adapter pub client error: ${err.message}`);
      });

      subClient.on('error', (err) => {
        this.logger.log(`Redis adapter sub client error: ${err.message}`);
      });

      this.io.adapter(createAdapter(pubClient, subClient));
    }

    this.initializeHandlers();
  }

  // Helper methods for Redis storage
  private async storePlayerAnswer(
    gameId: string,
    playerId: string,
    answer: string
  ): Promise<void> {
    await this.redis.hset(`game:${gameId}:answers`, playerId, answer);
    // Set expiration to match game expiration (4 hours)
    await this.redis.expire(`game:${gameId}:answers`, 60 * 60 * 4);
  }

  private async getPlayerAnswers(gameId: string): Promise<Map<string, string>> {
    const answers = await this.redis.hgetall(`game:${gameId}:answers`);
    const map = new Map<string, string>();
    for (const [playerId, answer] of Object.entries(answers)) {
      map.set(playerId, answer);
    }
    return map;
  }

  private async clearPlayerAnswers(gameId: string): Promise<void> {
    await this.redis.del(`game:${gameId}:answers`);
  }

  private async storeCurrentQuestion(
    gameId: string,
    question: any,
    track: any
  ): Promise<void> {
    const data = JSON.stringify({ question, track });
    await this.redis.setex(`game:${gameId}:currentQuestion`, 60 * 60 * 4, data);
  }

  private async getCurrentQuestion(
    gameId: string
  ): Promise<{ question: any; track: any } | null> {
    const data = await this.redis.get(`game:${gameId}:currentQuestion`);
    if (!data) return null;
    return JSON.parse(data);
  }

  private initializeHandlers() {
    this.io.on('connection', (socket: Socket) => {
      console.log('Client connected:', socket.id);

      socket.on('joinGame', async (data: JoinGameData) => {
        await this.handleJoinGame(socket, data);
      });

      socket.on(
        'rejoinGame',
        async (data: { gameId: string; playerName: string }) => {
          await this.handleRejoinGame(socket, data);
        }
      );

      socket.on('startGame', async (data: { gameId: string }) => {
        await this.handleStartGame(socket, data);
      });

      socket.on('requestQuestion', async (data: RequestQuestionData) => {
        await this.handleRequestQuestion(socket, data);
      });

      socket.on('submitAnswer', async (data: SubmitAnswerData) => {
        await this.handleSubmitAnswer(socket, data);
      });

      socket.on('startNextRound', async (data: { gameId: string }) => {
        await this.handleStartNextRound(socket, data);
      });

      socket.on('showFinalResults', async (data: { gameId: string }) => {
        await this.handleShowFinalResults(socket, data);
      });

      socket.on('restartGame', async (data: { gameId: string }) => {
        await this.handleRestartGame(socket, data);
      });

      socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        this.handleDisconnect(socket);
      });
    });
  }

  private async handleJoinGame(socket: Socket, data: JoinGameData) {
    try {
      const { gameId, playerName, playerAvatar, isHost } = data;

      console.log(
        `WebSocket: Player "${playerName}" attempting to join game "${gameId}" (isHost: ${isHost})`
      );

      // Store player info on socket
      socket.data.gameId = gameId;
      socket.data.playerName = playerName;
      socket.data.isHost = isHost;

      // Join the game room
      socket.join(gameId);
      console.log(`WebSocket: Socket ${socket.id} joined room ${gameId}`);

      // Get updated game data
      const gameData = await this.game.getGame(gameId);
      if (!gameData) {
        console.error(`WebSocket: Game ${gameId} not found`);
        socket.emit('error', 'Game not found');
        return;
      }

      // Find the player in the game
      const player = gameData.players.find((p) => p.name === playerName);
      if (player) {
        socket.data.playerId = player.id;
        console.log(
          `WebSocket: Found existing player ${playerName} with ID ${player.id}`
        );
      } else {
        console.log(`WebSocket: Player ${playerName} not found in game data`);
      }

      console.log(
        `WebSocket: Current players in game ${gameId}:`,
        gameData.players.map((p) => p.name)
      );

      // Notify all players in the room
      this.io.to(gameId).emit('playerJoined', {
        players: gameData.players,
      });
      console.log(
        `WebSocket: Notified all players in room ${gameId} about player join`
      );

      // Send game data to the joining player
      socket.emit('gameData', {
        players: gameData.players,
        currentRound: gameData.currentRound,
        totalRounds: gameData.settings.numberOfRounds,
      });
      console.log(`WebSocket: Sent game data to player ${playerName}`);
    } catch (error) {
      this.logger.log('Error joining game');
      socket.emit('error', 'Failed to join game');
    }
  }

  private async handleRejoinGame(
    socket: Socket,
    data: { gameId: string; playerName: string }
  ) {
    try {
      const { gameId, playerName } = data;

      const gameData = await this.game.getGame(gameId);
      if (!gameData) {
        socket.emit('error', 'Game not found');
        return;
      }

      const player = gameData.players.find((p) => p.name === playerName);
      if (!player) {
        socket.emit('error', 'Player not found in game');
        return;
      }

      // Store player info on socket
      socket.data.gameId = gameId;
      socket.data.playerName = playerName;
      socket.data.playerId = player.id;
      socket.data.isHost = player.isHost;

      // Join the game room
      socket.join(gameId);

      // Send game data
      socket.emit('gameData', {
        players: gameData.players,
        currentRound: gameData.currentRound,
        totalRounds: gameData.settings.numberOfRounds,
      });
    } catch (error) {
      this.logger.log('Error rejoining game');
      socket.emit('error', 'Failed to rejoin game');
    }
  }

  private async handleStartGame(socket: Socket, data: { gameId: string }) {
    try {
      const { gameId } = data;

      if (!socket.data.isHost) {
        socket.emit('error', 'Only the host can start the game');
        return;
      }

      const gameData = await this.game.getGame(gameId);
      if (!gameData) {
        socket.emit('error', 'Game not found');
        return;
      }

      // Update game state
      gameData.state = 'playing';
      gameData.currentRound = 1;
      await this.game.updateGame(gameId, gameData);

      // Notify all players
      this.io.to(gameId).emit('gameStarted');

      // Start first round countdown
      setTimeout(() => {
        this.io.to(gameId).emit('roundStarting', { round: 1 });
      }, 1000);
    } catch (error) {
      this.logger.log('Error starting game');
      socket.emit('error', 'Failed to start game');
    }
  }

  private async handleRequestQuestion(
    socket: Socket,
    data: RequestQuestionData
  ) {
    try {
      const { gameId, round } = data;

      if (!socket.data.isHost) {
        return; // Only host can request questions
      }

      // Get a random track
      const track = await this.game.getRandomTrack();
      if (!track) {
        socket.emit('error', 'No tracks available');
        return;
      }

      // Generate a question
      const question = await this.partyGame.generateQuestion(track, gameId);

      // Store current question
      await this.storeCurrentQuestion(gameId, question, track);

      // Clear previous answers
      await this.clearPlayerAnswers(gameId);

      // Send question to all players
      this.io.to(gameId).emit('questionStart', {
        question,
        trackInfo: {
          uri: track.uri,
          name: track.name,
          artist: track.artist,
          year: track.year,
        },
      });
    } catch (error) {
      this.logger.log('Error requesting question');
      socket.emit('error', 'Failed to get question');
    }
  }

  private async handleSubmitAnswer(socket: Socket, data: SubmitAnswerData) {
    try {
      const { gameId, answer } = data;
      const playerId = socket.data.playerId;

      if (!playerId) {
        socket.emit('error', 'Player not found');
        return;
      }

      // Store the answer in Redis
      await this.storePlayerAnswer(gameId, playerId, answer);

      // Notify all players that this player has submitted
      this.io.to(gameId).emit('playerSubmitted', { playerId });

      // Check if all players have submitted
      const gameData = await this.game.getGame(gameId);
      if (!gameData) return;

      // Get all submitted answers from Redis
      const gameAnswers = await this.getPlayerAnswers(gameId);

      const allAnswered = gameData.players.every((player) =>
        gameAnswers.has(player.id)
      );

      if (allAnswered) {
        // Process results
        const currentQuestion = await this.getCurrentQuestion(gameId);
        if (!currentQuestion) return;

        const results = await this.partyGame.processRoundResults(
          gameId,
          currentQuestion.question,
          gameAnswers
        );

        // Send results to all players
        this.io.to(gameId).emit('showResults', {
          answers: results.answers,
          correctAnswer: results.correctAnswer,
        });

        // Clear any existing timeout for this game
        const existingTimeout = this.leaderboardTimeouts.get(gameId);
        if (existingTimeout) {
          clearTimeout(existingTimeout);
        }

        // Show leaderboard after a delay
        const timeout = setTimeout(async () => {
          const leaderboard = await this.partyGame.getLeaderboard(gameId);
          this.io.to(gameId).emit('showLeaderboard', { leaderboard });
          this.leaderboardTimeouts.delete(gameId);
        }, 8000);

        this.leaderboardTimeouts.set(gameId, timeout);
      }
    } catch (error) {
      this.logger.log('Error submitting answer');
      socket.emit('error', 'Failed to submit answer');
    }
  }

  private async handleStartNextRound(socket: Socket, data: { gameId: string }) {
    try {
      const { gameId } = data;

      if (!socket.data.isHost) {
        return;
      }

      const gameData = await this.game.getGame(gameId);
      if (!gameData) return;

      // Clear any pending leaderboard timeout
      const existingTimeout = this.leaderboardTimeouts.get(gameId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
        this.leaderboardTimeouts.delete(gameId);
      }

      gameData.currentRound++;
      await this.game.updateGame(gameId, gameData);

      // Clear the timeout one more time to be absolutely sure
      const timeout = this.leaderboardTimeouts.get(gameId);
      if (timeout) {
        clearTimeout(timeout);
        this.leaderboardTimeouts.delete(gameId);
      }

      // Start countdown for next round
      this.io
        .to(gameId)
        .emit('roundStarting', { round: gameData.currentRound });
    } catch (error) {
      this.logger.log('Error starting next round');
    }
  }

  private async handleShowFinalResults(
    socket: Socket,
    data: { gameId: string }
  ) {
    try {
      const { gameId } = data;

      if (!socket.data.isHost) {
        return;
      }

      const topPlayers = await this.partyGame.getFinalResults(gameId);

      // Update game state
      const gameData = await this.game.getGame(gameId);
      if (gameData) {
        gameData.state = 'finished';
        await this.game.updateGame(gameId, gameData);
      }

      this.io.to(gameId).emit('gameFinished', { topPlayers });
    } catch (error) {
      this.logger.log('Error showing final results');
    }
  }

  private async handleRestartGame(socket: Socket, data: { gameId: string }) {
    try {
      const { gameId } = data;

      if (!socket.data.isHost) {
        return;
      }

      const gameData = await this.game.getGame(gameId);
      if (!gameData) return;

      // Reset game state
      gameData.state = 'playing';
      gameData.currentRound = 1;
      gameData.players.forEach((player) => {
        player.score = 0;
      });

      await this.game.updateGame(gameId, gameData);

      // Clear stored data from Redis
      await this.clearPlayerAnswers(gameId);
      await this.redis.del(`game:${gameId}:currentQuestion`);

      // Notify all players
      this.io.to(gameId).emit('gameRestarted');
    } catch (error) {
      this.logger.log('Error restarting game');
    }
  }

  private async handleDisconnect(socket: Socket) {
    try {
      const { gameId, playerId, isHost } = socket.data;

      if (!gameId || !playerId) return;

      const gameData = await this.game.getGame(gameId);
      if (!gameData) return;

      if (isHost) {
        // Host left, end the game
        this.io.to(gameId).emit('hostLeft');

        // Could also clean up the game from Redis here
        // But keeping it for now in case they want to rejoin
      } else {
        // Regular player left
        gameData.players = gameData.players.filter((p) => p.id !== playerId);
        await this.game.updateGame(gameId, gameData);

        this.io.to(gameId).emit('playerLeft', {
          players: gameData.players,
        });
      }
    } catch (error) {
      this.logger.log('Error handling disconnect');
    }
  }
}

export default WebSocketServer;
