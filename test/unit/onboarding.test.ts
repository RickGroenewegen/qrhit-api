import { describe, it, expect } from 'vitest';
import ejs from 'ejs';
import fs from 'fs/promises';
import path from 'path';
import Translation from '../../src/translation';
import { isAndroidUserAgent, onboardingOffer } from '../../src/onboarding';

/**
 * The card-scan page (/qr/…): while ANDROID_SPOTIFY_NOTICE is on (the Android
 * app 2.0.3 cannot make a new Spotify connection), an Android phone gets the
 * web scanner as the main button, then why the app does not connect, the
 * 2.1.1 to watch the Play Store for, our offer to help connect, and only a
 * small Google Play link. Every other phone sees the page as before.
 */

const ANDROID =
  'Mozilla/5.0 (Linux; Android 16; RMX5011) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';

describe('isAndroidUserAgent', () => {
  it('knows an Android phone', () => {
    expect(isAndroidUserAgent(ANDROID)).toBe(true);
  });
  it('is false for an iPhone, a desktop and no agent at all', () => {
    expect(isAndroidUserAgent(IPHONE)).toBe(false);
    expect(
      isAndroidUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')
    ).toBe(false);
    expect(isAndroidUserAgent(undefined)).toBe(false);
    expect(isAndroidUserAgent('')).toBe(false);
  });
});

describe('onboardingOffer', () => {
  const on = { offerWebScanner: false, androidSpotifyNotice: true };
  const off = { offerWebScanner: false, androidSpotifyNotice: false };

  it('gives Android the scanner and the note while the notice is on', () => {
    expect(onboardingOffer(ANDROID, on)).toEqual({ webScanner: true, androidSpotifyNotice: true });
  });
  it('leaves an iPhone as it was', () => {
    expect(onboardingOffer(IPHONE, on)).toEqual({ webScanner: false, androidSpotifyNotice: false });
  });
  it('gives Android nothing extra once the notice is off', () => {
    expect(onboardingOffer(ANDROID, off)).toEqual({ webScanner: false, androidSpotifyNotice: false });
  });
  it('offers the scanner to everyone without the note when OFFER_WEB_SCANNER is on', () => {
    const all = { offerWebScanner: true, androidSpotifyNotice: false };
    expect(onboardingOffer(IPHONE, all)).toEqual({ webScanner: true, androidSpotifyNotice: false });
    expect(onboardingOffer(ANDROID, all)).toEqual({ webScanner: true, androidSpotifyNotice: false });
  });
  it('is on by default, until 2.1.1 is in the Play Store', () => {
    expect(onboardingOffer(ANDROID).androidSpotifyNotice).toBe(true);
    expect(onboardingOffer(IPHONE).webScanner).toBe(false);
  });
});

const TEMPLATE = path.resolve('src/views/onboarding.ejs');
const translation = new Translation();

async function render(locale: string, userAgent: string): Promise<string> {
  const offer = onboardingOffer(userAgent, { offerWebScanner: false, androidSpotifyNotice: true });
  const template = await fs.readFile(TEMPLATE, 'utf-8');
  return ejs.render(
    template,
    {
      translations: await translation.getTranslationsByPrefix(locale, 'countdown'),
      version: 'test',
      domain: 'https://www.qrsong.io',
      scanUrl: offer.webScanner ? 'https://www.qrsong.io/scan?card=x' : null,
      androidSpotifyNotice: offer.androidSpotifyNotice,
    },
    { filename: TEMPLATE }
  );
}

describe('onboarding.ejs', () => {
  it('makes the scanner the main button on Android', async () => {
    const html = await render('en', ANDROID);
    expect(html).toContain('Using Spotify on Android?');
    expect(html).toContain('Play your cards in your browser!');
    expect(html).toMatch(/<a href="https:\/\/www\.qrsong\.io\/scan\?card=x" class="store-btn"/);
    expect(html).toContain('30-second previews');
    expect(html).not.toContain('Install our app to scan your cards!');
    expect(html).not.toContain('Can&#39;t install the app right now?');
  });

  it('explains the app on Android: why, 2.1.1, our help, a small store link', async () => {
    const html = await render('en', ANDROID);
    expect(html).toContain('What about the app?');
    expect(html).toContain('can&#39;t connect to Spotify right now');
    expect(html).toContain('Version 2.1.1');
    expect(html).toContain('keep an eye on the Play Store');
    expect(html).toContain('we&#39;ll help you connect it to Spotify');
    expect(html).toMatch(/<a href="https:\/\/www\.qrsong\.io\/contact" class="play-browser-btn"/);
    expect(html).toContain('Contact us');
    expect(html).toContain('play.google.com/store/apps/details?id=nl.rickgroenewegen.qrsong');
    expect(html).not.toContain('apps.apple.com');
    expect(html).not.toMatch(/class="store-btn"[^>]*aria-label="Google Play"/);
  });

  it('has the Android copy in Dutch and German', async () => {
    const nl = await render('nl', ANDROID);
    expect(nl).toContain('Gebruik je Spotify op Android?');
    expect(nl).toContain('En de app?');
    expect(nl).toContain('2.1.1');
    expect(await render('de', ANDROID)).toContain('Nutzt du Spotify auf Android?');
  });

  it('shows an iPhone no scanner block and no note', async () => {
    const html = await render('en', IPHONE);
    expect(html).not.toContain('browser-option');
    expect(html).not.toContain('Using Spotify on Android?');
    expect(html).not.toContain('What about the app?');
    expect(html).toContain('Install our app to scan your cards!');
    expect(html).toContain('apps.apple.com/app/qrsong/id6727011939');
    expect(html).toContain('play.google.com/store/apps/details?id=nl.rickgroenewegen.qrsong');
  });
});
