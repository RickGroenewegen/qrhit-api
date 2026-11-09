/**
 * What the card-scan page offers next to the app stores: the page a phone
 * camera opens when it scans a card and the app is not installed
 * (`/qr/:trackId`, `/qr2/:trackId/:php`, `/qr_url2`; with the app installed
 * the phone opens the app instead, through the app links).
 */

// The site's web scanner as a second choice on every card scan. Held back
// (2026-10-26) until Rick has tested the scanner in production.
export const OFFER_WEB_SCANNER = false;

// The Android app 2.0.3 cannot make a new connection with Spotify, so hidden
// playback fails for anyone who connects for the first time. While the fix
// (2.1.1) waited for Google's approval, an Android phone got the web scanner
// with a short note (Rick, 2026-11-05). 2.1.1 is in the Play Store since
// 2026-11-09, so the note is off; set to true again if a release ever breaks
// the Spotify connection on Android.
export const ANDROID_SPOTIFY_NOTICE = false;

export interface OnboardingFlags {
  offerWebScanner: boolean;
  androidSpotifyNotice: boolean;
}

export interface OnboardingOffer {
  /** Show "Play in your browser" with the web scanner link. */
  webScanner: boolean;
  /** Show the Android note on Spotify above and below that button. */
  androidSpotifyNotice: boolean;
}

export function isAndroidUserAgent(userAgent: string | undefined): boolean {
  return /\bAndroid\b/i.test(userAgent || '');
}

export function onboardingOffer(
  userAgent: string | undefined,
  flags: OnboardingFlags = {
    offerWebScanner: OFFER_WEB_SCANNER,
    androidSpotifyNotice: ANDROID_SPOTIFY_NOTICE,
  }
): OnboardingOffer {
  const androidSpotifyNotice =
    flags.androidSpotifyNotice && isAndroidUserAgent(userAgent);
  return {
    webScanner: flags.offerWebScanner || androidSpotifyNotice,
    androidSpotifyNotice,
  };
}
