/**
 * The web origins that may call the API with the visitor's session cookie:
 * the hostnames the site is served on (the frontend's SSR `allowedHosts`).
 *
 * Any other origin (the scan app, partner pages) may still call the API and
 * read public answers, but never with credentials: a page on another site
 * must not be able to act as a logged-in admin through the cookie.
 */
const PRODUCTION_ORIGINS = [
  'https://www.qrsong.io',
  'https://qrsong.io',
  'https://www.qrsong.com',
  'https://qrsong.com',
];

const DEVELOPMENT_ORIGINS = [
  'http://localhost:4200',
  'http://localhost:4000',
  'http://localhost:5000',
];

export function credentialedOrigins(): string[] {
  return process.env['ENVIRONMENT'] === 'production'
    ? PRODUCTION_ORIGINS
    : [...PRODUCTION_ORIGINS, ...DEVELOPMENT_ORIGINS];
}

export function isCredentialedOrigin(origin: string | undefined): boolean {
  return !!origin && credentialedOrigins().includes(origin);
}
