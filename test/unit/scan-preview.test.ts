import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

const store = new Map<string, string>();
vi.mock('../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => {
        store.set(key, value);
      },
    }),
  },
}));

const applePreview = vi.fn();
vi.mock('../../src/providers', () => ({
  AppleMusicProvider: {
    getInstance: () => ({ getSongPreviewUrl: applePreview }),
  },
}));

import ScanPreview, {
  appleSongId,
  deezerTrackId,
  previewOrder,
  spotifyTrackId,
} from '../../src/scanPreview';

const SPOTIFY_ID = '4c1LnEyVW8evh46XomFZ7u';
const SPOTIFY_LINK = `https://open.spotify.com/track/${SPOTIFY_ID}`;
const SPOTIFY_PREVIEW = 'https://p.scdn.co/mp3-preview/6fa6bccb145c9ab27388b57eb988f361701b7af2';
const DEEZER_PREVIEW =
  'https://cdnt-preview.dzcdn.net/api/1/1/6/a/2/0/6a2c.mp3?hdnea=exp=1793036181~hmac=92d1';

function embedPage(url: string | null): string {
  return url
    ? `<script>{"props":{"audioPreview":{"url":"${url}"},"other":1}}</script>`
    : '<script>{"props":{"audioPreview":null}}</script>';
}

function freshResolver(): ScanPreview {
  (ScanPreview as any).instance = undefined;
  return ScanPreview.getInstance();
}

describe('scan preview link parsing', () => {
  it('reads Spotify track ids from links and URIs', () => {
    expect(spotifyTrackId(SPOTIFY_LINK)).toBe(SPOTIFY_ID);
    expect(spotifyTrackId(`https://open.spotify.com/intl-nl/track/${SPOTIFY_ID}?si=x`)).toBe(SPOTIFY_ID);
    expect(spotifyTrackId(`spotify:track:${SPOTIFY_ID}`)).toBe(SPOTIFY_ID);
    expect(spotifyTrackId('?')).toBeNull();
    expect(spotifyTrackId('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toBeNull();
  });

  it('reads Deezer track ids with and without a locale', () => {
    expect(deezerTrackId('https://www.deezer.com/track/3135556')).toBe('3135556');
    expect(deezerTrackId('https://www.deezer.com/nl/track/3135556')).toBe('3135556');
    expect(deezerTrackId('https://evil.example/track/1?x=deezer.com')).toBeNull();
  });

  it('reads Apple Music song ids from song links and album links with i=', () => {
    expect(appleSongId('https://music.apple.com/nl/album/one/1440857781?i=1440857786')).toEqual({
      id: '1440857786',
      storefront: 'nl',
    });
    expect(appleSongId('https://music.apple.com/us/song/one/1440857786')).toEqual({
      id: '1440857786',
      storefront: 'us',
    });
    // Summary-page cards carry the bare form
    expect(appleSongId('https://music.apple.com/song/1440857786')).toEqual({
      id: '1440857786',
      storefront: 'us',
    });
    expect(appleSongId('https://example.com/song/1440857786')).toBeNull();
  });

  it('asks the preferred service first and keeps the rest in order', () => {
    expect(previewOrder('deezer')).toEqual(['deezer', 'spotify', 'apple_music']);
    expect(previewOrder('apple-music')).toEqual(['apple_music', 'spotify', 'deezer']);
    expect(previewOrder('tidal')).toEqual(['spotify', 'deezer', 'apple_music']);
    expect(previewOrder(null)).toEqual(['spotify', 'deezer', 'apple_music']);
  });
});

describe('ScanPreview.resolve', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store.clear();
    applePreview.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (ScanPreview as any).instance = undefined;
  });

  it('takes the Spotify preview from the embed page', async () => {
    fetchMock.mockResolvedValueOnce(new Response(embedPage(SPOTIFY_PREVIEW)));
    const result = await freshResolver().resolve({ link: SPOTIFY_LINK }, 'spotify');
    expect(result).toEqual({ url: SPOTIFY_PREVIEW, source: 'spotify' });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://open.spotify.com/embed/track/${SPOTIFY_ID}`);
  });

  it('falls back to Deezer when Spotify has no preview', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(embedPage(null)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ preview: DEEZER_PREVIEW })));
    const result = await freshResolver().resolve(
      { link: SPOTIFY_LINK, dz: 'https://www.deezer.com/track/3135556' },
      'spotify'
    );
    expect(result).toEqual({ url: DEEZER_PREVIEW, source: 'deezer' });
  });

  it('asks Apple through the provider when it is preferred', async () => {
    applePreview.mockResolvedValueOnce('https://audio-ssl.itunes.apple.com/preview.m4a');
    const result = await freshResolver().resolve(
      { link: SPOTIFY_LINK, am: 'https://music.apple.com/nl/album/x/1?i=42' },
      'apple_music'
    );
    expect(result).toEqual({ url: 'https://audio-ssl.itunes.apple.com/preview.m4a', source: 'apple_music' });
    expect(applePreview).toHaveBeenCalledWith('42', 'nl');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a Deezer preview on a host that is not Deezer\'s', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ preview: 'https://evil.example/a.mp3' })));
    const result = await freshResolver().resolve({ dz: 'https://www.deezer.com/track/1' }, 'deezer');
    expect(result).toBeNull();
  });

  it('remembers a miss so the next scan does not ask again', async () => {
    fetchMock.mockResolvedValue(new Response(embedPage(null)));
    const resolver = freshResolver();
    expect(await resolver.resolve({ link: SPOTIFY_LINK }, 'spotify')).toBeNull();
    expect(await resolver.resolve({ link: SPOTIFY_LINK }, 'spotify')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves a cached preview without a request', async () => {
    fetchMock.mockResolvedValueOnce(new Response(embedPage(SPOTIFY_PREVIEW)));
    const resolver = freshResolver();
    await resolver.resolve({ link: SPOTIFY_LINK }, 'spotify');
    const again = await resolver.resolve({ link: SPOTIFY_LINK }, 'spotify');
    expect(again?.url).toBe(SPOTIFY_PREVIEW);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null for a card without any usable link', async () => {
    expect(await freshResolver().resolve({ link: '?' }, 'spotify')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
