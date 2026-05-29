import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import AbuseGuard from '../abuse_guard';
import Utils from '../utils';

declare module 'fastify' {
  interface FastifyRequest {
    clientIp: string;
  }
}

const ipPlugin: FastifyPluginAsync = async (fastify, options) => {
  fastify.decorateRequest('clientIp', '');

  const abuseGuard = AbuseGuard.getInstance();
  const utils = new Utils();

  fastify.addHook('onRequest', (request, reply, done) => {
    // Spoof-resistant client IP for security decisions: prefers the
    // CloudFront-set viewer address over the attacker-controllable
    // X-Forwarded-For header. Falls back to the legacy XFF parse when not
    // behind CloudFront.
    request.clientIp = utils.resolveTrustedClientIp(request);

    // Reject banned IPs across the entire API. This is a synchronous,
    // in-memory lookup so it adds no latency to normal traffic.
    if (abuseGuard.isBanned(request.clientIp)) {
      reply.status(403).send({ error: 'Forbidden' });
      return;
    }

    done();
  });
};

export default fp(ipPlugin);
