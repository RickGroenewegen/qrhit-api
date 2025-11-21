import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import { ChatService } from './chat';
import Logger from './logger';
import Translation from './translation';

interface ChatConnection {
  ws: WebSocket;
  chatId: number | null;
  isAlive: boolean;
  locale: string;
}

class ChatWebSocketServer {
  private wss: WebSocketServer;
  private connections: Map<string, ChatConnection> = new Map();
  private chatService: ChatService;
  private logger: Logger;
  private translation: Translation;
  private heartbeatInterval!: NodeJS.Timeout;
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;

  constructor(server: HTTPServer) {
    this.wss = new WebSocketServer({
      noServer: true,
    });

    this.chatService = new ChatService();
    this.logger = new Logger();
    this.translation = new Translation();

    // Set up Redis for cross-worker communication
    this.setupRedisPubSub();

    this.initializeHandlers();
    this.startHeartbeat();
  }

  private setupRedisPubSub() {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.log('[ChatWS] REDIS_URL not set, cross-worker messaging disabled');
      return;
    }

    try {
      this.pubClient = new Redis(redisUrl);
      this.subClient = new Redis(redisUrl);

      this.subClient.subscribe('chat-events', (err) => {
        if (err) {
          this.logger.log(`[ChatWS] Failed to subscribe to chat-events: ${err.message}`);
        }
      });

      this.subClient.on('message', (channel, message) => {
        if (channel === 'chat-events') {
          try {
            const event = JSON.parse(message);
            this.handleRedisEvent(event);
          } catch (error) {
            this.logger.log(`[ChatWS] Error handling Redis event: ${error}`);
          }
        }
      });

    } catch (error) {
      this.logger.log(`[ChatWS] Failed to initialize Redis: ${error}`);
    }
  }

  private handleRedisEvent(event: { chatId: number; type: string; data: any }) {
    // Broadcast to all local connections for this chat
    this.connections.forEach((connection) => {
      if (connection.chatId === event.chatId && connection.ws.readyState === WebSocket.OPEN) {
        this.sendMessage(connection.ws, { type: event.type, ...event.data });
      }
    });
  }

  private publishChatEvent(chatId: number, type: string, data: any) {
    if (this.pubClient) {
      this.pubClient.publish('chat-events', JSON.stringify({ chatId, type, data }));
    }
  }

  private initializeHandlers() {
    this.wss.on('connection', async (ws: WebSocket, request: any) => {
      const connectionId = this.generateConnectionId();

      // Extract params from query string
      const url = new URL(request.url || '', 'http://localhost');
      const locale = url.searchParams.get('locale') || 'en';
      const chatIdParam = url.searchParams.get('chatId');
      const hasMessages = url.searchParams.get('hasMessages') === '1';

      // Validate chatId is provided
      if (!chatIdParam) {
        this.sendError(ws, 'Chat ID required');
        ws.close();
        return;
      }

      const chatId = parseInt(chatIdParam, 10);
      if (isNaN(chatId)) {
        this.sendError(ws, 'Invalid Chat ID');
        ws.close();
        return;
      }

      // Verify chat exists
      const chat = await this.chatService.getChat(chatId);
      if (!chat) {
        this.sendError(ws, 'Chat not found');
        ws.close();
        return;
      }

      // Store locale in chat if not already set
      if (!chat.locale) {
        await this.chatService.updateChatLocale(chatId, locale);
      }

      const connection: ChatConnection = {
        ws,
        chatId,
        isAlive: true,
        locale,
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
          await this.handleMessage(connectionId, data);
        } catch (error) {
          this.logger.log(`Error processing chat message: ${error}`);
          this.sendError(ws, 'Invalid message format');
        }
      });

      ws.on('close', () => {
        this.connections.delete(connectionId);
      });

      ws.on('error', (error) => {
        this.logger.log(`Chat WebSocket error for ${connectionId}: ${error}`);
      });

      // Send connected confirmation with current state
      this.sendMessage(ws, { type: 'connected', data: { chatId, username: chat.username, hijacked: chat.hijacked } });

      // Send welcome greeting only for new chats without messages
      if (!hasMessages) {
        this.sendWelcome(ws, locale);
      }
    });
  }

  private async sendWelcome(ws: WebSocket, locale: string) {
    const welcomeMessage = this.translation.translate('chat.welcome', locale);

    // Stream the welcome message token by token for a nice effect
    const tokens = welcomeMessage.split(' ');
    for (let i = 0; i < tokens.length; i++) {
      const token = i === 0 ? tokens[i] : ' ' + tokens[i];
      this.sendMessage(ws, { type: 'stream', token });
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    this.sendMessage(ws, { type: 'done' });
  }

  private async handleMessage(connectionId: string, data: any) {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.chatId) return;

    // Handle typing indicator
    if (data.type === 'typing') {
      this.publishChatEvent(connection.chatId, 'user_typing', {});
      return;
    }

    const message = data.message;
    if (!message || typeof message !== 'string') {
      this.sendError(connection.ws, 'Message is required');
      return;
    }

    // Check if chat is hijacked - if so, only save message, don't process AI response
    const chat = await this.chatService.getChat(connection.chatId);
    if (chat?.hijacked) {
      // Save user message and broadcast to admin viewers
      const savedMessage = await this.chatService.saveUserMessage(connection.chatId, message);
      this.publishChatEvent(connection.chatId, 'user_message', {
        content: message,
        translatedContent: savedMessage.translatedContent,
      });
      // Tell user their message was received so they can type again
      this.sendMessage(connection.ws, { type: 'message_received' });
      return;
    }

    // Notify that we're searching for relevant topics
    this.sendMessage(connection.ws, { type: 'searching' });

    try {
      await this.chatService.processQuestion(
        connection.chatId,
        message,
        // onToken callback - stream each token
        (token: string) => {
          this.sendMessage(connection.ws, { type: 'stream', token });
        },
        // onSearching callback
        () => {
          this.sendMessage(connection.ws, { type: 'searching' });
        }
      );

      // Signal that the response is complete
      this.sendMessage(connection.ws, { type: 'done' });
    } catch (error) {
      this.logger.log(`Error processing question: ${error}`);
      this.sendError(connection.ws, 'Failed to process your question. Please try again.');
    }
  }

  /**
   * Broadcast admin message to all connections for a specific chat (across all workers via Redis)
   */
  public broadcastToChat(chatId: number, message: any) {
    // Publish via Redis for cross-worker delivery
    if (this.pubClient) {
      this.publishChatEvent(chatId, message.type, message);
    } else {
      // Fallback to local broadcast only
      this.connections.forEach((connection) => {
        if (connection.chatId === chatId && connection.ws.readyState === WebSocket.OPEN) {
          this.sendMessage(connection.ws, message);
        }
      });
    }
  }

  /**
   * Get singleton instance for broadcasting from routes
   */
  private static instance: ChatWebSocketServer | null = null;

  public static getInstance(): ChatWebSocketServer | null {
    return ChatWebSocketServer.instance;
  }

  public static setInstance(instance: ChatWebSocketServer) {
    ChatWebSocketServer.instance = instance;
  }

  private sendMessage(ws: WebSocket, message: any) {
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
    return `chat-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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

export default ChatWebSocketServer;
