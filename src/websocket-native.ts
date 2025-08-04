import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { parse } from 'url';
import Redis from 'ioredis';
import { GameAdapter } from './game-adapter';
import Logger from './logger';

interface WebSocketMessage {
  type: string;
  data?: any;
}

interface PlayerConnection {
  id: string;
  ws: WebSocket;
  gameId: string;
  playerName: string;
  playerAvatar?: string;
  isHost: boolean;
  isAlive: boolean;
}

class NativeWebSocketServer {
  private wss: WebSocketServer;
  private connections: Map<string, PlayerConnection> = new Map();
  private gameConnections: Map<string, Set<string>> = new Map();
  private gameAdapter: GameAdapter;
  private logger: Logger;
  private redis: Redis;
  private pubClient: Redis;
  private subClient: Redis;
  private playerAvatars: Map<string, Map<string, string>> = new Map();
  private heartbeatInterval!: NodeJS.Timeout;

  constructor(server: HTTPServer) {
    this.wss = new WebSocketServer({ 
      server,
      path: '/ws',
      perMessageDeflate: {
        zlibDeflateOptions: {
          chunkSize: 1024,
          memLevel: 7,
          level: 3
        },
        zlibInflateOptions: {
          chunkSize: 10 * 1024
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 1024
      }
    });

    // Initialize services
    this.gameAdapter = new GameAdapter();
    this.logger = new Logger();

    // Set up Redis for distributed support
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not defined');
    }

    // Initialize Redis clients
    this.redis = new Redis(redisUrl);
    this.pubClient = new Redis(redisUrl);
    this.subClient = this.pubClient.duplicate();

    // Set up Redis pub/sub for cross-server communication
    this.setupRedisPubSub();

    // Initialize WebSocket handlers
    this.initializeHandlers();

    // Start heartbeat
    this.startHeartbeat();
  }

  private setupRedisPubSub() {
    // Subscribe to game events from other servers
    this.subClient.subscribe('game-events', (err) => {
      if (err) {
        this.logger.log(`Failed to subscribe to game-events: ${err.message}`);
      }
    });

    this.subClient.on('message', async (channel, message) => {
      if (channel === 'game-events') {
        try {
          const event = JSON.parse(message);
          await this.handleRedisEvent(event);
        } catch (error) {
          this.logger.log(`Error handling Redis event: ${error}`);
        }
      }
    });
  }

  private async handleRedisEvent(event: any) {
    const { gameId, type, data, excludeConnectionId } = event;
    
    // Broadcast to all connections in the game except the sender
    const gameConnectionIds = this.gameConnections.get(gameId);
    if (gameConnectionIds) {
      for (const connectionId of gameConnectionIds) {
        if (connectionId !== excludeConnectionId) {
          const connection = this.connections.get(connectionId);
          if (connection && connection.ws.readyState === WebSocket.OPEN) {
            this.sendMessage(connection.ws, { type, data });
          }
        }
      }
    }
  }

  private publishRedisEvent(gameId: string, type: string, data: any, excludeConnectionId?: string) {
    const event = { gameId, type, data, excludeConnectionId };
    this.pubClient.publish('game-events', JSON.stringify(event));
  }

