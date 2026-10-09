import { isCredentialedOrigin } from './corsOrigins';

const COOKIE_NAME = 'qrhit_auth';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year in seconds

/**
 * Determine if we're in production environment
 */
function isProduction(): boolean {
  return process.env['ENVIRONMENT'] === 'production';
}

/**
 * Set HttpOnly authentication cookie on the response
 * Uses `any` type since @fastify/cookie adds methods dynamically
 *
 * SameSite=Lax: www.qrsong.io and api.qrsong.io are the same site, so the
 * site's own calls still carry the cookie, while requests started by other
 * sites do not. (It was SameSite=None, which sent it from anywhere.)
 */
export function setAuthCookie(reply: any, token: string): void {
  const isProd = isProduction();

  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd, // Only require HTTPS in production
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
}

/**
 * Clear the authentication cookie
 * Uses `any` type since @fastify/cookie adds methods dynamically
 */
export function clearAuthCookie(reply: any): void {
  const isProd = isProduction();

  reply.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
  });
}

/**
 * Whether the request may be authenticated by its cookie. Cookies set before
 * the switch to SameSite=Lax still travel with requests from other sites for
 * up to a year, so the cookie is ignored when the browser says another site
 * started the request (Sec-Fetch-Site) or names a foreign Origin. The site's
 * own calls, navigations and server-side calls carry neither.
 */
function cookieAllowed(request: any): boolean {
  const headers = request.headers || {};
  if (headers['sec-fetch-site'] === 'cross-site') {
    return false;
  }
  const origin = headers['origin'];
  return !origin || isCredentialedOrigin(origin);
}

/**
 * Get authentication token from request
 * Checks Authorization header first, then falls back to cookie
 * Header takes priority so explicit Bearer tokens (e.g. impersonation) override ambient cookies
 * Uses `any` type since @fastify/cookie adds properties dynamically
 */
export function getTokenFromRequest(request: any): string | null {
  // Check Authorization header first (explicit token takes priority)
  const authHeader = request.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Fall back to cookie
  const cookies = request.cookies;
  if (cookies && cookies[COOKIE_NAME] && cookieAllowed(request)) {
    return cookies[COOKIE_NAME];
  }

  return null;
}
