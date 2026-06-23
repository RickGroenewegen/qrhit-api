import { FastifyInstance } from 'fastify';
import Server from '../../src/server';

/**
 * Build an isolated, fully-configured Fastify app for fastify.inject()
 * testing: all plugins and routes registered, but no listen(), cluster,
 * websocket servers, queue workers or cron jobs.
 */
export async function buildTestApp(): Promise<FastifyInstance> {
  const server = Server.createFresh();
  return server.buildForTesting();
}

export async function closeTestApp(app: FastifyInstance): Promise<void> {
  await app.close();
}
