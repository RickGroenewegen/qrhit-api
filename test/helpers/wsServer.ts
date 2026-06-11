import { createServer, Server as HTTPServer } from 'http';
import { AddressInfo } from 'net';
import { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import NativeWebSocketServer from '../../src/websocket-native';
import { buildTestApp } from './app';

export interface TestWsServer {
  app: FastifyInstance | null;
  port: number;
  wsServer: NativeWebSocketServer;
  close(): Promise<void>;
}

/**
 * Tear down a NativeWebSocketServer instance. The class has no shutdown
 * method (in production it lives for the process lifetime), so reach into
 * its internals: heartbeat timer, client sockets, and the three Redis
 * connections (db 1) it owns.
 */
async function destroyWsServer(wsServer: NativeWebSocketServer): Promise<void> {
  const internals = wsServer as any;
  clearInterval(internals.heartbeatInterval);
  for (const connection of internals.connections.values()) {
    try {
      connection.ws.terminate();
    } catch {
      /* already gone */
    }
  }
  internals.wss.close();
  await Promise.allSettled([
    internals.redis.quit(),
    internals.pubClient.quit(),
    internals.subClient.quit(),
  ]);
}

/**
 * Full-stack websocket server: the real Fastify app listening on an
 * ephemeral port with the production `/ws` upgrade wiring replicated from
 * Server.startServer().
 */
export async function startTestWsServer(): Promise<TestWsServer> {
  const app = await buildTestApp();
  await app.listen({ port: 0, host: '127.0.0.1' });

  const wsServer = new NativeWebSocketServer(app.server);
  app.server.on('upgrade', (request, socket, head) => {
    const pathname = (request.url || '').split('?')[0];
    if (pathname === '/ws') {
      wsServer.handleUpgrade(request, socket as any, head);
    } else {
      socket.destroy();
    }
  });

  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    port,
    wsServer,
    close: async () => {
      await destroyWsServer(wsServer);
      await app.close();
    },
  };
}

/**
 * Bare second server instance (plain http.Server) for cross-server Redis
 * pub/sub tests — NativeWebSocketServer only needs an http server to hook.
 */
export async function startBareWsServer(): Promise<TestWsServer> {
  const server: HTTPServer = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const wsServer = new NativeWebSocketServer(server);
  server.on('upgrade', (request, socket, head) => {
    const pathname = (request.url || '').split('?')[0];
    if (pathname === '/ws') {
      wsServer.handleUpgrade(request, socket as any, head);
    } else {
      socket.destroy();
    }
  });

  const port = (server.address() as AddressInfo).port;
  return {
    app: null,
    port,
    wsServer,
    close: async () => {
      await destroyWsServer(wsServer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Promise-based websocket test client collecting parsed messages. */
export class WsTestClient {
  ws: WebSocket;
  messages: any[] = [];
  private waiters: { type: string; resolve: (msg: any) => void }[] = [];

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.type === msg.type) {
          w.resolve(msg);
          return false;
        }
        return true;
      });
    });
  }

  async opened(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.ws.send(
      typeof message === 'string' ? message : JSON.stringify(message)
    );
  }

  /** Resolve with the next (or an already received) message of a type. */
  waitFor(type: string, timeoutMs = 5000): Promise<any> {
    const existing = this.messages.find((m) => m.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for "${type}"`)),
        timeoutMs
      );
      this.waiters.push({
        type,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}
