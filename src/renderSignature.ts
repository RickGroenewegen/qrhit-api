import crypto from 'crypto';

/**
 * Signed links for pages that only the PDF Lambda opens.
 *
 * The Lambda renders a page by loading its URL without a session, so these
 * routes cannot ask for a login. They used to be open to anyone who counted
 * company ids, and the quotation page prints the company's contact (name,
 * e-mail, phone). The URL the server hands to the Lambda now carries an
 * expiry and an HMAC over its path and query, and the route answers 404 to
 * anything else. Development skips the check, so a template can still be
 * opened in a browser.
 */
const SIGNATURE_PARAM = 'sig';
const EXPIRY_PARAM = 'exp';
const DEFAULT_TTL_SECONDS = 15 * 60;

function digest(pathAndQuery: string): Buffer {
  const secret = process.env['JWT_SECRET'];
  if (!secret) throw new Error('JWT_SECRET is not set');
  return crypto
    .createHmac('sha256', secret)
    .update(`render:${pathAndQuery}`)
    .digest();
}

/** The URL with an expiry and a signature added, for the PDF Lambda. */
export function signRenderUrl(
  url: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): string {
  const parsed = new URL(url);
  parsed.searchParams.delete(SIGNATURE_PARAM);
  parsed.searchParams.set(
    EXPIRY_PARAM,
    String(Math.floor(Date.now() / 1000) + ttlSeconds)
  );
  parsed.searchParams.set(
    SIGNATURE_PARAM,
    digest(parsed.pathname + parsed.search).toString('hex')
  );
  return parsed.toString();
}

/**
 * True when a request URL (path and query, as Fastify's request.url) carries
 * a valid signature that has not expired. Always true in development.
 */
export function isSignedRenderRequest(requestUrl: string): boolean {
  if (process.env['ENVIRONMENT'] === 'development') return true;

  const parsed = new URL(requestUrl, 'http://render.invalid');
  const signature = parsed.searchParams.get(SIGNATURE_PARAM) || '';
  const expiry = Number(parsed.searchParams.get(EXPIRY_PARAM));
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  if (!Number.isFinite(expiry) || expiry < Date.now() / 1000) return false;

  parsed.searchParams.delete(SIGNATURE_PARAM);
  const expected = digest(parsed.pathname + parsed.search);
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), expected);
}
