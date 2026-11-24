import { FastifyInstance } from 'fastify';
import { color } from 'console-log-colors';
import Logger from '../logger';
import { handleMcpBody } from '../mcp/server';

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
