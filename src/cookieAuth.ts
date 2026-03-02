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
 */
export function setAuthCookie(reply: any, token: string): void {
  const isProd = isProduction();

  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd, // Only require HTTPS in production
    sameSite: isProd ? 'none' : 'lax', // 'none' for cross-origin in production, 'lax' for development
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
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
  });
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
  if (cookies && cookies[COOKIE_NAME]) {
    return cookies[COOKIE_NAME];
  }

  return null;
}
