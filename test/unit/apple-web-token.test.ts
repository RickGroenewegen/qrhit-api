import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';

/**
 * The browser's Apple Music token (`/apple-music/web-token`, the site's web
 * scanner) and the preview lookup the scanner uses. Signed with a throwaway
 * key in a temporary folder; no network, no Redis.
 */

const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    cacheGet: vi.fn(async (key: string) => store.get(key) ?? null),
    cacheSet: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
});

vi.mock('../../src/cache', () => ({
  default: { getInstance: () => ({ get: h.cacheGet, set: h.cacheSet }) },
}));
vi.mock('../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));
vi.mock('../../src/utils', () => ({ default: class {} }));
vi.mock('../../src/translation', () => ({
  default: class Translation {
    static LOCALE_STOREFRONTS: Record<string, string> = { en: 'us', nl: 'nl' };
  },
}));

import AppleMusicProvider from '../../src/providers/AppleMusicProvider';

const ENV_KEYS = ['APP_ROOT', 'APPLE_MUSIC_TEAM_ID', 'APPLE_MUSIC_KEY_ID', 'ENVIRONMENT', 'APPLE_MUSIC_DEVELOPER_TOKEN'];
const saved: Record<string, string | undefined> = {};
let folder: string;
let publicKey: crypto.KeyObject;
const fetchMock = vi.fn();

beforeAll(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-token-'));
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  publicKey = pair.publicKey;
  // The provider reads `<APP_ROOT>/../apple_music.p8`
  fs.mkdirSync(path.join(folder, 'app'));
  fs.writeFileSync(path.join(folder, 'apple_music.p8'), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env['APP_ROOT'] = path.join(folder, 'app');
  process.env['APPLE_MUSIC_TEAM_ID'] = 'TEAM123456';
  process.env['APPLE_MUSIC_KEY_ID'] = 'KEY1234567';
  delete process.env['APPLE_MUSIC_DEVELOPER_TOKEN'];
  vi.stubGlobal('fetch', fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(folder, { recursive: true, force: true });
});

beforeEach(() => {
  h.store.clear();
  h.cacheGet.mockClear();
  h.cacheSet.mockClear();
  fetchMock.mockReset();
  process.env['ENVIRONMENT'] = 'production';
});

function newProvider(): AppleMusicProvider {
  return new (AppleMusicProvider as any)();
}

function verify(token: string): jwt.JwtPayload {
  return jwt.verify(token, publicKey, { algorithms: ['ES256'] }) as jwt.JwtPayload;
}

describe('the browser token', () => {
  it('is valid on our own origins only', async () => {
    const token = await newProvider().getWebDeveloperToken();
    const claims = verify(token!);
    expect(claims.origin).toEqual(['https://www.qrsong.io', 'https://qrsong.io', 'https://www.qrsong.com', 'https://qrsong.com']);
    expect(claims.iss).toBe('TEAM123456');
    expect(jwt.decode(token!, { complete: true })?.header.kid).toBe('KEY1234567');
  });

  it('also works on the local frontends outside production', async () => {
    process.env['ENVIRONMENT'] = 'development';
    const claims = verify((await newProvider().getWebDeveloperToken())!);
    expect(claims.origin).toEqual(expect.arrayContaining(['http://localhost:4200', 'https://qrhit.localhost']));
  });

  it('is signed once and then served from the cache, apart from the apps token', async () => {
    const provider = newProvider();
    const first = await provider.getWebDeveloperToken();
    const again = await newProvider().getWebDeveloperToken();
    expect(again).toBe(first);
    expect(h.cacheSet).toHaveBeenCalledTimes(1);

    // The apps' token has no origin: a native MusicKit has none to check
    const plain = await provider.getDeveloperToken();
    expect(plain).not.toBe(first);
    expect(verify(plain!).origin).toBeUndefined();
  });
});

describe('getSongPreviewUrl', () => {
  const song = (url: string | null) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ attributes: { previews: url ? [{ url }] : [] } }] }),
  });
  const status = (code: number) => ({ ok: false, status: code, statusText: '', text: async () => '' });

  it('answers the preview, or null when Apple knows no such song anywhere', async () => {
    fetchMock.mockResolvedValueOnce(song('https://audio-ssl.itunes.apple.com/p.m4a'));
    expect(await newProvider().getSongPreviewUrl('42', 'nl', 5000)).toBe('https://audio-ssl.itunes.apple.com/p.m4a');

    fetchMock.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(status(404));
    expect(await newProvider().getSongPreviewUrl('42', 'nl', 5000)).toBeNull();
  });

  it('answers undefined when Apple could not be asked, so nobody remembers it', async () => {
    fetchMock.mockResolvedValueOnce(status(503));
    expect(await newProvider().getSongPreviewUrl('42', 'nl', 5000)).toBeUndefined();

    fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    expect(await newProvider().getSongPreviewUrl('42', 'us', 5000)).toBeUndefined();
  });

  it('gives each request the timeout', async () => {
    fetchMock.mockResolvedValueOnce(song('https://audio-ssl.itunes.apple.com/p.m4a'));
    await newProvider().getSongPreviewUrl('42', 'us', 5000);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
