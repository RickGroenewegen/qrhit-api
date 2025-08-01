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
  private logger: Logger;
  private redis: Redis;
  private playerAvatars: Map<string, Map<string, string>> = new Map(); // gameId -> playerId -> avatarUrl

  // Store player avatars separately
  private async storePlayerAvatar(gameId: string, playerId: string, avatar: string): Promise<void> {
    if (!this.playerAvatars.has(gameId)) {
      this.playerAvatars.set(gameId, new Map());
    }
    this.playerAvatars.get(gameId)!.set(playerId, avatar);
    
    // Also store in Redis for persistence
    await this.redis.hset(`game:${gameId}:avatars`, playerId, avatar);
    await this.redis.expire(`game:${gameId}:avatars`, 60 * 60 * 4);
  }
  
  // Get all avatars for a game
  private async getGameAvatars(gameId: string): Promise<Map<string, string>> {
    const avatars = await this.redis.hgetall(`game:${gameId}:avatars`);
    const map = new Map<string, string>();
    for (const [playerId, avatar] of Object.entries(avatars)) {
      map.set(playerId, avatar);
    }
    return map;
  }

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

      socket.on('showLeaderboard', async (data: { gameId: string }) => {
        await this.handleShowLeaderboard(socket, data);
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
        this.handleDisconnect(socket);
      });
    });
  }

  private async handleJoinGame(socket: Socket, data: JoinGameData) {
    try {
      const { gameId, playerName, playerAvatar, isHost } = data;


      // Store player info on socket
      socket.data.gameId = gameId;
      socket.data.playerName = playerName;
      socket.data.isHost = isHost;

      // Join the game room
      socket.join(gameId);

      // Ensure cache is warmed for this game when host joins
      if (isHost) {
        // Fire and forget - don't block the join
        this.game.prewarmGameCache(gameId).then(() => {
          // Cache warming completed
        }).catch(err => {
          // Error warming cache
        });
      }

      // Get updated game data
      const gameData = await this.game.getGame(gameId);
      if (!gameData) {
        socket.emit('error', 'Game not found');
        return;
      }

      // Find the player in the game
      const player = gameData.players.find((p) => p.name === playerName);
      if (player) {
        socket.data.playerId = player.id;
        
        // Store avatar separately if provided
        if (player.avatar) {
          await this.storePlayerAvatar(gameId, player.id, player.avatar);
        }
      } else {
      }

      // Send players data with avatars (only on join)
      this.io.to(gameId).emit('playerJoined', {
        players: gameData.players,
      });

      // Send game data to the joining player with all avatars
      const gameAvatars = await this.getGameAvatars(gameId);
      socket.emit('gameData', {
        players: gameData.players,
        currentRound: gameData.currentRound,
        totalRounds: gameData.settings.numberOfRounds,
        avatars: Object.fromEntries(gameAvatars) // Send all avatars as an object
      });
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

      // Get all avatars for the game
      const gameAvatars = await this.getGameAvatars(gameId);
      
      // Send game data with avatars
      socket.emit('gameData', {
        players: gameData.players,
        currentRound: gameData.currentRound,
        totalRounds: gameData.settings.numberOfRounds,
        avatars: Object.fromEntries(gameAvatars) // Send all avatars as an object
      });

      // If game is in playing state and we're in a round, emit the round starting event
      if (gameData.state === 'playing' && gameData.currentRound > 0) {
        socket.emit('roundStarting', { round: gameData.currentRound });
      }
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

      // Start first round countdown with a longer delay to ensure clients have navigated
      setTimeout(() => {
        this.io.to(gameId).emit('roundStarting', { round: 1 });
      }, 2000);
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

      // Get a random track from the game's selected playlists
      const track = await this.game.getRandomTrack(gameId);
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

        // Remove avatars from answers to reduce data transfer
        const answersWithoutAvatars = results.answers.map(answer => {
          const { playerAvatar, ...rest } = answer;
          return rest;
        });
        
        // Send results to all players
        this.io.to(gameId).emit('showResults', {
          answers: answersWithoutAvatars,
          correctAnswer: results.correctAnswer,
        });
      }
    } catch (error) {
      this.logger.log('Error submitting answer');
      socket.emit('error', 'Failed to submit answer');
    }
  }

  private async handleShowLeaderboard(socket: Socket, data: { gameId: string }) {
    try {
      const { gameId } = data;

      if (!socket.data.isHost) {
        return; // Only host can show leaderboard
      }

      const leaderboard = await this.partyGame.getLeaderboard(gameId);
      
      // Remove avatars from leaderboard to reduce data transfer
      const leaderboardWithoutAvatars = leaderboard.map(player => {
        const { avatar, ...rest } = player;
        return rest;
      });
      
      this.io.to(gameId).emit('showLeaderboard', { leaderboard: leaderboardWithoutAvatars });
    } catch (error) {
      this.logger.log('Error showing leaderboard');
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

      gameData.currentRound++;
      await this.game.updateGame(gameId, gameData);

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

      // Remove avatars from final results to reduce data transfer
      const topPlayersWithoutAvatars = topPlayers.map(player => {
        const { avatar, ...rest } = player;
        return rest;
      });

      this.io.to(gameId).emit('gameFinished', { topPlayers: topPlayersWithoutAvatars });
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
      
      // Don't clear avatars on restart - they should persist

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
