import crypto from 'crypto';
import { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Caching for small JSON catalogues (fonts, backgrounds) that change only when
 * we deploy.
 *
 * These used to be sent with a flat `max-age=86400`, which meant a font added
 * today did not reach a returning visitor for up to 24 hours - the browser
 * never even asked. An ETag over the response body changes the instant the data
 * changes, so a client revalidates and picks the new list up on its next
 * request, at the cost of a ~200 byte 304.
 *
 * Nothing has to be invalidated by hand: the tag is derived from the payload,
 * so editing FONTS is enough.
 */

/** How long a client may reuse the body before checking back. */
const REVALIDATE_AFTER_SECONDS = 60;
/** How long a stale copy may still be served while revalidating behind it. */
const STALE_WHILE_REVALIDATE_SECONDS = 60 * 60 * 24 * 7;

/**
 * Cache key for a response: an md5 of the serialized payload. Not a security
 * boundary, just a short stable id that changes exactly when the data does.
 */
function buildEtag(body: string): string {
  return `"${crypto.createHash('md5').update(body).digest('hex')}"`;
}

/**
 * True when the client's If-None-Match covers our tag. The header can carry a
 * list, and proxies may mark entries weak, so compare on the bare tag.
 */
function matchesEtag(ifNoneMatch: string, etag: string): boolean {
  const strip = (value: string) => value.trim().replace(/^W\//, '');
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch
    .split(',')
    .some((candidate) => strip(candidate) === strip(etag));
}

/**
 * Send a JSON payload with an ETag, answering 304 when the client already has
 * this exact body.
 *
 * Handlers must return the result so Fastify does not also try to send.
 */
export function sendCatalogue(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
): FastifyReply {
  const body = JSON.stringify(payload);
  const etag = buildEtag(body);

  // In development a change should show up on the next reload, not a minute
  // later - the extra round trip costs nothing locally.
  const maxAge =
    process.env['ENVIRONMENT'] === 'development' ? 0 : REVALIDATE_AFTER_SECONDS;

  reply.header('ETag', etag);
  reply.header(
    'Cache-Control',
    `public, max-age=${maxAge}, must-revalidate, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`
  );

  const ifNoneMatch = request.headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && matchesEtag(ifNoneMatch, etag)) {
    return reply.code(304).send();
  }

  return reply.type('application/json; charset=utf-8').send(body);
}

// Exported for tests.
export const __testing = { buildEtag, matchesEtag };
