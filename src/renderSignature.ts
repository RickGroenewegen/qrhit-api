import crypto from 'crypto';

/**
 * Signed links for pages that only the PDF Lambda opens.
 *
 * The Lambda renders a page by loading its URL without a session, so these
 * routes cannot ask for a login. They used to be open to anyone who counted
 * company ids, and the quotation page prints the company's contact (name,
 * e-mail, phone). The server now signs what it hands to the Lambda and the
 * route answers 404 to anything else. Development skips the check, so a
 * template can still be opened in a browser.
 *
 * Like the price lists (priceList.ts), the signature covers the values the
 * handler reads, as Fastify parsed them (route params and query), not the
 * URL string: a path that the URL parser and the router read differently
 * (backslashes, dot segments, encodings) cannot pass someone else's values.
 * The route name is part of it, so a signature for one view does not open
 * another, and so is an expiry.
 */
const SIGNATURE_PARAM = 'sig';
const EXPIRY_PARAM = 'exp';
const DEFAULT_TTL_SECONDS = 15 * 60;

type RenderValues = Record<string, unknown>;

function digest(view: string, params: RenderValues, query: RenderValues): string {
  const secret = process.env['JWT_SECRET'];
  if (!secret) throw new Error('JWT_SECRET is not set');
  const sorted = (values: RenderValues) =>
    Object.keys(values)
      .filter((key) => key !== SIGNATURE_PARAM)
      .sort()
      .map((key) => [key, values[key]]);
  return crypto
    .createHmac('sha256', secret)
    .update(`render:${view}:${JSON.stringify([sorted(params), sorted(query)])}`)
    .digest('hex');
}

/**
 * The query string (with expiry and signature) for a view the Lambda will
 * render. `params` are the route params by name, as strings.
 */
export function signedRenderQuery(
  view: string,
  params: Record<string, string>,
  query: Record<string, string>,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): string {
  const values = {
    ...query,
    [EXPIRY_PARAM]: String(Math.floor(Date.now() / 1000) + ttlSeconds),
  };
  return new URLSearchParams({
    ...values,
    [SIGNATURE_PARAM]: digest(view, params, values),
  }).toString();
}

/**
 * True when the request carries a valid signature for this view that has
 * not expired. Always true in development.
 */
export function isSignedRenderRequest(
  view: string,
  request: { params?: unknown; query?: unknown }
): boolean {
  if (process.env['ENVIRONMENT'] === 'development') return true;

  const params = (request.params || {}) as RenderValues;
  const query = (request.query || {}) as RenderValues;
  const signature = query[SIGNATURE_PARAM];
  const expiry = query[EXPIRY_PARAM];
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (typeof expiry !== 'string' || !/^\d+$/.test(expiry)) return false;
  if (Number(expiry) < Date.now() / 1000) return false;

  const expected = Buffer.from(digest(view, params, query), 'hex');
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), expected);
}
