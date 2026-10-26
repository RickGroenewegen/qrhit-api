/**
 * Which client a scan came from, for the admin map's cards.
 *
 * The app calls the API from its WebView, so every request carries the
 * WebView's own origin: Capacitor serves the iOS app from
 * `capacitor://localhost` (Ionic's older builds `ionic://localhost`) and the
 * Android app from `https://localhost` (`http://localhost` before Capacitor
 * 6). The site's web scanner calls cross-origin from qrsong.io, so its origin
 * is the site's. Without an origin the user agent decides, and a request that
 * says neither is left unknown rather than guessed.
 */
export type ScanClient = 'ios' | 'android' | 'web';

const IOS_APP_ORIGINS = new Set(['capacitor://localhost', 'ionic://localhost']);
const ANDROID_APP_ORIGINS = new Set(['https://localhost', 'http://localhost']);

function isSiteOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (host === 'qrsong.io' || host.endsWith('.qrsong.io')) return true;
  // Local development: ng serve and hoster's https://qrhit.localhost
  if (host.endsWith('.localhost')) return true;
  const frontend = process.env['FRONTEND_URI'];
  if (frontend) {
    try {
      return new URL(frontend).hostname === host;
    } catch {
      return false;
    }
  }
  return false;
}

export function scanClient(origin: string | undefined, userAgent: string | undefined): ScanClient | null {
  const ua = userAgent || '';
  if (origin) {
    if (IOS_APP_ORIGINS.has(origin)) return 'ios';
    if (ANDROID_APP_ORIGINS.has(origin)) {
      // An Android app's WebView says so; anything else on bare localhost is
      // a developer's browser, which is the web scanner
      return /Android/i.test(ua) ? 'android' : 'web';
    }
    if (isSiteOrigin(origin)) return 'web';
  }
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return null;
}
