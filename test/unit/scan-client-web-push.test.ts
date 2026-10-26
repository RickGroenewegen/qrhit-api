import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/logger', () => ({
  default: class {
    log() {}
  },
}));
vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => ({}) },
}));

import { scanClient } from '../../src/scanClient';
import { hashEndpoint, validateSubscription } from '../../src/webPush';
import { youtubeVideoId } from '../../src/youtubeLink';

describe('youtubeVideoId', () => {
  it('reads the link shapes Bopster cards carry', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ?si=abc')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('leaves YouTube Music and everything else alone', () => {
    expect(youtubeVideoId('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(youtubeVideoId('https://www.youtube.com/channel/UC123')).toBeNull();
    expect(youtubeVideoId('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(youtubeVideoId('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(youtubeVideoId('nonsense')).toBeNull();
  });
});

const IPHONE_WEBVIEW =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ANDROID_WEBVIEW =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0 Mobile Safari/537.36';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

describe('scanClient', () => {
  it('knows the iOS app by its Capacitor origin', () => {
    expect(scanClient('capacitor://localhost', IPHONE_WEBVIEW)).toBe('ios');
    expect(scanClient('ionic://localhost', IPHONE_WEBVIEW)).toBe('ios');
  });

  it('knows the Android app by its localhost origin and WebView', () => {
    expect(scanClient('https://localhost', ANDROID_WEBVIEW)).toBe('android');
    expect(scanClient('http://localhost', ANDROID_WEBVIEW)).toBe('android');
  });

  it('calls a phone browser on the site web, whatever the phone', () => {
    expect(scanClient('https://www.qrsong.io', ANDROID_CHROME)).toBe('web');
    expect(scanClient('https://www.qrsong.io', IPHONE_WEBVIEW)).toBe('web');
    expect(scanClient('https://qrhit.localhost', MAC_CHROME)).toBe('web');
  });

  it('treats a desktop browser on bare localhost as the web scanner', () => {
    expect(scanClient('http://localhost', MAC_CHROME)).toBe('web');
  });

  it('falls back to the user agent without an origin', () => {
    expect(scanClient(undefined, IPHONE_WEBVIEW)).toBe('ios');
    expect(scanClient(undefined, ANDROID_WEBVIEW)).toBe('android');
    expect(scanClient(undefined, MAC_CHROME)).toBeNull();
    expect(scanClient(undefined, undefined)).toBeNull();
  });

  it('does not take another site for ours', () => {
    expect(scanClient('https://hitify.app', MAC_CHROME)).toBeNull();
    expect(scanClient('https://qrsong.io.evil.example', MAC_CHROME)).toBeNull();
  });
});

describe('validateSubscription', () => {
  const keys = {
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  };

  it('accepts the push services of the browsers we know', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://web.push.apple.com/QGuQyavXutnMH-1',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      expect(validateSubscription({ endpoint, keys })).toEqual({ endpoint, ...keys });
    }
  });

  it('refuses any other address, so the server never posts where a caller says', () => {
    for (const endpoint of [
      'https://example.com/push',
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://fcm.googleapis.com.evil.example/x',
      'https://169.254.169.254/latest/meta-data',
      'not a url',
    ]) {
      expect(validateSubscription({ endpoint, keys })).toBeNull();
    }
  });

  it('refuses missing or malformed keys', () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    expect(validateSubscription({ endpoint })).toBeNull();
    expect(validateSubscription({ endpoint, keys: { p256dh: keys.p256dh } })).toBeNull();
    expect(validateSubscription({ endpoint, keys: { p256dh: 'a b', auth: keys.auth } })).toBeNull();
    expect(validateSubscription({ endpoint, keys: { p256dh: 'x'.repeat(300), auth: keys.auth } })).toBeNull();
    expect(validateSubscription(null)).toBeNull();
  });

  it('refuses an endpoint too long to be real', () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${'a'.repeat(3000)}`;
    expect(validateSubscription({ endpoint, keys })).toBeNull();
  });

  it('hashes an endpoint to 64 hex characters', () => {
    expect(hashEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});
