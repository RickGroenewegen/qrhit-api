import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { parse } from 'url';
import Redis from 'ioredis';
import Logger from './logger';
import { color, white } from 'console-log-colors';
import { BaseRoomState } from './game-plugins';
import CacheInstance from './cache';

interface WebSocketMessage {
  type: string;
  data?: any;
}

interface RoomConnection {
  id: string;
  ws: WebSocket;
  roomId: string;
  isHost: boolean;
  role: 'host' | 'hostApp' | 'player';
  isAlive: boolean;
}

class NativeWebSocketServer {
  private wss: WebSocketServer;
  private connections: Map<string, RoomConnection> = new Map();
  private roomConnections: Map<string, Set<string>> = new Map();
  private logger: Logger;
  private redis: Redis;
  private pubClient: Redis;
  private subClient: Redis;
  private heartbeatInterval!: NodeJS.Timeout;
  private serverId: string = Math.random().toString(36).substring(2, 10);

  constructor(_server: HTTPServer) {
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: {
        zlibDeflateOptions: {
          chunkSize: 1024,
          memLevel: 7,
          level: 3,
        },
        zlibInflateOptions: {
          chunkSize: 10 * 1024,
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 1024,
      },
    });

    this.logger = new Logger();

    // Set up Redis for distributed support
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not defined');
    }

    // Initialize Redis clients - use DB 1 for game rooms (same as gameRoutes.ts)
    this.redis = new Redis(redisUrl, { db: 1 });
    this.pubClient = new Redis(redisUrl, { db: 1 });
    this.subClient = this.pubClient.duplicate();

    // Set up Redis pub/sub for cross-server communication
    this.setupRedisPubSub();

    // Initialize WebSocket handlers
    this.initializeHandlers();

    // Start heartbeat
    this.startHeartbeat();
  }

  private setupRedisPubSub() {
    // Subscribe to game room events
    this.subClient.subscribe('game-room-events', (err) => {
      if (err) {
        this.logger.logDev(`Failed to subscribe to game-room-events: ${err.message}`);
      }
    });

    this.subClient.on('message', async (channel, message) => {
      if (channel === 'game-room-events') {
        try {
          const event = JSON.parse(message);
          await this.handleRedisEvent(event);
        } catch (error) {
          this.logger.logDev(`Error handling Redis event: ${error}`);
        }
      }
    });
  }

  private async handleRedisEvent(event: any) {
    const { type, roomId, data, serverId } = event;

    // Skip messages from this server (already broadcast locally)
    if (serverId === this.serverId) return;

    // Re-broadcast to local connections for messages from other servers
    const roomConnectionIds = this.roomConnections.get(roomId);
    if (roomConnectionIds) {
      const message = { type, data };
      for (const connectionId of roomConnectionIds) {
        const connection = this.connections.get(connectionId);
        if (connection && connection.ws.readyState === WebSocket.OPEN) {
          this.sendMessage(connection.ws, message);
        }
      }
    }
  }

  private initializeHandlers() {
    this.wss.on('connection', (ws: WebSocket, request) => {
      const connectionId = this.generateConnectionId();

      // Parse query parameters
      const { query } = parse(request.url || '', true);
      const queryRoomId = query.roomId as string | undefined;

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
          await this.handleMessage(connectionId, ws, data, queryRoomId);
        } catch (error) {
          this.logger.logDev(`Error processing message: ${error}`);
          this.sendError(ws, 'Invalid message format');
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(connectionId);
      });

      ws.on('error', (error) => {
        this.logger.logDev(`WebSocket error for ${connectionId}: ${error}`);
      });

      // Send initial connection acknowledgment
      this.sendMessage(ws, { type: 'connected', data: { connectionId } });
    });
  }

  private async handleMessage(
    connectionId: string,
    ws: WebSocket,
    message: WebSocketMessage,
    queryRoomId?: string
  ) {
    const { type, data } = message;

    switch (type) {
      case 'joinRoom':
        await this.handleJoinRoom(connectionId, ws, data);
        break;
      case 'updatePluginData':
        await this.handleUpdatePluginData(connectionId, data);
        break;
      case 'endRoom':
        await this.handleEndRoom(connectionId, data);
        break;
      case 'quizJoinPlayer':
        await this.handleQuizJoinPlayer(connectionId, ws, data);
        break;
      case 'quizAnswer':
        await this.handleQuizAnswer(connectionId, ws, data);
        break;
      case 'quizHostAction':
        await this.handleQuizHostAction(connectionId, data);
        break;
      case 'quizJoinHostApp':
        await this.handleQuizJoinHostApp(connectionId, ws, data);
        break;
      case 'ping':
        this.sendMessage(ws, { type: 'pong' });
        break;
      default:
        // Unknown message types are ignored (plugins may add their own)
        this.logger.logDev(`[WS] Unknown message type: ${type}`);
    }
  }

  private async handleJoinRoom(connectionId: string, ws: WebSocket, data: any) {
    const { roomId, isHost } = data;

    // Verify room exists
    const roomData = await this.redis.get(`room:${roomId}`);
    if (!roomData) {
      this.sendError(ws, 'Room not found');
      return;
    }

    const room: BaseRoomState = JSON.parse(roomData);

    // Clean up from any previous room this connection was in
    const existingConnection = this.connections.get(connectionId);
    if (existingConnection && existingConnection.roomId !== roomId) {
      const oldRoomConnections = this.roomConnections.get(existingConnection.roomId);
      if (oldRoomConnections) {
        oldRoomConnections.delete(connectionId);
        if (oldRoomConnections.size === 0) {
          this.roomConnections.delete(existingConnection.roomId);
        }
      }
    }

    // Store connection info
    const connection: RoomConnection = {
      id: connectionId,
      ws,
      roomId,
      isHost: isHost || false,
      role: isHost ? 'host' : 'player',
      isAlive: true,
    };
    this.connections.set(connectionId, connection);

    // Add to room connections
    if (!this.roomConnections.has(roomId)) {
      this.roomConnections.set(roomId, new Set());
    }
    this.roomConnections.get(roomId)!.add(connectionId);

    this.logger.logDev(
      color.green.bold(
        `[Game WS] ${isHost ? 'Host' : 'Player'} joined ${white.bold(room.type)} room ${white.bold(roomId)}`
      )
    );

    // Send room state to the new connection
    this.sendMessage(ws, {
      type: 'roomJoined',
      data: {
        roomId: room.uuid,
        type: room.type,
        state: room.state,
        pluginData: room.pluginData,
      },
    });
  }

  private async handleUpdatePluginData(connectionId: string, data: any) {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.isHost) {
      return;
    }

    const { roomId, pluginData } = data;

    // Update room state in Redis
    const roomData = await this.redis.get(`room:${roomId}`);
    if (!roomData) return;

    const room: BaseRoomState = JSON.parse(roomData);
    room.pluginData = { ...room.pluginData, ...pluginData };
    room.lastActivity = Date.now();
    await this.redis.set(`room:${roomId}`, JSON.stringify(room), 'EX', 4 * 60 * 60);

    // Broadcast to room
    this.broadcastToRoom(roomId, 'pluginDataChanged', { pluginData: room.pluginData });
  }

  private async handleEndRoom(connectionId: string, data: any) {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.isHost) {
      return;
    }

    const { roomId } = data;

    // Update room state in Redis
    const roomData = await this.redis.get(`room:${roomId}`);
    if (!roomData) return;

    const room: BaseRoomState = JSON.parse(roomData);
    room.state = 'ended';
    room.lastActivity = Date.now();
    await this.redis.set(`room:${roomId}`, JSON.stringify(room), 'EX', 4 * 60 * 60);

    // Broadcast to room
    this.broadcastToRoom(roomId, 'roomEnded', {});

    this.logger.logDev(color.blue.bold(`[Game WS] Room ${white.bold(roomId)} ended by host`));
  }

  // --- Quiz WebSocket Handlers ---

  private async handleQuizJoinPlayer(connectionId: string, ws: WebSocket, data: any) {
    const { roomId, playerName } = data;

    if (!roomId || !playerName) {
      this.sendError(ws, 'roomId and playerName required');
      return;
    }

    // Verify room exists and is a quiz room
    const roomData = await this.redis.get(`room:${roomId}`);
    if (!roomData) {
      this.sendError(ws, 'Room not found');
      return;
    }

    const room: BaseRoomState = JSON.parse(roomData);
    if (room.type !== 'quiz') {
      this.sendError(ws, 'Not a quiz room');
      return;
    }

    if (room.pluginData.phase !== 'lobby') {
      this.sendError(ws, 'Quiz already started');
      return;
    }

    // Store connection info (player, not host)
    const connection: RoomConnection = {
      id: connectionId,
      ws,
      roomId,
      isHost: false,
      role: 'player',
      isAlive: true,
    };
    this.connections.set(connectionId, connection);

    // Add to room connections
    if (!this.roomConnections.has(roomId)) {
      this.roomConnections.set(roomId, new Set());
    }
    this.roomConnections.get(roomId)!.add(connectionId);

    // Add player to room state
    room.pluginData.players[connectionId] = {
      name: playerName,
      score: 0,
      connected: true,
    };
    room.pluginData.answers[connectionId] = [];
    room.lastActivity = Date.now();
    await this.redis.set(`room:${roomId}`, JSON.stringify(room), 'EX', 4 * 60 * 60);

    const players = Object.entries(room.pluginData.players).map(([id, p]: [string, any]) => ({
      id,
      name: p.name,
      score: p.score,
    }));

    this.logger.logDev(
      color.green.bold(`[Quiz WS] Player "${white.bold(playerName)}" joined room ${white.bold(roomId)}`)
    );

    // Confirm to the joining player
    this.sendMessage(ws, {
      type: 'quizJoinedConfirm',
      data: { connectionId, playerName },
    });

    // Broadcast to all in room
    this.broadcastToRoom(roomId, 'quizPlayerJoined', {
      playerName,
      playerCount: players.length,
      players,
    });
  }

  private async handleQuizAnswer(connectionId: string, ws: WebSocket, data: any) {
    const { roomId, questionIndex, answer } = data;

    const roomData = await this.redis.get(`room:${roomId}`);
    if (!roomData) return;

    const room: BaseRoomState = JSON.parse(roomData);
    if (room.type !== 'quiz' || room.pluginData.phase !== 'question') return;

    // Verify correct question index
    if (questionIndex !== room.pluginData.currentQuestionIndex) return;

    // Check if player already answered this question
    const playerAnswers = room.pluginData.answers[connectionId] || [];
    if (playerAnswers.length > questionIndex) return; // Already answered

    // Get quiz data from cache
    const cache = CacheInstance.getInstance();
    const quizCacheData = await cache.get(room.pluginData.quizCacheKey, false);
    if (!quizCacheData) return;

    const quizData = JSON.parse(quizCacheData);
    const question = quizData.questions[questionIndex];
    if (!question) return;

    // Calculate score using Kahoot-style formula:
    // score = round( (1 - (responseTime / questionTimer / 2)) * pointsPossible )
    // If response < 0.5s, award max points
    const elapsed = (Date.now() - room.pluginData.questionStartedAt) / 1000;
    const timerSeconds = room.pluginData.timerSeconds;
    const pointsPossible = 1000;
    let score = 0;
    let correct = false;

    const kahootScore = (maxPoints: number) => {
      if (elapsed < 0.5) return maxPoints;
      return Math.round((1 - (elapsed / timerSeconds / 2)) * maxPoints);
    };

    if (question.type === 'year') {
      // Year: proximity scoring — each year off loses 10%, more than 10 off = 0
      const diff = Math.abs(parseInt(answer) - parseInt(question.correctAnswer));
      correct = diff === 0;
      const proximityFactor = Math.max(0, 1 - diff / 10);
      if (proximityFactor > 0) {
        score = kahootScore(Math.round(pointsPossible * proximityFactor));
      }
    } else if (question.type === 'release_order') {
      // Release order: correctAnswer is an index, answer is the option text
      const selectedIndex = (question.options || []).indexOf(answer);
      correct = selectedIndex === parseInt(question.correctAnswer);
      if (correct) {
        score = kahootScore(pointsPossible);
      }
    } else {
      // MC types: correct/wrong
      correct = answer === question.correctAnswer;
      if (correct) {
        score = kahootScore(pointsPossible);
      }
    }

    // Store answer
    while (playerAnswers.length < questionIndex) {
      playerAnswers.push({ answer: '', answeredAt: 0, score: 0, correct: false });
    }
    playerAnswers.push({ answer, answeredAt: Date.now(), score, correct });
    room.pluginData.answers[connectionId] = playerAnswers;

    // Update player score
    if (room.pluginData.players[connectionId]) {
      room.pluginData.players[connectionId].score += score;
    }

    room.lastActivity = Date.now();
    await this.redis.set(`room:${roomId}`, JSON.stringify(room), 'EX', 4 * 60 * 60);

    // Send result to the answering player only
    this.sendMessage(ws, {
      type: 'quizAnswerResult',
      data: {
        correct,
        score,
        totalScore: room.pluginData.players[connectionId]?.score || 0,
      },
    });

    // Count answered players
    const totalPlayers = Object.keys(room.pluginData.players).filter(
      (id) => room.pluginData.players[id].connected
    ).length;
    const answeredCount = Object.keys(room.pluginData.answers).filter(
      (id) => (room.pluginData.answers[id]?.length || 0) > questionIndex
    ).length;

    // Broadcast answer count to all
    this.broadcastToRoom(roomId, 'quizAnswerCount', {
      answeredCount,
      totalPlayers,
    });

    // All players answered — notify host to auto-reveal
    if (answeredCount >= totalPlayers && totalPlayers > 0) {
      this.broadcastToRoom(roomId, 'quizAllAnswered', {});
    }

    this.logger.logDev(
      color.blue.bold(
        `[Quiz WS] Answer from ${white.bold(connectionId)}: ${correct ? 'correct' : 'wrong'} (+${score}) [${answeredCount}/${totalPlayers}]`
      )
    );
  }

  private async handleQuizHostAction(connectionId: string, data: any) {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.isHost) return;

    const { roomId, action } = data;
    const roomData = await this.redis.get(`room:${roomId}`);
    if (!roomData) return;

    const room: BaseRoomState = JSON.parse(roomData);
    if (room.type !== 'quiz') return;

    // Get quiz data from cache
    const cache = CacheInstance.getInstance();
    const quizCacheData = await cache.get(room.pluginData.quizCacheKey, false);
    if (!quizCacheData) return;
    const quizData = JSON.parse(quizCacheData);

    switch (action) {
      case 'startQuiz': {
        room.pluginData.phase = 'announce';
        room.pluginData.currentQuestionIndex = 0;
        const nextQ = quizData.questions[0];
        room.lastActivity = Date.now();
        await this.redis.set(`room:${roomId}`, JSON.stringify(room), 'EX', 4 * 60 * 60);

        // Debug: log all room connections
        const roomConns = this.roomConnections.get(roomId);
        this.logger.logDev(color.blue.bold(`[Quiz WS] startQuiz — room ${white.bold(roomId)} has ${roomConns?.size || 0} connections:`));
        if (roomConns) {
          for (const cid of roomConns) {
            const conn = this.connections.get(cid);
            this.logger.logDev(color.blue(`  → ${cid} role=${conn?.role} isHost=${conn?.isHost} wsOpen=${conn?.ws.readyState === WebSocket.OPEN}`));
          }
        }

        // Broadcast announce to all (host + players + app)
        // Include trackDbId so app can auto-play the track
        this.broadcastToRoom(roomId, 'quizAnnounce', {
          questionIndex: 0,
          total: quizData.questions.length,
          type: nextQ?.type,
          trackName: nextQ?.trackName,
          trackArtist: nextQ?.trackArtist,
          trackDbId: nextQ?.trackId,
        });
        break;
      }

      case 'showQuestion': {
        room.pluginData.phase = 'question';
        room.pluginData.questionStartedAt = Date.now();
        const qi = room.pluginData.currentQuestionIndex;
        const q = quizData.questions[qi];
        room.lastActivity = Date.now();
        await this.redis.set(`room:${roomId}`, JSON.stringify(room), 'EX', 4 * 60 * 60);
        this.broadcastToRoom(roomId, 'quizQuestion', {
          questionIndex: qi,
          total: quizData.questions.length,
          type: q.type,
          question: q.question,
          options: q.options,
          timerSeconds: room.pluginData.timerSeconds,
        });
        break;
      }

      case 'showReveal': {
        room.pluginData.phase = 'reveal';
        const qi2 = room.pluginData.currentQuestionIndex;
        const q2 = quizData.questions[qi2];
        room.lastActivity = Date.now();
        await this.redis.set(`room:${roomId}`, JSON.stringify(room), 'EX', 4 * 60 * 60);

        // Compute answer distribution for MC/release_order questions
        const answerCounts: Record<string, number> = {};
        if (q2.options && q2.options.length > 0) {
          // Initialize all options to 0
          for (const opt of q2.options) {
            answerCounts[opt] = 0;
          }
          // Count player answers for this question
          for (const [, playerAnswers] of Object.entries(room.pluginData.answers) as [string, any[]][]) {
            if (playerAnswers && playerAnswers[qi2]) {
              const ans = playerAnswers[qi2].answer;
              if (ans in answerCounts) {
                answerCounts[ans]++;
              }
            }
          }
        }

        // Tell the app to stop playback when answer is revealed
        this.broadcastToRoom(roomId, 'quizStopTrack', { trackDbId: q2.trackId });

        this.broadcastToRoom(roomId, 'quizReveal', {
          correctAnswer: q2.correctAnswer,
          trackName: q2.trackName,
          trackArtist: q2.trackArtist,
          trackYear: q2.trackYear,
          type: q2.type,
          options: q2.options,
          answerCounts,
        });
        break;
      }

      case 'showRanking': {
        const previousRankings = room.pluginData.previousRankings || [];
        const rankings = Object.entries(room.pluginData.players)
          .map(([id, p]: [string, any]) => {
            // Calculate streak from answers
            const answers = room.pluginData.answers[id] || [];
            let streak = 0;
            for (let i = answers.length - 1; i >= 0; i--) {
              if (answers[i].correct) streak++;
              else break;
            }
            return { id, name: p.name, score: p.score, streak };
          })
          .sort((a, b) => b.score - a.score);

        room.pluginData.previousRankings = rankings.map((r: any) => ({ id: r.id, name: r.name, score: r.score }));
        room.pluginData.phase = 'ranking';
        room.lastActivity = Date.now();
        await this.redis.set(`room:${roomId}`, JSON.stringify(room), 'EX', 4 * 60 * 60);
        this.broadcastToRoom(roomId, 'quizRanking', { rankings, previousRankings });
        break;
      }

      case 'nextQuestion':
      case 'nextScan': {
        const nextIdx = room.pluginData.currentQuestionIndex + 1;
        if (nextIdx >= quizData.questions.length) {
          // Final
          room.pluginData.phase = 'final';
          const finalRankings = Object.entries(room.pluginData.players)
            .map(([id, p]: [string, any]) => ({ id, name: p.name, score: p.score }))
            .sort((a, b) => b.score - a.score);
          room.lastActivity = Date.now();
          await this.redis.set(`room:${roomId}`, JSON.stringify(room), 'EX', 4 * 60 * 60);
          this.broadcastToRoom(roomId, 'quizFinal', { rankings: finalRankings });
        } else {
          room.pluginData.phase = 'announce';
          room.pluginData.currentQuestionIndex = nextIdx;
          const nextQ = quizData.questions[nextIdx];
          room.lastActivity = Date.now();
          await this.redis.set(`room:${roomId}`, JSON.stringify(room), 'EX', 4 * 60 * 60);

          // Include trackDbId so app can auto-play the track
          this.broadcastToRoom(roomId, 'quizAnnounce', {
            questionIndex: nextIdx,
            total: quizData.questions.length,
            type: nextQ?.type,
            trackName: nextQ?.trackName,
            trackArtist: nextQ?.trackArtist,
            trackDbId: nextQ?.trackId,
          });
        }
        break;
      }

      case 'endQuiz': {
        room.state = 'ended';
        room.lastActivity = Date.now();
        await this.redis.set(`room:${roomId}`, JSON.stringify(room), 'EX', 4 * 60 * 60);
        this.broadcastToRoom(roomId, 'roomEnded', {});
        this.logger.logDev(color.blue.bold(`[Quiz WS] Quiz ended in room ${white.bold(roomId)}`));
        break;
      }
    }
  }

  private async handleQuizJoinHostApp(connectionId: string, ws: WebSocket, data: any) {
    const { roomId } = data;

    if (!roomId) {
      this.sendError(ws, 'roomId required');
      return;
    }

    // Verify room exists and is a quiz room
    const roomData = await this.redis.get(`room:${roomId}`);
    if (!roomData) {
      this.sendError(ws, 'Room not found');
      return;
    }

    const room: BaseRoomState = JSON.parse(roomData);
    if (room.type !== 'quiz') {
      this.sendError(ws, 'Not a quiz room');
      return;
    }

    // Store connection with hostApp role
    const connection: RoomConnection = {
      id: connectionId,
      ws,
      roomId,
      isHost: false,
      role: 'hostApp',
      isAlive: true,
    };
    this.connections.set(connectionId, connection);

    // Add to room connections
    if (!this.roomConnections.has(roomId)) {
      this.roomConnections.set(roomId, new Set());
    }
    this.roomConnections.get(roomId)!.add(connectionId);

    // Persist hostAppConnected flag so host can detect on reconnect
    room.pluginData.hostAppConnected = true;
    room.lastActivity = Date.now();
    await this.redis.set(`room:${roomId}`, JSON.stringify(room), 'EX', 4 * 60 * 60);

    this.logger.logDev(
      color.green.bold(`[Quiz WS] Host app connected to room ${white.bold(roomId)}`)
    );

    // Confirm to the app
    this.sendMessage(ws, {
      type: 'quizHostAppConfirm',
      data: { roomId, quizName: room.pluginData.quizName },
    });

    // Broadcast to room (so host sees connection indicator)
    this.broadcastToRoom(roomId, 'quizHostAppConnected', {});
  }

  private handleDisconnect(connectionId: string) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const { roomId, isHost } = connection;

    // Remove from connections
    this.connections.delete(connectionId);

    // Remove from room connections
    const roomConnections = this.roomConnections.get(roomId);
    if (roomConnections) {
      roomConnections.delete(connectionId);

      // If no more connections for this room, clean up
      if (roomConnections.size === 0) {
        this.roomConnections.delete(roomId);
      }
    }

    if (connection.role === 'hostApp') {
      this.logger.logDev(
        color.yellow.bold(`[Game WS] Host app disconnected from room ${white.bold(roomId)}`)
      );
      // Clear persisted flag
      this.redis.get(`room:${roomId}`).then(rd => {
        if (rd) {
          const r = JSON.parse(rd) as BaseRoomState;
          r.pluginData.hostAppConnected = false;
          this.redis.set(`room:${roomId}`, JSON.stringify(r), 'EX', 4 * 60 * 60);
        }
      }).catch(() => {});
      this.broadcastToRoom(roomId, 'quizHostAppDisconnected', {});
    } else if (isHost) {
      this.logger.logDev(
        color.yellow.bold(`[Game WS] Host disconnected from room ${white.bold(roomId)}`)
      );
      // Note: We don't end the room on host disconnect - they might reconnect
    } else {
      // For quiz rooms: mark player as disconnected
      this.markQuizPlayerDisconnected(connectionId, roomId);
    }
  }

  private async markQuizPlayerDisconnected(connectionId: string, roomId: string) {
    try {
      const roomData = await this.redis.get(`room:${roomId}`);
      if (!roomData) return;

      const room: BaseRoomState = JSON.parse(roomData);
      if (room.type !== 'quiz') return;

      if (room.pluginData.players[connectionId]) {
        const playerName = room.pluginData.players[connectionId].name;
        room.pluginData.players[connectionId].connected = false;
        await this.redis.set(`room:${roomId}`, JSON.stringify(room), 'EX', 4 * 60 * 60);

        const connectedCount = Object.values(room.pluginData.players).filter(
          (p: any) => p.connected
        ).length;

        this.broadcastToRoom(roomId, 'quizPlayerDisconnected', {
          playerName,
          playerCount: connectedCount,
        });

        this.logger.logDev(
          color.yellow.bold(`[Quiz WS] Player "${white.bold(playerName)}" disconnected from room ${white.bold(roomId)}`)
        );
      }
    } catch (error) {
      this.logger.logDev(`[Quiz WS] Error marking player disconnected: ${error}`);
    }
  }

  private broadcastToRoom(
    roomId: string,
    type: string,
    data: any,
    excludeConnectionId?: string
  ) {
    const message = { type, data };

    // Broadcast to local connections
    const roomConnectionIds = this.roomConnections.get(roomId);
    let sentCount = 0;
    if (roomConnectionIds) {
      for (const connectionId of roomConnectionIds) {
        if (connectionId !== excludeConnectionId) {
          const connection = this.connections.get(connectionId);
          if (connection && connection.ws.readyState === WebSocket.OPEN) {
            this.sendMessage(connection.ws, message);
            sentCount++;
          }
        }
      }
    }

    if (type.startsWith('quiz')) {
      const roles = roomConnectionIds
        ? Array.from(roomConnectionIds).map(id => {
            const c = this.connections.get(id);
            return c ? `${c.role}(${c.ws.readyState === WebSocket.OPEN ? 'open' : 'closed'})` : 'gone';
          }).join(', ')
        : 'none';
      this.logger.logDev(color.blue(`[Quiz WS] broadcastToRoom ${type} to ${sentCount}/${roomConnectionIds?.size || 0} connections [${roles}] in room ${roomId}`));
    }

    // Publish to Redis for other servers (nest data to avoid field collisions)
    this.pubClient.publish(
      'game-room-events',
      JSON.stringify({ type, roomId, data, serverId: this.serverId })
    );
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
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  public close() {
    clearInterval(this.heartbeatInterval);
    this.redis.disconnect();
    this.pubClient.disconnect();
    this.subClient.disconnect();
    this.wss.close();
  }

  public handleUpgrade(request: any, socket: any, head: any) {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
  }
}

export default NativeWebSocketServer;
