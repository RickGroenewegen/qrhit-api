/**
 * Unit tests for src/externalCardService.ts.
 *
 * Module-boundary mocks:
 *  - axios            → Jumbo gameset API
 *  - cron             → CronJob recorded; asserts the nightly import cron
 *                       does NOT start under ENVIRONMENT=test
 *  - ../../src/prisma → in-memory externalCard model
 *  - ../../src/utils  → isMainServer=false (no EC2 probe)
 * File-based imports (country / musicmatch) read REAL fixture files from a
 * scratch APP_ROOT under PUBLIC_DIR (the methods read process.env.APP_ROOT
 * at call time).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const prismaMock = vi.hoisted(() => ({
  externalCard: {
    findMany: vi.fn(async () => [] as any[]),
    createMany: vi.fn(),
    count: vi.fn(),
  },
}));
vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

const isMainServer = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../../../src/utils', () => ({
  default: class {
    isMainServer = isMainServer;
  },
}));

const cronCalls = vi.hoisted(() => [] as any[][]);
const cronStarts = vi.hoisted(() => ({ count: 0 }));
vi.mock('cron', () => ({
  CronJob: class {
    constructor(...args: any[]) {
      cronCalls.push(args);
    }
    start() {
      cronStarts.count++;
    }
  },
}));

vi.mock('axios');
import axios from 'axios';
import ExternalCardService from '../../../src/externalCardService';

const axiosGet = vi.mocked(axios.get);

// Scratch APP_ROOT fixtures (unique subdir of the test PUBLIC_DIR).
const FIX_ROOT = path.join(process.env['PUBLIC_DIR']!, 'extcard-test');
const APPROOT_VALID = path.join(FIX_ROOT, 'approot');
const APPROOT_EMPTY = path.join(FIX_ROOT, 'empty-approot');
const ORIGINAL_APP_ROOT = process.env['APP_ROOT'];

let service: ExternalCardService;

beforeAll(async () => {
  const jumboDir = path.join(APPROOT_VALID, '_data', 'jumbo');
  fs.mkdirSync(jumboDir, { recursive: true });
  fs.mkdirSync(path.join(APPROOT_EMPTY), { recursive: true });
  fs.writeFileSync(
    path.join(jumboDir, 'nl.json'),
    JSON.stringify({ name: 'NL', cards: { '1': 'spotA', '2': 42 } })
  );
  fs.writeFileSync(path.join(jumboDir, 'bad.json'), JSON.stringify({ nope: true }));
  fs.writeFileSync(path.join(jumboDir, 'notes.txt'), 'not a card file');
  fs.writeFileSync(
    path.join(APPROOT_VALID, '_data', 'musicmatch.json'),
    JSON.stringify({
      p: [
        { i: 7, t: [{ i: 101, l: 'spX' }, { i: 102 }] },
        { t: [{ i: 1, l: 'orphan' }] }, // no playlist id → whole playlist ignored
      ],
    })
  );

  prismaMock.externalCard.findMany.mockResolvedValue([]);
  service = ExternalCardService.getInstance();
  // Let the constructor's async gating (isMainServer().then) settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

beforeEach(() => {
  axiosGet.mockReset();
  prismaMock.externalCard.findMany.mockReset();
  prismaMock.externalCard.findMany.mockResolvedValue([]);
  prismaMock.externalCard.createMany.mockReset();
  prismaMock.externalCard.count.mockReset();
});

afterEach(() => {
  process.env['APP_ROOT'] = ORIGINAL_APP_ROOT;
});

describe('cron gating under test environment', () => {
  it('does NOT start the nightly import cron (gate: main server OR development only)', () => {
    // ENVIRONMENT=test and isMainServer=false → the CronJob must never be
    // constructed or started; no timer or network activity on import.
    expect(process.env['ENVIRONMENT']).toBe('test');
    expect(isMainServer).toHaveBeenCalled();
    expect(cronCalls).toHaveLength(0);
    expect(cronStarts.count).toBe(0);
  });
});

describe('map loading and lookups', () => {
  const dbCards = [
    {
      id: 1,
      cardType: 'jumbo',
      sku: 'aaaa0001',
      cardNumber: '00001',
      countryCode: null,
      playlistId: null,
      spotifyId: 'sp1',
      spotifyLink: 'https://open.spotify.com/track/sp1',
      appleMusicLink: 'https://music.apple.test/1',
      tidalLink: null,
      youtubeMusicLink: null,
      deezerLink: null,
      amazonMusicLink: null,
    },
    {
      id: 2,
      cardType: 'country',
      sku: null,
      cardNumber: '7',
      countryCode: 'nl',
      playlistId: null,
      spotifyId: 'sp2',
      spotifyLink: 'https://open.spotify.com/track/sp2',
      appleMusicLink: null,
      tidalLink: null,
      youtubeMusicLink: null,
      deezerLink: null,
      amazonMusicLink: null,
    },
    {
      id: 3,
      cardType: 'musicmatch',
      sku: null,
      cardNumber: '101',
      countryCode: null,
      playlistId: 'pl9',
      spotifyId: 'sp1', // same track as the jumbo card
      spotifyLink: 'https://open.spotify.com/track/sp1',
      appleMusicLink: null,
      tidalLink: null,
      youtubeMusicLink: null,
      deezerLink: null,
      amazonMusicLink: null,
    },
    {
      // jumbo without sku → not mapped anywhere
      id: 4,
      cardType: 'jumbo',
      sku: null,
      cardNumber: '00009',
      countryCode: null,
      playlistId: null,
      spotifyId: 'spX',
      spotifyLink: null,
      appleMusicLink: null,
      tidalLink: null,
      youtubeMusicLink: null,
      deezerLink: null,
      amazonMusicLink: null,
    },
  ];

  async function loadFixtureMaps() {
    prismaMock.externalCard.findMany.mockResolvedValue(dbCards as any);
    await service.loadMapsFromDatabase();
  }

  it('indexes jumbo by sku_cardNumber, country by code+number (case-insensitive lookup) and musicmatch by playlist_track', async () => {
    await loadFixtureMaps();

    expect(await service.getCardByJumboKey('aaaa0001', '00001')).toEqual({
      id: 1,
      spotifyId: 'sp1',
      spotifyLink: 'https://open.spotify.com/track/sp1',
      appleMusicLink: 'https://music.apple.test/1',
      tidalLink: null,
      youtubeMusicLink: null,
      deezerLink: null,
      amazonMusicLink: null,
    });
    expect(await service.getCardByJumboKey('aaaa0001', '99999')).toBeNull();
    expect(await service.getCardByJumboKey('zzzz', '00009')).toBeNull(); // sku-less card not mapped

    // Lookup lowercases the country code; stored code is 'nl'.
    expect((await service.getCardByCountryKey('NL', '7'))?.id).toBe(2);
    expect(await service.getCardByCountryKey('DE', '7')).toBeNull();
    expect(await service.getCardByCountryKey('NL', '8')).toBeNull();

    expect((await service.getCardByMusicMatchKey('pl9', '101'))?.id).toBe(3);
    expect(await service.getCardByMusicMatchKey('pl9', '102')).toBeNull();
  });

  it('deduplicates concurrent map loads through a single loading promise', async () => {
    prismaMock.externalCard.findMany.mockResolvedValue([]);
    await Promise.all([service.loadMapsFromDatabase(), service.loadMapsFromDatabase()]);
    expect(prismaMock.externalCard.findMany).toHaveBeenCalledTimes(1);
  });

  it('updateCardInCache merges new links into the matching map entry only', async () => {
    await loadFixtureMaps();

    await service.updateCardInCache(
      2,
      'country',
      { countryCode: 'NL', cardNumber: '7' },
      { tidalLink: 'https://tidal.test/2' }
    );
    const updated = await service.getCardByCountryKey('nl', '7');
    expect(updated).toMatchObject({ id: 2, spotifyId: 'sp2', tidalLink: 'https://tidal.test/2' });

    await service.updateCardInCache(
      1,
      'jumbo',
      { sku: 'aaaa0001', cardNumber: '00001' },
      { deezerLink: 'https://deezer.test/1' }
    );
    expect((await service.getCardByJumboKey('aaaa0001', '00001'))?.deezerLink).toBe(
      'https://deezer.test/1'
    );

    // Unknown key: silently no-op.
    await service.updateCardInCache(
      99,
      'musicmatch',
      { playlistId: 'nope', cardNumber: '1' },
      { tidalLink: 'x' }
    );
    expect(await service.getCardByMusicMatchKey('nope', '1')).toBeNull();
  });

  it('updateCardsWithSpotifyIdInCache fans the new links out to every map sharing the spotifyId', async () => {
    await loadFixtureMaps();

    await service.updateCardsWithSpotifyIdInCache('sp1', {
      youtubeMusicLink: 'https://ytm.test/sp1',
    });

    expect((await service.getCardByJumboKey('aaaa0001', '00001'))?.youtubeMusicLink).toBe(
      'https://ytm.test/sp1'
    );
    expect((await service.getCardByMusicMatchKey('pl9', '101'))?.youtubeMusicLink).toBe(
      'https://ytm.test/sp1'
    );
    // sp2 card untouched.
    expect((await service.getCardByCountryKey('nl', '7'))?.youtubeMusicLink).toBeNull();
  });
});

describe('importJumboCards', () => {
  it('maps gamesets to insert rows, skipping cards without number/spotify and gamesets without sku', async () => {
    axiosGet.mockResolvedValue({
      data: {
        gamesets: [
          {
            sku: 'aaaa0001',
            gameset_data: {
              gameset_language: 'en',
              gameset_name: 'Original',
              cards: [
                { CardNumber: '00001', Spotify: 'sp1' },
                { CardNumber: '00002' }, // no spotify id → skipped
              ],
            },
          },
          { gameset_data: { cards: [{ CardNumber: '00003', Spotify: 'sp3' }] } }, // no sku
          { sku: 'bbbb0002' }, // no cards array
        ],
      },
    } as any);
    prismaMock.externalCard.createMany.mockResolvedValue({ count: 1 } as any);

    const result = await service.importJumboCards();

    expect(axiosGet).toHaveBeenCalledWith(
      'https://hitster.jumboplay.com/hitster-assets/gameset_database.json',
      { timeout: 30000 }
    );
    expect(prismaMock.externalCard.createMany).toHaveBeenCalledWith({
      data: [
        {
          cardType: 'jumbo',
          sku: 'aaaa0001',
          cardNumber: '00001',
          spotifyId: 'sp1',
          spotifyLink: 'https://open.spotify.com/track/sp1',
          gamesetLanguage: 'en',
          gamesetName: 'Original',
        },
      ],
      skipDuplicates: true,
    });
    expect(result).toEqual({ total: 1, created: 1, updated: 0, skipped: 1, errors: [] });
  });

  it('inserts in batches of 500 and counts createMany duplicates as skipped', async () => {
    const cards = Array.from({ length: 502 }, (_, i) => ({
      CardNumber: String(i + 1),
      Spotify: `sp${i + 1}`,
    }));
    axiosGet.mockResolvedValue({
      data: { gamesets: [{ sku: 'aaaa0001', gameset_data: { cards } }] },
    } as any);
    prismaMock.externalCard.createMany
      .mockResolvedValueOnce({ count: 500 } as any)
      .mockResolvedValueOnce({ count: 1 } as any); // 1 of 2 was a duplicate

    const result = await service.importJumboCards();

    expect(prismaMock.externalCard.createMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.externalCard.createMany.mock.calls[0][0].data).toHaveLength(500);
    expect(prismaMock.externalCard.createMany.mock.calls[1][0].data).toHaveLength(2);
    expect(result).toEqual({ total: 502, created: 501, updated: 0, skipped: 1, errors: [] });
  });

  it('reports an invalid API response shape and fetch failures as errors', async () => {
    axiosGet.mockResolvedValueOnce({ data: {} } as any);
    let result = await service.importJumboCards();
    expect(result.errors).toEqual(['Invalid response format: no gamesets array']);
    expect(result.created).toBe(0);

    axiosGet.mockRejectedValueOnce(new Error('jumbo down'));
    result = await service.importJumboCards();
    expect(result.errors).toEqual(['Failed to fetch Jumbo data: jumbo down']);
  });
});

describe('importCountryCards', () => {
  it('reads _data/jumbo/*.json fixtures, lowercases the country and skips non-string spotify ids', async () => {
    process.env['APP_ROOT'] = APPROOT_VALID;
    prismaMock.externalCard.createMany.mockResolvedValue({ count: 1 } as any);

    const result = await service.importCountryCards();

    expect(prismaMock.externalCard.createMany).toHaveBeenCalledWith({
      data: [
        {
          cardType: 'country',
          countryCode: 'nl',
          cardNumber: '1',
          spotifyId: 'spotA',
          spotifyLink: 'https://open.spotify.com/track/spotA',
        },
      ],
      skipDuplicates: true,
    });
    expect(result).toEqual({
      total: 1,
      created: 1,
      updated: 0,
      skipped: 1, // card '2' has a numeric (non-string) spotify id
      errors: ['Invalid format in bad.json'],
    });
  });

  it('fails fast when the data directory does not exist', async () => {
    process.env['APP_ROOT'] = APPROOT_EMPTY;

    const result = await service.importCountryCards();

    expect(result.total).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Country card data directory not found');
    expect(prismaMock.externalCard.createMany).not.toHaveBeenCalled();
  });
});

describe('importMusicMatchCards', () => {
  it('maps playlists/tracks to insert rows with stringified ids and skips tracks without spotify link', async () => {
    process.env['APP_ROOT'] = APPROOT_VALID;
    prismaMock.externalCard.createMany.mockResolvedValue({ count: 1 } as any);

    const result = await service.importMusicMatchCards();

    expect(prismaMock.externalCard.createMany).toHaveBeenCalledWith({
      data: [
        {
          cardType: 'musicmatch',
          playlistId: '7',
          cardNumber: '101',
          spotifyId: 'spX',
          spotifyLink: 'https://open.spotify.com/track/spX',
        },
      ],
      skipDuplicates: true,
    });
    expect(result).toEqual({ total: 1, created: 1, updated: 0, skipped: 1, errors: [] });
  });

  it('reports a missing data file as an error', async () => {
    process.env['APP_ROOT'] = APPROOT_EMPTY;

    const result = await service.importMusicMatchCards();

    expect(result.total).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('MusicMatch data file not found');
  });
});

describe('importAllExternalCards', () => {
  it('aggregates the three importers and reloads the in-memory maps afterwards', async () => {
    process.env['APP_ROOT'] = APPROOT_VALID;
    axiosGet.mockRejectedValue(new Error('jumbo down'));
    prismaMock.externalCard.createMany.mockResolvedValue({ count: 1 } as any);

    const result = await service.importAllExternalCards();

    expect(result).toEqual({
      total: 2, // 1 country + 1 musicmatch
      created: 2,
      updated: 0,
      skipped: 2, // 1 invalid country spotify id + 1 musicmatch track without link
      errors: ['Failed to fetch Jumbo data: jumbo down', 'Invalid format in bad.json'],
    });
    // Maps are reloaded from the database after the import.
    expect(prismaMock.externalCard.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('getStats', () => {
  it('returns the ten counters in their query order', async () => {
    const values = [100, 10, 20, 30, 40, 50, 60, 70, 80, 90];
    for (const v of values) {
      prismaMock.externalCard.count.mockResolvedValueOnce(v as any);
    }

    expect(await service.getStats()).toEqual({
      total: 100,
      jumbo: 10,
      country: 20,
      musicmatch: 30,
      withSpotify: 40,
      withAppleMusic: 50,
      withTidal: 60,
      withYoutubeMusic: 70,
      withDeezer: 80,
      withAmazonMusic: 90,
    });
    expect(prismaMock.externalCard.count).toHaveBeenNthCalledWith(2, {
      where: { cardType: 'jumbo' },
    });
    expect(prismaMock.externalCard.count).toHaveBeenNthCalledWith(5, {
      where: { spotifyLink: { not: null } },
    });
    expect(prismaMock.externalCard.count).toHaveBeenNthCalledWith(10, {
      where: { amazonMusicLink: { not: null } },
    });
  });
});
