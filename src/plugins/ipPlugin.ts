import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import AbuseGuard from '../abuse_guard';
import Utils from '../utils';

declare module 'fastify' {
  interface FastifyRequest {
    clientIp: string;
  }
}

/**
 * Checkout endpoints stay reachable even for banned IPs.
 *
 * Bans come from the QR-link guard (30 scans/minute, or a run of sequential
 * track ids, → 7 day ban), which a customer can trip legitimately by scanning
 * through a new deck of their own cards. Locking that person out of paying for
 * a week is far worse than the abuse it would prevent, and these routes are
 * not the ones being abused.
 */
const BAN_EXEMPT_PATHS = [
  '/order/calculate',
  '/order/volume-discount',
  '/mollie/payment',
  '/mollie/check',
  '/mollie/webhook',
];

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
    const path = request.url.split('?')[0];
    const exempt = BAN_EXEMPT_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

    const userAgent = (request.headers['user-agent'] as string) || '';

    if (!exempt && abuseGuard.isBanned(request.clientIp, userAgent)) {
      reply.status(403).send({ error: 'Forbidden' });
      return;
    }

    done();
  });
};

export default fp(ipPlugin);
