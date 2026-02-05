import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { parse } from 'url';
import Redis from 'ioredis';
import Logger from './logger';
import { color, white } from 'console-log-colors';
import { BaseRoomState } from './game-plugins';

interface WebSocketMessage {
  type: string;
  data?: any;
}

interface RoomConnection {
  id: string;
  ws: WebSocket;
  roomId: string;
  isHost: boolean;
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
    const { type, roomId, ...data } = event;

    // Broadcast to all connections in the room
    const roomConnectionIds = this.roomConnections.get(roomId);
    if (roomConnectionIds) {
      for (const connectionId of roomConnectionIds) {
        const connection = this.connections.get(connectionId);
        if (connection && connection.ws.readyState === WebSocket.OPEN) {
          this.sendMessage(connection.ws, { type, data });
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

    if (isHost) {
      this.logger.logDev(
        color.yellow.bold(`[Game WS] Host disconnected from room ${white.bold(roomId)}`)
      );
      // Note: We don't end the room on host disconnect - they might reconnect
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
    if (roomConnectionIds) {
      for (const connectionId of roomConnectionIds) {
        if (connectionId !== excludeConnectionId) {
          const connection = this.connections.get(connectionId);
          if (connection && connection.ws.readyState === WebSocket.OPEN) {
            this.sendMessage(connection.ws, message);
          }
        }
      }
    }

    // Publish to Redis for other servers
    this.pubClient.publish(
      'game-room-events',
      JSON.stringify({ type, roomId, ...data })
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