  private initializeHandlers() {
    this.wss.on('connection', (ws: WebSocket, request) => {
      const connectionId = this.generateConnectionId();
      
      // Parse query parameters
      const { query } = parse(request.url || '', true);
      const gameId = query.gameId as string;

      // Set up ping/pong for connection health
      ws.on('pong', () => {
        const connection = this.connections.get(connectionId);
        if (connection) {
          connection.isAlive = true;
        }
      });

      ws.on('message', async (message: Buffer) => {
        try {
          const data = JSON.parse(message.toString()) as WebSocketMessage;
          await this.handleMessage(connectionId, ws, data);
        } catch (error) {
          this.logger.log(`Error processing message: ${error}`);
          this.sendError(ws, 'Invalid message format');
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(connectionId);
      });

      ws.on('error', (error) => {
        this.logger.log(`WebSocket error for ${connectionId}: ${error}`);
      });

      // Send initial connection acknowledgment
      this.sendMessage(ws, { type: 'connected', data: { connectionId } });
    });
  }

  private async handleMessage(connectionId: string, ws: WebSocket, message: WebSocketMessage) {
    const { type, data } = message;

    switch (type) {
      case 'joinGame':
        await this.handleJoinGame(connectionId, ws, data);
        break;
      case 'rejoinGame':
        await this.handleRejoinGame(connectionId, ws, data);
        break;
      case 'startGame':
        await this.handleStartGame(connectionId, data);
        break;
      case 'requestQuestion':
        await this.handleRequestQuestion(connectionId, data);
        break;
      case 'submitAnswer':
        await this.handleSubmitAnswer(connectionId, data);
        break;
      case 'showLeaderboard':
        await this.handleShowLeaderboard(connectionId, data);
        break;
      case 'startNextRound':
        await this.handleStartNextRound(connectionId, data);
        break;
      case 'showFinalResults':
        await this.handleShowFinalResults(connectionId, data);
        break;
      case 'restartGame':
        await this.handleRestartGame(connectionId, data);
        break;
      case 'ping':
        this.sendMessage(ws, { type: 'pong' });
        break;
      default:
        this.sendError(ws, `Unknown message type: ${type}`);
    }
  }

  private async handleJoinGame(connectionId: string, ws: WebSocket, data: any) {
    const { gameId, playerName, playerAvatar, isHost } = data;

    // Store connection info
    const connection: PlayerConnection = {
      id: connectionId,
      ws,
      gameId,
      playerName,
      playerAvatar,
      isHost,
      isAlive: true
    };
    this.connections.set(connectionId, connection);

    // Add to game connections
    if (!this.gameConnections.has(gameId)) {
      this.gameConnections.set(gameId, new Set());
    }
    this.gameConnections.get(gameId)!.add(connectionId);

    // Store avatar if provided
    if (playerAvatar) {
      await this.storePlayerAvatar(gameId, connectionId, playerAvatar);
    }

    try {
      // Add player to game
      const players = await this.gameAdapter.addPlayer(gameId, connectionId, playerName, isHost);
      
      // Get game data
      const gameData = await this.gameAdapter.getGameData(gameId);
      const avatars = await this.getGameAvatars(gameId);


      // Calculate totalRounds with logging
      const totalRounds = gameData?.totalRounds || gameData?.settings?.numberOfRounds || 3;
      
      // Prepare game data
      const gameDataToSend = {
        players,
        currentRound: gameData?.currentRound || 1,
        totalRounds: totalRounds,
        roundCountdown: gameData?.roundCountdown || 30,
        avatars: Object.fromEntries(avatars)
      };
      
      
      // Send game data to the new player
      this.sendMessage(ws, {
        type: 'gameData',
        data: gameDataToSend
      });

      // Notify all other players
      this.broadcastToGame(gameId, 'playerJoined', { players }, connectionId);
    } catch (error: any) {
      this.sendError(ws, error.message);
    }
  }

  private async handleRejoinGame(connectionId: string, ws: WebSocket, data: any) {
    const { gameId, playerName } = data;

    // Find existing player in game
    const players = await this.gameAdapter.getPlayers(gameId);
    const existingPlayer = players.find((p: any) => p.name === playerName);

    if (!existingPlayer) {
      this.sendError(ws, 'Player not found in game');
      return;
    }

    // Update connection mapping
    const oldConnectionId = existingPlayer.id;
    
    // Remove old connection if it exists
    const oldConnection = this.connections.get(oldConnectionId);
    if (oldConnection) {
      this.connections.delete(oldConnectionId);
      const gameConnections = this.gameConnections.get(gameId);
      if (gameConnections) {
        gameConnections.delete(oldConnectionId);
      }
    }

    // Create new connection
    const connection: PlayerConnection = {
      id: connectionId,
      ws,
      gameId,
      playerName,
      playerAvatar: existingPlayer.avatar,
      isHost: existingPlayer.isHost,
      isAlive: true
    };
    this.connections.set(connectionId, connection);

    // Add to game connections
    if (!this.gameConnections.has(gameId)) {
      this.gameConnections.set(gameId, new Set());
    }
    this.gameConnections.get(gameId)!.add(connectionId);

    // Update player ID in game
    await this.gameAdapter.updatePlayerId(gameId, oldConnectionId, connectionId);

    // Get game data
    const gameData = await this.gameAdapter.getGameData(gameId);
    const avatars = await this.getGameAvatars(gameId);


    // Calculate totalRounds with logging
    const totalRounds = gameData?.totalRounds || gameData?.settings?.numberOfRounds || 3;
    
    // Prepare game data
    const gameDataToSend = {
      players,
      currentRound: gameData?.currentRound || 1,
      totalRounds: totalRounds,
      roundCountdown: gameData?.roundCountdown || 30,
      avatars: Object.fromEntries(avatars)
    };
    
    
    // Send game data to the rejoined player
    this.sendMessage(ws, {
      type: 'gameData',
      data: gameDataToSend
    });
  }

  private async handleStartGame(connectionId: string, data: any) {
    const { gameId } = data;
    const connection = this.connections.get(connectionId);
    
    if (!connection || !connection.isHost) {
      return;
    }

    try {
      await this.gameAdapter.startGame(gameId);
      
      // Get updated game data
      const gameData = await this.gameAdapter.getGameData(gameId);
      
      // Notify all players with game data
      this.broadcastToGame(gameId, 'gameStarted', {
        totalRounds: gameData?.totalRounds || gameData?.settings?.numberOfRounds || 3,
        currentRound: gameData?.currentRound || 1,
        roundCountdown: gameData?.roundCountdown || 30
      });
      
      // Start first round after a delay
      setTimeout(async () => {
        const questionType = await this.gameAdapter.getNextQuestionType(gameId);
        this.broadcastToGame(gameId, 'roundStarting', { round: 1, questionType });
      }, 1000);
    } catch (error: any) {
      this.sendError(connection.ws, error.message);
    }
  }

  private async handleRequestQuestion(connectionId: string, data: any) {
    const { gameId, round } = data;
    const connection = this.connections.get(connectionId);
    
    if (!connection || !connection.isHost) {
      return;
    }

    try {
      // Get question from party game
      const questionData = await this.gameAdapter.getRandomQuestion(gameId);
      
      // Store current question
      await this.storeCurrentQuestion(gameId, questionData.question, questionData.track);
      
      // Clear previous answers
      await this.clearPlayerAnswers(gameId);
      
      // Broadcast question to all players
      this.broadcastToGame(gameId, 'questionStart', {
        question: questionData.question,
        trackInfo: questionData.track
      });
    } catch (error: any) {
      this.sendError(connection.ws, error.message);
    }
  }

  private async handleSubmitAnswer(connectionId: string, data: any) {
    const { gameId, answer, questionType } = data;
    const connection = this.connections.get(connectionId);
    
    if (!connection) {
      return;
    }

    try {
      // Store answer
      await this.storePlayerAnswer(gameId, connectionId, answer);
      
      // Notify all players that this player submitted
      this.broadcastToGame(gameId, 'playerSubmitted', { playerId: connectionId });
      
      // Check if all players have submitted
      const players = await this.gameAdapter.getPlayers(gameId);
      const answers = await this.getPlayerAnswers(gameId);
      
      if (answers.size === players.length) {
        // All answers submitted, calculate results
        await this.calculateAndShowResults(gameId);
      }
    } catch (error: any) {
      this.sendError(connection.ws, error.message);
    }
  }

  private async calculateAndShowResults(gameId: string) {
    const currentQuestion = await this.getCurrentQuestion(gameId);
    if (!currentQuestion) return;

    const answers = await this.getPlayerAnswers(gameId);
    const players = await this.gameAdapter.getPlayers(gameId);
    
    // Calculate results
    const results = await this.gameAdapter.calculateResults(
      gameId,
      currentQuestion.question,
      currentQuestion.track,
      Object.fromEntries(answers)
    );

    // Update scores
    for (const [playerId, points] of Object.entries(results.scores)) {
      await this.gameAdapter.updatePlayerScore(gameId, playerId, points as number);
    }

    // Get updated leaderboard
    const leaderboard = await this.gameAdapter.getLeaderboard(gameId);

    // Broadcast results
    this.broadcastToGame(gameId, 'showResults', {
      answers: results.answers,
      correctAnswer: results.correctAnswer
    });
  }

  private async handleShowLeaderboard(connectionId: string, data: any) {
    const { gameId } = data;
    const connection = this.connections.get(connectionId);
    
    if (!connection || !connection.isHost) {
      return;
    }

    const leaderboard = await this.gameAdapter.getLeaderboard(gameId);
    this.broadcastToGame(gameId, 'showLeaderboard', { leaderboard });
  }

  private async handleStartNextRound(connectionId: string, data: any) {
    const { gameId } = data;
    const connection = this.connections.get(connectionId);
    
    if (!connection || !connection.isHost) {
      return;
    }

    const gameData = await this.gameAdapter.getGameData(gameId);
    const nextRound = (gameData?.currentRound || 1) + 1;
    
    await this.gameAdapter.updateGameRound(gameId, nextRound);
    const questionType = await this.gameAdapter.getNextQuestionType(gameId);
    this.broadcastToGame(gameId, 'roundStarting', { round: nextRound, questionType });
  }

  private async handleShowFinalResults(connectionId: string, data: any) {
    const { gameId } = data;
    const connection = this.connections.get(connectionId);
    
    if (!connection || !connection.isHost) {
      return;
    }

    const topPlayers = await this.gameAdapter.getTopPlayers(gameId, 3);
    this.broadcastToGame(gameId, 'gameFinished', { topPlayers });
  }

  private async handleRestartGame(connectionId: string, data: any) {
    const { gameId } = data;
    const connection = this.connections.get(connectionId);
    
    if (!connection || !connection.isHost) {
      return;
    }

    await this.gameAdapter.resetGame(gameId);
    this.broadcastToGame(gameId, 'gameRestarted', {});
  }

  private handleDisconnect(connectionId: string) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const { gameId, isHost } = connection;

    // Remove from connections
    this.connections.delete(connectionId);
    
    // Remove from game connections
    const gameConnections = this.gameConnections.get(gameId);
    if (gameConnections) {
      gameConnections.delete(connectionId);
      
      // If no more connections for this game, clean up
      if (gameConnections.size === 0) {
        this.gameConnections.delete(gameId);
      }
    }

    // Handle player leaving
    this.handlePlayerLeave(gameId, connectionId, isHost);
  }

