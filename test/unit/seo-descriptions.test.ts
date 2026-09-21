import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * seoDescriptions.ts: the brief builder is pure and tested directly; the
 * service is exercised with its collaborators mocked (no OpenAI, no DB, no
 * Redis) to pin down what gets written back to the row.
 */

const { prisma, cache, chatgpt, data } = vi.hoisted(() => ({
  prisma: {
    playlist: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
  },
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
    refreshLock: vi.fn(),
  },
  chatgpt: {
    writeSeoPlaylistDescription: vi.fn(),
    translateSeoDescription: vi.fn(),
  },
  data: {
    getTracks: vi.fn(),
    clearPlaylistCache: vi.fn(),
  },
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prisma },
}));
vi.mock('../../src/cache', () => ({
  default: { getInstance: () => cache },
}));
vi.mock('../../src/data', () => ({
  default: { getInstance: () => data },
}));
vi.mock('../../src/chatgpt', () => ({
  ChatGPT: class {
    writeSeoPlaylistDescription = chatgpt.writeSeoPlaylistDescription;
    translateSeoDescription = chatgpt.translateSeoDescription;
  },
}));
vi.mock('../../src/spotify', () => ({
  CACHE_KEY_PLAYLIST: 'playlist2_',
}));
vi.mock('../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

import SeoDescriptions, {
  buildSeoBrief,
  spreadSample,
} from '../../src/seoDescriptions';
import Translation from '../../src/translation';

const allLocales = new Translation().allLocales;

describe('spreadSample', () => {
  it('returns the list untouched when it fits', () => {
    expect(spreadSample([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it('keeps order and covers the whole list', () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const sample = spreadSample(items, 120);
    expect(sample).toHaveLength(120);
    expect(sample[0]).toBe(0);
    expect(sample[119]).toBeGreaterThan(980);
    expect([...sample].sort((a, b) => a - b)).toEqual(sample);
  });
});

describe('buildSeoBrief', () => {
  const tracks = [
    { artist: 'Hillsong Worship', name: 'Oceans', year: 2013 },
    { artist: 'Hillsong Worship', name: 'Cornerstone', year: 2012 },
    { artist: 'Hillsong Worship', name: 'Mighty To Save', year: 2006 },
    { artist: 'Opwekking', name: 'Dit is de dag', year: 1999 },
    { artist: 'Opwekking', name: 'De rivier', year: 1996 },
    { artist: 'Chris Tomlin', name: 'Good Good Father', year: 2015 },
    { artist: 'Cedarmont Kids', name: 'Father Abraham', year: 0 },
    { artist: '', name: 'Nameless', year: 2020 },
  ];

  it('derives the year span and decade split from real years only', () => {
    const brief = buildSeoBrief('Christelijke Muziek', null, null, tracks);
    expect(brief.trackCount).toBe(8);
    expect(brief.yearRange).toEqual({ from: 1996, to: 2020 });
    expect(brief.decadeSplit[0]).toEqual({ label: '2010s', percent: 43 });
    expect(brief.decadeSplit.map((d) => d.label)).not.toContain('0s');
  });

  it('names the repeated artists first', () => {
    const brief = buildSeoBrief('x', null, null, tracks);
    expect(brief.topArtists[0]).toEqual({ name: 'Hillsong Worship', count: 3 });
    expect(brief.topArtists[1]).toEqual({ name: 'Opwekking', count: 2 });
    expect(brief.topArtists.map((a) => a.name)).not.toContain('');
  });

  it('falls back to the first artists when nobody repeats', () => {
    const unique = [
      { artist: 'A', name: '1', year: 2001 },
      { artist: 'B', name: '2', year: 2002 },
      { artist: 'C', name: '3', year: 2003 },
    ];
    const brief = buildSeoBrief('x', null, null, unique);
    expect(brief.topArtists.map((a) => a.name)).toEqual(['A', 'B', 'C']);
  });

  it('writes one line per track with the year when known', () => {
    const brief = buildSeoBrief('x', null, null, tracks);
    expect(brief.sampleTracks).toContain('Hillsong Worship - Oceans (2013)');
    expect(brief.sampleTracks).toContain('Cedarmont Kids - Father Abraham');
    expect(brief.sampleTracks).toHaveLength(7);
    expect(brief.sampleIsPartial).toBe(false);
  });

  it('samples long lists and says so', () => {
    const long = Array.from({ length: 500 }, (_, i) => ({
      artist: `Artist ${i}`,
      name: `Track ${i}`,
      year: 1980 + (i % 40),
    }));
    const brief = buildSeoBrief('x', null, null, long);
    expect(brief.sampleTracks).toHaveLength(120);
    expect(brief.sampleIsPartial).toBe(true);
  });

  it('trims and clips the customer text, dropping empty ones', () => {
    const brief = buildSeoBrief('x', '   ', 'a'.repeat(2000), tracks);
    expect(brief.customerDescription).toBeNull();
    expect(brief.serviceDescription).toHaveLength(1500);
  });
});

describe('SeoDescriptions.generateForPlaylist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.playlist.findUnique.mockResolvedValue({
      id: 7,
      playlistId: 'spotify123',
      slug: 'say-oe-ah',
      name: 'Say oe ah',
      promotionalDescription: 'Fuck off Corona playlist april 2020',
      description_en: null,
      seoDescriptionGenerated: false,
    });
    data.getTracks.mockResolvedValue([
      { artist: 'The Strokes', name: 'Bad Decisions', year: 2020 },
      { artist: 'Pavement', name: 'Harness Your Hopes', year: 1999 },
    ]);
    cache.get.mockResolvedValue(null);
    chatgpt.writeSeoPlaylistDescription.mockResolvedValue(
      'Say oe ah on QR music cards: indie rock. Two tracks from 1999 to 2020.'
    );
    chatgpt.translateSeoDescription.mockImplementation(
      async (_text: string, _name: string, locales: string[]) =>
        Object.fromEntries(
          locales.filter((l) => l !== 'sv').map((l) => [l, `${l}: vertaald`])
        )
    );
  });

  it('feeds the customer text as intent and stores every locale', async () => {
    const result = await SeoDescriptions.getInstance().generateForPlaylist('spotify123');

    expect(result.description).toMatch(/^Say oe ah on QR music cards/);
    const brief = chatgpt.writeSeoPlaylistDescription.mock.calls[0][0];
    expect(brief.customerDescription).toBe('Fuck off Corona playlist april 2020');
    expect(brief.sampleTracks).toEqual([
      'The Strokes - Bad Decisions (2020)',
      'Pavement - Harness Your Hopes (1999)',
    ]);

    const written = prisma.playlist.update.mock.calls[0][0];
    expect(written.where).toEqual({ id: 7 });
    expect(written.data.seoDescriptionGenerated).toBe(true);
    expect(written.data.markedForMerchantCenter).toBe(true);
    expect(written.data.description_en).toBe(result.description);
    expect(written.data.description_nl).toBe('nl: vertaald');
    // The translator skipped Swedish: English is stored, never nothing.
    expect(written.data.description_sv).toBe(result.description);
    for (const locale of allLocales) {
      expect(written.data[`description_${locale}`]).toBeTruthy();
    }
    expect(data.clearPlaylistCache).toHaveBeenCalledWith('spotify123', 'say-oe-ah');
  });

  it('does not feed an earlier SEO text back in as the customer text', async () => {
    prisma.playlist.findUnique.mockResolvedValue({
      id: 7,
      playlistId: 'spotify123',
      slug: 'say-oe-ah',
      name: 'Say oe ah',
      promotionalDescription: null,
      description_en: 'Earlier generated copy',
      seoDescriptionGenerated: true,
    });
    await SeoDescriptions.getInstance().generateForPlaylist('spotify123');
    const brief = chatgpt.writeSeoPlaylistDescription.mock.calls[0][0];
    expect(brief.customerDescription).toBeNull();
  });

  it('uses a hand-typed English description as the customer text', async () => {
    prisma.playlist.findUnique.mockResolvedValue({
      id: 7,
      playlistId: 'spotify123',
      slug: 'say-oe-ah',
      name: 'Say oe ah',
      promotionalDescription: null,
      description_en: 'Typed in by the admin',
      seoDescriptionGenerated: false,
    });
    await SeoDescriptions.getInstance().generateForPlaylist('spotify123');
    const brief = chatgpt.writeSeoPlaylistDescription.mock.calls[0][0];
    expect(brief.customerDescription).toBe('Typed in by the admin');
  });

  it('reads the streaming-service description from the page cache', async () => {
    cache.get.mockImplementation(async (key: string) =>
      key === 'playlist2_say-oe-ah'
        ? JSON.stringify({ description: 'Spotify says hi' })
        : null
    );
    await SeoDescriptions.getInstance().generateForPlaylist('spotify123');
    const brief = chatgpt.writeSeoPlaylistDescription.mock.calls[0][0];
    expect(brief.serviceDescription).toBe('Spotify says hi');
  });

  it('refuses a playlist without stored tracks and writes nothing', async () => {
    data.getTracks.mockResolvedValue([]);
    await expect(
      SeoDescriptions.getInstance().generateForPlaylist('spotify123')
    ).rejects.toThrow(/no stored tracks/);
    expect(prisma.playlist.update).not.toHaveBeenCalled();
  });

  it('writes nothing when the model returns nothing', async () => {
    chatgpt.writeSeoPlaylistDescription.mockResolvedValue(null);
    await expect(
      SeoDescriptions.getInstance().generateForPlaylist('spotify123')
    ).rejects.toThrow(/no description/);
    expect(prisma.playlist.update).not.toHaveBeenCalled();
  });
});

