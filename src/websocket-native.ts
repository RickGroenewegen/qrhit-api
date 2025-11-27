import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import Logger from './logger';
import { QuizWebSocketHandler, QuizBroadcaster } from './games/quiz-card';

interface WebSocketMessage {
  type: string;
  data?: any;
}

class NativeWebSocketServer implements QuizBroadcaster {
  private wss: WebSocketServer;
  private logger: Logger;
  private redis: Redis;
  private pubClient: Redis;
  private subClient: Redis;
  private heartbeatInterval!: NodeJS.Timeout;

  // Quiz game WebSocket handler (handles all quiz-specific logic)
  private quizHandler: QuizWebSocketHandler;

  constructor(server: HTTPServer) {
    this.wss = new WebSocketServer({
      noServer: true,
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
    this.logger = new Logger();
    this.quizHandler = new QuizWebSocketHandler(this);

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

    // Handle quiz-specific events (gameId format: quiz:GAMEID)
    if (gameId.startsWith('quiz:')) {
      const quizGameId = gameId.replace('quiz:', '');
      this.quizHandler.handleRedisEvent(quizGameId, type, data, excludeConnectionId);
    }
  }

  // Public for QuizBroadcaster interface
  public publishRedisEvent(gameId: string, type: string, data: any, excludeConnectionId?: string) {
    const event = { gameId, type, data, excludeConnectionId };
    this.pubClient.publish('game-events', JSON.stringify(event));
  }

  private initializeHandlers() {
    this.wss.on('connection', (ws: WebSocket) => {
      const connectionId = this.generateConnectionId();

      // Set up ping/pong for connection health
      ws.on('pong', () => {
        this.quizHandler.markConnectionAlive(connectionId);
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

    // Delegate quiz messages to the quiz handler
    if (this.quizHandler.isQuizMessage(type)) {
      await this.quizHandler.handleMessage(connectionId, ws, type, data);
      return;
    }

    switch (type) {
      case 'ping':
        this.sendMessage(ws, { type: 'pong' });
        break;

      default:
        this.sendError(ws, `Unknown message type: ${type}`);
    }
  }

  // Public method for triggering quiz rounds from external sources
  public async triggerQuizRound(gameId: string, round: number, timerDuration: number) {
    await this.quizHandler.triggerRound(gameId, round, timerDuration);
  }

  // Check if quiz game has connections
  public hasQuizGameConnections(gameId: string): boolean {
    return this.quizHandler.hasConnections(gameId);
  }

  private handleDisconnect(connectionId: string) {
    // Check if this is a quiz connection
    const quizConnection = this.quizHandler.getConnection(connectionId);
    if (quizConnection) {
      this.quizHandler.handleDisconnect(connectionId);
      return;
    }
  }

  // Public for QuizBroadcaster interface
  public sendMessage(ws: WebSocket, message: WebSocketMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(ws: WebSocket, error: string) {
    this.sendMessage(ws, { type: 'error', data: error });
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      // Check quiz connections
      this.quizHandler.checkHeartbeat((connectionId) => {
        this.handleDisconnect(connectionId);
      });
    }, 30000); // 30 seconds
  }

  private generateConnectionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
