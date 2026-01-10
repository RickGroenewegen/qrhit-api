import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import Logger from './logger';

interface ProgressConnection {
  ws: WebSocket;
  playlistId: string;
  serviceType: string;
  requestId: string;  // Unique ID to isolate concurrent requests
  isAlive: boolean;
}

interface ProgressData {
  stage?: 'fetching_ids' | 'fetching_metadata' | 'enriching';
  percentage: number;
  message?: string;
  current?: number;
  total?: number;
  trackCount?: number;
  error?: string;
}

class ProgressWebSocketServer {
  private wss: WebSocketServer;
  private connections: Map<string, ProgressConnection> = new Map();
  private logger: Logger;
  private heartbeatInterval!: NodeJS.Timeout;
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;

  constructor(server: HTTPServer) {
    this.wss = new WebSocketServer({
      noServer: true,
    });

    this.logger = new Logger();

    // Set up Redis for cross-worker communication
    this.setupRedisPubSub();

    this.initializeHandlers();
    this.startHeartbeat();
  }

  private setupRedisPubSub() {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.log('[ProgressWS] REDIS_URL not set, cross-worker messaging disabled');
      return;
    }

    try {
      this.pubClient = new Redis(redisUrl);
      this.subClient = new Redis(redisUrl);

      this.subClient.subscribe('progress-events', (err) => {
        if (err) {
          this.logger.log(`[ProgressWS] Failed to subscribe to progress-events: ${err.message}`);
        }
      });

      this.subClient.on('message', (channel, message) => {
        if (channel === 'progress-events') {
          try {
            const event = JSON.parse(message);
            this.handleRedisEvent(event);
          } catch (error) {
            this.logger.log(`[ProgressWS] Error handling Redis event: ${error}`);
          }
        }
      });

    } catch (error) {
      this.logger.log(`[ProgressWS] Failed to initialize Redis: ${error}`);
    }
  }

  private handleRedisEvent(event: { playlistId: string; serviceType: string; requestId: string; type: string; data: ProgressData }) {
    const key = `${event.playlistId}:${event.serviceType}:${event.requestId}`;
    // Broadcast to all local connections for this specific request
    this.connections.forEach((connection, connectionId) => {
      const connKey = `${connection.playlistId}:${connection.serviceType}:${connection.requestId}`;
      if (connKey === key && connection.ws.readyState === WebSocket.OPEN) {
        this.sendMessage(connection.ws, { type: event.type, playlistId: event.playlistId, serviceType: event.serviceType, requestId: event.requestId, data: event.data });
      }
    });
  }

  private publishProgressEvent(playlistId: string, serviceType: string, requestId: string, type: string, data: ProgressData) {
    if (this.pubClient) {
      this.pubClient.publish('progress-events', JSON.stringify({ playlistId, serviceType, requestId, type, data }));
    } else {
      // Local broadcast fallback
      const key = `${playlistId}:${serviceType}:${requestId}`;
      this.connections.forEach((connection) => {
        const connKey = `${connection.playlistId}:${connection.serviceType}:${connection.requestId}`;
        if (connKey === key && connection.ws.readyState === WebSocket.OPEN) {
          this.sendMessage(connection.ws, { type, playlistId, serviceType, requestId, data });
        }
      });
    }
  }

  private initializeHandlers() {
    this.wss.on('connection', async (ws: WebSocket, request: any) => {
      const connectionId = this.generateConnectionId();

      // Extract params from query string
      const url = new URL(request.url || '', 'http://localhost');
      const playlistId = url.searchParams.get('playlistId');
      const serviceType = url.searchParams.get('serviceType');
      const requestId = url.searchParams.get('requestId');

      // Validate required params
      if (!playlistId || !serviceType || !requestId) {
        this.sendError(ws, 'playlistId, serviceType, and requestId are required');
        ws.close();
        return;
      }

      const connection: ProgressConnection = {
        ws,
        playlistId,
        serviceType,
        requestId,
        isAlive: true,
      };
      this.connections.set(connectionId, connection);

      // Set up ping/pong for connection health
      ws.on('pong', () => {
        const conn = this.connections.get(connectionId);
        if (conn) {
          conn.isAlive = true;
        }
      });

      ws.on('message', async (message: Buffer) => {
        try {
          const data = JSON.parse(message.toString());
          // Handle ping from client
          if (data.type === 'ping') {
            this.sendMessage(ws, { type: 'pong' });
          }
        } catch (error) {
          // Ignore invalid messages
        }
      });

      ws.on('close', () => {
        this.connections.delete(connectionId);
      });

      ws.on('error', (error) => {
        this.logger.log(`[ProgressWS] WebSocket error for ${connectionId}: ${error}`);
      });

      // Send connected confirmation
      this.sendMessage(ws, { type: 'connected', playlistId, serviceType, requestId, data: {} });
    });
  }

  /**
   * Broadcast progress update for a playlist (called from routes)
   * @param requestId Unique ID to isolate this specific request from concurrent requests
   */
  public broadcastProgress(playlistId: string, serviceType: string, requestId: string, data: ProgressData) {
    this.publishProgressEvent(playlistId, serviceType, requestId, 'progress', data);
  }

  /**
   * Broadcast completion event for a playlist
   * @param requestId Unique ID to isolate this specific request from concurrent requests
   */
  public broadcastComplete(playlistId: string, serviceType: string, requestId: string, data: { trackCount?: number }) {
    this.publishProgressEvent(playlistId, serviceType, requestId, 'complete', {
      percentage: 100,
      message: 'Complete',
      trackCount: data.trackCount,
    });
  }

  /**
   * Broadcast error event for a playlist
   * @param requestId Unique ID to isolate this specific request from concurrent requests
   */
  public broadcastError(playlistId: string, serviceType: string, requestId: string, error?: string) {
    this.publishProgressEvent(playlistId, serviceType, requestId, 'error', {
      percentage: 0,
      message: error || 'An error occurred',
      error: error,
    });
  }

  /**
   * Get singleton instance for broadcasting from routes
   */
  private static instance: ProgressWebSocketServer | null = null;

  public static getInstance(): ProgressWebSocketServer | null {
    return ProgressWebSocketServer.instance;
  }

  public static setInstance(instance: ProgressWebSocketServer) {
    ProgressWebSocketServer.instance = instance;
  }

  private sendMessage(ws: WebSocket, message: any) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(ws: WebSocket, error: string) {
    this.sendMessage(ws, { type: 'error', data: { error } });
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.connections.forEach((connection, connectionId) => {
        if (!connection.isAlive) {
          connection.ws.terminate();
          this.connections.delete(connectionId);
        } else {
          connection.isAlive = false;
          connection.ws.ping();
        }
      });
    }, 30000);
  }

  private generateConnectionId(): string {
    return `progress-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  public close() {
    clearInterval(this.heartbeatInterval);
    this.wss.close();
  }

  public handleUpgrade(request: any, socket: any, head: any) {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
  }
}

export default ProgressWebSocketServer;