describe('SeoDescriptions bulk run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cache.get.mockResolvedValue(null);
    cache.acquireLock.mockResolvedValue(true);
  });

  it('refuses to start while another run holds the lock', async () => {
    cache.acquireLock.mockResolvedValue(false);
    cache.get.mockResolvedValue(
      JSON.stringify({ running: true, total: 10, done: 3 })
    );
    const result = await SeoDescriptions.getInstance().startBulkRun();
    expect(result.started).toBe(false);
    if (!result.started) {
      expect(result.status.running).toBe(true);
      expect(result.status.done).toBe(3);
    }
    expect(prisma.playlist.findMany).not.toHaveBeenCalled();
  });

  it('only visits featured playlists without an SEO description', async () => {
    prisma.playlist.findMany.mockResolvedValue([]);
    const result = await SeoDescriptions.getInstance().startBulkRun();
    expect(result).toEqual({ started: true, total: 0 });
    expect(prisma.playlist.findMany.mock.calls[0][0].where).toEqual({
      featured: true,
      seoDescriptionGenerated: false,
    });
    expect(cache.releaseLock).toHaveBeenCalled();
  });

  it('reports an empty status when nothing has run', async () => {
    const status = await SeoDescriptions.getInstance().getBulkStatus();
    expect(status.running).toBe(false);
    expect(status.total).toBe(0);
    expect(status.failed).toEqual([]);
  });
});
