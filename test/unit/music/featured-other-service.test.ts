import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * src/featuredOtherService.ts: a featured playlist on another service than
 * Spotify, loaded for its product page through the Spotify route. The
 * providers are mocked; Spotify.getPlaylist/getTracks use these helpers in
 * test/unit/music/spotify.test.ts.
 */

const h = vi.hoisted(() => ({
  apple: {
    getPlaylist: vi.fn(),
    getTracks: vi.fn(),
    getStorefrontForLocale: vi.fn((locale?: string) =>
      ({ de: 'de', en: 'gb', fr: 'fr' } as Record<string, string>)[locale || ''] || 'nl'
    ),
  },
  youtube: { getPlaylist: vi.fn(), getTracks: vi.fn() },
  deezer: { getPlaylist: vi.fn(), getTracks: vi.fn() },
  tidal: { getPlaylist: vi.fn(), getTracks: vi.fn() },
}));

vi.mock('../../../src/providers/AppleMusicProvider', () => ({
  default: { getInstance: () => h.apple },
}));
vi.mock('../../../src/providers/YouTubeMusicProvider', () => ({
  default: { getInstance: () => h.youtube },
}));
vi.mock('../../../src/providers/DeezerProvider', () => ({
  default: { getInstance: () => h.deezer },
}));
vi.mock('../../../src/providers/TidalProvider', () => ({
  default: { getInstance: () => h.tidal },
}));

import {
  appleStorefrontFor,
  fetchOtherServicePlaylist,
  fetchOtherServiceTracks,
  isOtherService,
  otherServiceProvider,
  providerTrackToTrack,
} from '../../../src/featuredOtherService';
import { ServiceType } from '../../../src/enums/ServiceType';

beforeEach(() => {
  for (const p of [h.apple, h.youtube, h.deezer, h.tidal]) {
    p.getPlaylist.mockReset();
    p.getTracks.mockReset();
  }
});

describe('otherServiceProvider / isOtherService', () => {
  it('knows the four other services and nothing else', () => {
    expect(otherServiceProvider('apple_music')).toBe(h.apple);
    expect(otherServiceProvider('youtube_music')).toBe(h.youtube);
    expect(otherServiceProvider('deezer')).toBe(h.deezer);
    expect(otherServiceProvider('tidal')).toBe(h.tidal);
    for (const value of ['spotify', '', null, undefined, 'amazon']) {
      expect(otherServiceProvider(value)).toBeNull();
      expect(isOtherService(value)).toBe(false);
    }
    expect(isOtherService('tidal')).toBe(true);
  });
});

describe('appleStorefrontFor', () => {
  it('takes the first locale of the list, the provider default without one', () => {
    expect(appleStorefrontFor('de,en')).toBe('de');
    expect(appleStorefrontFor(' fr , de')).toBe('fr');
    expect(appleStorefrontFor('')).toBe('nl');
    expect(appleStorefrontFor(null)).toBe('nl');
    expect(appleStorefrontFor(',')).toBe('nl');
  });
});

describe('fetchOtherServicePlaylist', () => {
  it('asks Apple Music in the list\'s storefront and answers in the Spotify API shape', async () => {
    h.apple.getPlaylist.mockResolvedValueOnce({
      success: true,
      data: { id: 'pl.u-1', name: 'A', description: 'd', imageUrl: 'https://img/a.jpg', trackCount: 12 },
    });
    const res = await fetchOtherServicePlaylist(ServiceType.APPLE_MUSIC, 'pl.u-1', {
      cache: false,
      featuredLocale: 'de',
      storedTrackCount: 99,
    });
    expect(h.apple.getPlaylist).toHaveBeenCalledWith('pl.u-1', 'de', false);
    expect(res).toEqual({
      success: true,
      data: { name: 'A', description: 'd', images: [{ url: 'https://img/a.jpg' }], tracks: { total: 12 } },
    });
  });

  it('falls back to the stored track count and leaves out a missing cover', async () => {
    h.deezer.getPlaylist.mockResolvedValueOnce({
      success: true,
      data: { id: '15', name: 'D', description: null, imageUrl: null, trackCount: 0 },
    });
    const res = await fetchOtherServicePlaylist(ServiceType.DEEZER, '15', { cache: true, storedTrackCount: 314 });
    expect(h.deezer.getPlaylist).toHaveBeenCalledWith('15', true);
    expect(res.data).toEqual({ name: 'D', description: '', images: [], tracks: { total: 314 } });
  });

  it('passes the service\'s error on', async () => {
    h.tidal.getPlaylist.mockResolvedValueOnce({ success: false, error: 'Tidal says no' });
    expect(await fetchOtherServicePlaylist(ServiceType.TIDAL, 'x', { cache: true })).toEqual({
      success: false,
      error: 'Tidal says no',
    });
    h.youtube.getPlaylist.mockResolvedValueOnce({ success: true });
    expect(await fetchOtherServicePlaylist(ServiceType.YOUTUBE_MUSIC, 'PL', { cache: true })).toEqual({
      success: false,
      error: 'Error getting playlist from youtube_music',
    });
  });
});

