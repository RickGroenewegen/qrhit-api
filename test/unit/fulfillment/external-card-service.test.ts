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
    findFirst: vi.fn(async () => null as any),
    findUnique: vi.fn(async () => null as any),
    createMany: vi.fn(),
    count: vi.fn(),
  },
}));
vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

const cacheMock = vi.hoisted(() => ({
  del: vi.fn(async () => undefined),
  delPatternNonBlocking: vi.fn(async () => 0),
}));
vi.mock('../../../src/cache', () => ({
  default: { getInstance: () => cacheMock },
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
  prismaMock.externalCard.findFirst.mockReset();
  prismaMock.externalCard.findFirst.mockResolvedValue(null);
  prismaMock.externalCard.findUnique.mockReset();
  prismaMock.externalCard.findUnique.mockResolvedValue(null);
  prismaMock.externalCard.createMany.mockReset();
  prismaMock.externalCard.count.mockReset();
  cacheMock.del.mockReset();
  cacheMock.delPatternNonBlocking.mockReset();
  cacheMock.delPatternNonBlocking.mockResolvedValue(0);
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

describe('lookups and cache invalidation', () => {
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

  // Simulates the database: findFirst answers with the first fixture whose
  // columns match every field in the where clause.
  function serveFixturesFromDb() {
    prismaMock.externalCard.findFirst.mockImplementation(async ({ where }: any) => {
      const hit = dbCards.find((card: any) =>
        Object.entries(where).every(([field, value]) => card[field] === value)
      );
      if (!hit) return null;
      const { cardType, sku, cardNumber, countryCode, playlistId, ...data } = hit as any;
      return data;
    });
  }

  it('looks jumbo cards up by sku + number, country cards by lowercased code + number and musicmatch by playlist + track, straight from the database', async () => {
    serveFixturesFromDb();

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
    expect(prismaMock.externalCard.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { cardType: 'jumbo', sku: 'aaaa0001', cardNumber: '00001' },
      })
    );
    expect(await service.getCardByJumboKey('aaaa0001', '99999')).toBeNull();

    // Lookup lowercases the country code; stored code is 'nl'.
    expect((await service.getCardByCountryKey('NL', '7'))?.id).toBe(2);
    expect(prismaMock.externalCard.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { cardType: 'country', countryCode: 'nl', cardNumber: '7' },
      })
    );
    expect(await service.getCardByCountryKey('DE', '7')).toBeNull();
    expect(await service.getCardByCountryKey('NL', '8')).toBeNull();

    expect((await service.getCardByMusicMatchKey('pl9', '101'))?.id).toBe(3);
    expect(prismaMock.externalCard.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { cardType: 'musicmatch', playlistId: 'pl9', cardNumber: '101' },
      })
    );
    expect(await service.getCardByMusicMatchKey('pl9', '102')).toBeNull();
  });

  it('never caches lookups in memory: every call hits the database', async () => {
    serveFixturesFromDb();
    await service.getCardByCountryKey('nl', '7');
    await service.getCardByCountryKey('nl', '7');
    expect(prismaMock.externalCard.findFirst).toHaveBeenCalledTimes(2);
  });

  it('clearCacheForCard deletes the card-identity key and skips rows without an identifier', async () => {
    expect(await service.clearCacheForCard(dbCards[0] as any)).toBe(true);
    expect(cacheMock.del).toHaveBeenLastCalledWith('qrlink2_extcard_jumbo_aaaa0001_00001');

    expect(await service.clearCacheForCard({ ...dbCards[1], countryCode: 'NL' } as any)).toBe(true);
    expect(cacheMock.del).toHaveBeenLastCalledWith('qrlink2_extcard_country_nl_7');

    expect(await service.clearCacheForCard(dbCards[2] as any)).toBe(true);
    expect(cacheMock.del).toHaveBeenLastCalledWith('qrlink2_extcard_musicmatch_pl9_101');

    // Jumbo card without sku: nothing to clear.
    expect(await service.clearCacheForCard(dbCards[3] as any)).toBe(false);
    expect(cacheMock.del).toHaveBeenCalledTimes(3);
  });

  it('clearCacheForCardId resolves the card first and reports unknown ids', async () => {
    prismaMock.externalCard.findUnique.mockResolvedValueOnce(dbCards[1] as any);
    expect(await service.clearCacheForCardId(2)).toBe(true);
    expect(prismaMock.externalCard.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 2 } })
    );
    expect(cacheMock.del).toHaveBeenCalledWith('qrlink2_extcard_country_nl_7');

    expect(await service.clearCacheForCardId(999)).toBe(false);
    expect(cacheMock.del).toHaveBeenCalledTimes(1);
  });

  it('clearCacheForSpotifyId clears every card sharing the track and counts them', async () => {
    prismaMock.externalCard.findMany.mockResolvedValueOnce(
      dbCards.filter((c) => c.spotifyId === 'sp1') as any
    );

    // sp1 is shared by the jumbo card, the musicmatch card and the sku-less card.
    expect(await service.clearCacheForSpotifyId('sp1')).toBe(2);
    expect(prismaMock.externalCard.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { spotifyId: 'sp1' } })
    );
    expect(cacheMock.del).toHaveBeenCalledTimes(2);
    expect(cacheMock.del).toHaveBeenCalledWith('qrlink2_extcard_jumbo_aaaa0001_00001');
    expect(cacheMock.del).toHaveBeenCalledWith('qrlink2_extcard_musicmatch_pl9_101');
  });

  it('clearAllCardCaches removes every key under the card prefix and returns the count', async () => {
    cacheMock.delPatternNonBlocking.mockResolvedValueOnce(17);
    expect(await service.clearAllCardCaches()).toBe(17);
    expect(cacheMock.delPatternNonBlocking).toHaveBeenCalledWith('qrlink2_extcard_*');
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
  it('aggregates the three importers and drops cached scan results when rows were created', async () => {
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
    // New rows may already be cached as "no mapping found" from earlier scans.
    expect(cacheMock.delPatternNonBlocking).toHaveBeenCalledWith('qrlink2_extcard_*');
  });

  it('leaves the scan cache alone when the import created nothing', async () => {
    process.env['APP_ROOT'] = APPROOT_VALID;
    axiosGet.mockRejectedValue(new Error('jumbo down'));
    prismaMock.externalCard.createMany.mockResolvedValue({ count: 0 } as any);

    const result = await service.importAllExternalCards();

    expect(result.created).toBe(0);
    expect(cacheMock.delPatternNonBlocking).not.toHaveBeenCalled();
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
