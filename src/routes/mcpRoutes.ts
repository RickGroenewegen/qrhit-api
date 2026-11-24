import { FastifyInstance } from 'fastify';
import { color } from 'console-log-colors';
import Logger from '../logger';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import { handleMcpBody } from '../mcp/server';
import { ownPhotoFile } from '../mcp/photo';

/**
 * QRSong! in ChatGPT: the MCP endpoint (src/mcp/server.ts) and the file
 * OpenAI reads to verify that the domain is ours.
 *
 * POST /mcp takes JSON-RPC and answers with JSON. There is no stream and no
 * session, so GET (a client asking for a server-sent stream) and DELETE (a
 * client ending a session) answer 405, as the MCP transport prescribes.
 */
export default async function mcpRoutes(fastify: FastifyInstance) {
  const logger = new Logger();

  const logCall = (tool: string, args: Record<string, unknown>, ok: boolean, ms: number) => {
    const level = ok ? color.blue.bold : color.red.bold;
    logger.log(
      level('[') +
        color.white.bold('mcp') +
        level(`] ${ok ? 'Tool' : 'Tool failed'}: `) +
        color.white.bold(tool) +
        level(' ') +
        color.white.bold(JSON.stringify(args).slice(0, 300)) +
        level(' in ') +
        color.white.bold(`${ms}ms`)
    );
  };

  fastify.post('/mcp', async (request, reply) => {
    const answer = await handleMcpBody(request.body, logCall);
    if (answer === null) {
      return reply.status(202).send();
    }
    return reply.header('Content-Type', 'application/json').send(answer);
  });

  const notAllowed = async (_request: unknown, reply: any) =>
    reply
      .status(405)
      .header('Allow', 'POST')
      .send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed' } });
  fastify.get('/mcp', notAllowed);
  fastify.delete('/mcp', notAllowed);

  // The photo of a customer's own playlist as cards, for its card in ChatGPT
  // (mcp/photo.ts). Made on the first request; 404 keeps the cover there.
  fastify.get('/mcp/photo/:service/:playlistId/:file', async (request: any, reply: any) => {
    const { service, playlistId, file } = request.params as Record<string, string>;
    const match = /^([0-9a-f]{24})\.webp$/.exec(file || '');
    const photo = match ? await ownPhotoFile(service, playlistId, match[1]).catch(() => null) : null;
    const stat = photo ? await fs.stat(photo).catch(() => null) : null;
    if (!photo || !stat) {
      return reply.status(404).header('cache-control', 'no-store').send({ error: 'Not found' });
    }
    return reply
      .header('content-type', 'image/webp')
      .header('content-length', stat.size)
      .header('cache-control', 'public, max-age=2592000')
      .send(createReadStream(photo));
  });

  // The token OpenAI gives on submission (OPENAI_APPS_CHALLENGE in .env),
  // served as plain text. 404 until it is set.
  fastify.get('/.well-known/openai-apps-challenge', async (_request, reply) => {
    const token = (process.env['OPENAI_APPS_CHALLENGE'] || '').trim();
    if (!token) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.header('Content-Type', 'text/plain; charset=utf-8').send(token);
  });
}