describe('fetchOtherServiceTracks', () => {
  it('sends the named options, the storefront to Apple Music only', async () => {
    h.apple.getTracks.mockResolvedValueOnce({ success: true, data: { tracks: [], total: 0 } });
    h.youtube.getTracks.mockResolvedValueOnce({ success: true, data: { tracks: [], total: 0 } });
    const onProgress = vi.fn();

    await fetchOtherServiceTracks(ServiceType.APPLE_MUSIC, 'pl.u-1', {
      cache: true,
      allowDuplicates: true,
      featuredLocale: 'en',
      onProgress,
    });
    await fetchOtherServiceTracks(ServiceType.YOUTUBE_MUSIC, 'PL1', { cache: false, allowDuplicates: false });

    expect(h.apple.getTracks).toHaveBeenCalledWith('pl.u-1', {
      cache: true,
      allowDuplicates: true,
      onProgress,
      storefront: 'gb',
    });
    expect(h.youtube.getTracks).toHaveBeenCalledWith('PL1', {
      cache: false,
      allowDuplicates: false,
      onProgress: undefined,
      storefront: undefined,
    });
  });
});

describe('providerTrackToTrack', () => {
  const base = {
    id: '42',
    name: 'Song',
    artist: 'Artist',
    album: 'Album',
    albumImageUrl: 'https://img/42.jpg',
    releaseDate: '1999-12-31T23:00:00Z',
    isrc: 'NL123',
    previewUrl: 'https://preview/42.m4a',
    serviceType: ServiceType.APPLE_MUSIC,
    serviceLink: 'https://music.apple.com/nl/song/42',
  };
  const clean = (s: string) => s.replace(/ - Remastered.*$/, '');

  it('maps a provider track onto the Spotify route\'s track', () => {
    const track = providerTrackToTrack({ ...base, name: 'Song - Remastered 2011' }, undefined, clean);
    expect(track).toEqual({
      id: '42',
      name: 'Song',
      album: 'Album',
      preview: 'https://preview/42.m4a',
      artist: 'Artist',
      link: 'https://music.apple.com/nl/song/42',
      spotifyLink: '',
      isrc: 'NL123',
      image: 'https://img/42.jpg',
      releaseDate: expect.stringMatching(/^(1999-12-31|2000-01-01)$/),
      trueYear: undefined,
      extraNameAttribute: undefined,
      extraArtistAttribute: undefined,
    });
  });

  it('applies the correction and tolerates missing or broken fields', () => {
    const track = providerTrackToTrack(
      { ...base, releaseDate: 'soon', isrc: undefined, previewUrl: null, albumImageUrl: null },
      { year: 1975, name: 'Fixed', artist: 'Fixed Artist', extraArtistAttribute: 'live' },
      clean
    );
    expect(track).toMatchObject({
      name: 'Fixed',
      artist: 'Fixed Artist',
      trueYear: 1975,
      extraArtistAttribute: 'live',
      releaseDate: '',
      isrc: '',
      preview: '',
      image: '',
    });
  });

  it('drops a track without id, name or artist', () => {
    expect(providerTrackToTrack({ ...base, id: '' }, undefined, clean)).toBeNull();
    expect(providerTrackToTrack({ ...base, name: '' }, undefined, clean)).toBeNull();
    expect(providerTrackToTrack({ ...base, artist: '' }, undefined, clean)).toBeNull();
    // a correction can supply what the service lacks
    expect(providerTrackToTrack({ ...base, artist: '' }, { artist: 'Known' }, clean)?.artist).toBe('Known');
  });
});
