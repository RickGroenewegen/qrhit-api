import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for MusicProviderFactory: provider selection per ServiceType,
 * default/unknown handling, singleton behavior, isSupported and the
 * exported service mapping tables.
 *
 * All five provider modules are mocked so no real provider (and none of
 * their I/O collaborators) is ever constructed.
 */

const h = vi.hoisted(() => ({
  spotify: { marker: 'spotify-provider' },
  youtube: { marker: 'youtube-provider' },
  tidal: { marker: 'tidal-provider' },
  deezer: { marker: 'deezer-provider' },
  apple: { marker: 'apple-provider' },
  spotifyGetInstance: vi.fn(),
  youtubeGetInstance: vi.fn(),
  tidalGetInstance: vi.fn(),
  deezerGetInstance: vi.fn(),
  appleGetInstance: vi.fn(),
}));

h.spotifyGetInstance.mockImplementation(() => h.spotify);
h.youtubeGetInstance.mockImplementation(() => h.youtube);
h.tidalGetInstance.mockImplementation(() => h.tidal);
h.deezerGetInstance.mockImplementation(() => h.deezer);
h.appleGetInstance.mockImplementation(() => h.apple);

vi.mock('../../../src/providers/SpotifyProvider', () => ({
  default: { getInstance: h.spotifyGetInstance },
}));
vi.mock('../../../src/providers/YouTubeMusicProvider', () => ({
  default: { getInstance: h.youtubeGetInstance },
}));
vi.mock('../../../src/providers/TidalProvider', () => ({
  default: { getInstance: h.tidalGetInstance },
}));
vi.mock('../../../src/providers/DeezerProvider', () => ({
  default: { getInstance: h.deezerGetInstance },
}));
vi.mock('../../../src/providers/AppleMusicProvider', () => ({
  default: { getInstance: h.appleGetInstance },
}));

import MusicProviderFactory, {
  serviceColumnMap,
  serviceCheckedColumnMap,
  serviceTypeMap,
} from '../../../src/providers/MusicProviderFactory';
import { ServiceType } from '../../../src/enums/ServiceType';

beforeEach(() => {
  h.spotifyGetInstance.mockClear();
  h.youtubeGetInstance.mockClear();
  h.tidalGetInstance.mockClear();
  h.deezerGetInstance.mockClear();
  h.appleGetInstance.mockClear();
});

describe('MusicProviderFactory.getInstance', () => {
  it('returns the same factory instance every time', () => {
    expect(MusicProviderFactory.getInstance()).toBe(MusicProviderFactory.getInstance());
  });
});

describe('MusicProviderFactory.getProvider', () => {
  const factory = MusicProviderFactory.getInstance();

  it('returns the matching provider singleton for each service type', () => {
    expect(factory.getProvider(ServiceType.SPOTIFY)).toBe(h.spotify);
    expect(factory.getProvider(ServiceType.YOUTUBE_MUSIC)).toBe(h.youtube);
    expect(factory.getProvider(ServiceType.TIDAL)).toBe(h.tidal);
    expect(factory.getProvider(ServiceType.DEEZER)).toBe(h.deezer);
    expect(factory.getProvider(ServiceType.APPLE_MUSIC)).toBe(h.apple);
  });

  it('accepts the raw string enum values', () => {
    expect(factory.getProvider('youtube_music')).toBe(h.youtube);
    expect(factory.getProvider('apple_music')).toBe(h.apple);
  });

  it('defaults to Spotify when no service type is given', () => {
    expect(factory.getProvider()).toBe(h.spotify);
    expect(factory.getProvider(undefined)).toBe(h.spotify);
  });

  it('defaults to Spotify for unknown service types', () => {
    expect(factory.getProvider('amazon')).toBe(h.spotify);
    expect(factory.getProvider('napster')).toBe(h.spotify);
    // Short API names are NOT ServiceType values: "youtube" falls through
    // to the Spotify default (use serviceTypeMap to translate first).
    expect(factory.getProvider('youtube')).toBe(h.spotify);
    expect(h.youtubeGetInstance).not.toHaveBeenCalled();
  });

  it('delegates instance management to each provider getInstance', () => {
    factory.getProvider(ServiceType.TIDAL);
    factory.getProvider(ServiceType.TIDAL);
    expect(h.tidalGetInstance).toHaveBeenCalledTimes(2);
    expect(h.spotifyGetInstance).not.toHaveBeenCalled();
  });
});

describe('MusicProviderFactory.isSupported', () => {
  const factory = MusicProviderFactory.getInstance();

  it('supports all five ServiceType values', () => {
    for (const st of [
      ServiceType.SPOTIFY,
      ServiceType.YOUTUBE_MUSIC,
      ServiceType.TIDAL,
      ServiceType.DEEZER,
      ServiceType.APPLE_MUSIC,
    ]) {
      expect(factory.isSupported(st)).toBe(true);
    }
  });

  it('rejects unknown services and short names', () => {
    expect(factory.isSupported('amazon')).toBe(false);
    expect(factory.isSupported('youtube')).toBe(false); // short name, not enum value
    expect(factory.isSupported('')).toBe(false);
  });
});

describe('service mapping tables', () => {
  it('maps short service names to DB link columns', () => {
    expect(serviceColumnMap).toEqual({
      spotify: 'spotifyLink',
      youtube: 'youtubeMusicLink',
      deezer: 'deezerLink',
      apple: 'appleMusicLink',
      tidal: 'tidalLink',
      amazon: 'amazonMusicLink',
    });
  });

  it('maps short service names to checked-by-search columns', () => {
    expect(serviceCheckedColumnMap['youtube']).toBe('youtubeCheckedBySearch');
    expect(serviceCheckedColumnMap['apple']).toBe('appleCheckedBySearch');
  });

  it('maps short service names to ServiceType enum values', () => {
    expect(serviceTypeMap['youtube']).toBe(ServiceType.YOUTUBE_MUSIC);
    expect(serviceTypeMap['apple']).toBe(ServiceType.APPLE_MUSIC);
    expect(serviceTypeMap['spotify']).toBe(ServiceType.SPOTIFY);
    // amazon has a DB column but no ServiceType — not loadable via a provider
    expect(serviceTypeMap['amazon']).toBeUndefined();
  });
});
