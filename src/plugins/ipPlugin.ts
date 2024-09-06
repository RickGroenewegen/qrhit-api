import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    clientIp: string;
  }
}

const ipPlugin: FastifyPluginAsync = async (fastify, options) => {
  fastify.decorateRequest('clientIp', '');

  fastify.addHook('onRequest', (request, reply, done) => {
    const xForwardedFor = request.headers['x-forwarded-for'];
    if (xForwardedFor) {
      const ips = Array.isArray(xForwardedFor)
        ? xForwardedFor
        : xForwardedFor.split(',');
      request.clientIp = ips[0].trim();
    } else {
      request.clientIp = request.socket.remoteAddress || '';
    }
    done();
  });
};

export default fp(ipPlugin);