  private async handlePlayerLeave(gameId: string, playerId: string, isHost: boolean) {
    try {
      if (isHost) {
        // Host left, end the game
        this.broadcastToGame(gameId, 'hostLeft', {});
        await this.gameAdapter.endGame(gameId);
      } else {
        // Regular player left
        const players = await this.gameAdapter.removePlayer(gameId, playerId);
        this.broadcastToGame(gameId, 'playerLeft', { players });
      }
    } catch (error) {
      this.logger.log(`Error handling player leave: ${error}`);
    }
  }

  private broadcastToGame(gameId: string, type: string, data: any, excludeConnectionId?: string) {
    const message = { type, data };
    
    // Broadcast to local connections
    const gameConnectionIds = this.gameConnections.get(gameId);
    if (gameConnectionIds) {
      for (const connectionId of gameConnectionIds) {
        if (connectionId !== excludeConnectionId) {
          const connection = this.connections.get(connectionId);
          if (connection && connection.ws.readyState === WebSocket.OPEN) {
            this.sendMessage(connection.ws, message);
          }
        }
      }
    }

    // Publish to Redis for other servers
    this.publishRedisEvent(gameId, type, data, excludeConnectionId);
  }

  private sendMessage(ws: WebSocket, message: WebSocketMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(ws: WebSocket, error: string) {
    this.sendMessage(ws, { type: 'error', data: error });
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.connections.forEach((connection, connectionId) => {
        if (!connection.isAlive) {
          // Connection failed to respond to ping
          connection.ws.terminate();
          this.handleDisconnect(connectionId);
        } else {
          connection.isAlive = false;
          connection.ws.ping();
        }
      });
    }, 30000); // 30 seconds
  }

  private generateConnectionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // Helper methods for Redis storage
  private async storePlayerAnswer(gameId: string, playerId: string, answer: string): Promise<void> {
    await this.redis.hset(`game:${gameId}:answers`, playerId, answer);
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

  private async storeCurrentQuestion(gameId: string, question: any, track: any): Promise<void> {
    const data = JSON.stringify({ question, track });
    await this.redis.setex(`game:${gameId}:currentQuestion`, 60 * 60 * 4, data);
  }

  private async getCurrentQuestion(gameId: string): Promise<{ question: any; track: any } | null> {
    const data = await this.redis.get(`game:${gameId}:currentQuestion`);
    if (!data) return null;
    return JSON.parse(data);
  }

  private async storePlayerAvatar(gameId: string, playerId: string, avatar: string): Promise<void> {
    if (!this.playerAvatars.has(gameId)) {
      this.playerAvatars.set(gameId, new Map());
    }
    this.playerAvatars.get(gameId)!.set(playerId, avatar);
    
    await this.redis.hset(`game:${gameId}:avatars`, playerId, avatar);
    await this.redis.expire(`game:${gameId}:avatars`, 60 * 60 * 4);
  }

  private async getGameAvatars(gameId: string): Promise<Map<string, string>> {
    const avatars = await this.redis.hgetall(`game:${gameId}:avatars`);
    const map = new Map<string, string>();
    for (const [playerId, avatar] of Object.entries(avatars)) {
      map.set(playerId, avatar);
    }
    return map;
  }

  public close() {
    clearInterval(this.heartbeatInterval);
    this.redis.disconnect();
    this.pubClient.disconnect();
    this.subClient.disconnect();
    this.wss.close();
  }
}

export default NativeWebSocketServer;