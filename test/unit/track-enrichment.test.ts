import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/trackEnrichment.ts.
 *
 * The module creates a cron job and calls PrismaInstance in its constructor.
 * We neutralize both before import:
 *  - src/prisma  → in-memory track stub (no MariaDB)
 *  - cron        → no-op CronJob
 *  - src/utils   → isMainServer returns false
 *  - cluster     → isPrimary = false (avoids the logging branch)
 *
 * After import we directly test the lookup/enrichment logic which is fully
 * in-memory once the maps are populated.
 */

const trackRows = vi.hoisted(
  () =>
    [] as Array<{
      trackId: string | null;
      isrc: string | null;
      year: number;
      name: string;
      artist: string;
    }>
);

const prismaMock = vi.hoisted(() => ({
  track: {
    findMany: vi.fn(async () => trackRows),
  },
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

vi.mock('cron', () => ({
  CronJob: class {
    constructor() {}
    start() {}
  },
}));

vi.mock('../../src/utils', () => ({
  default: class {
    isMainServer = vi.fn(async () => false);
  },
}));

vi.mock('cluster', () => ({
  default: { isPrimary: false },
  isPrimary: false,
}));

vi.mock('../../src/logger', () => ({
  default: class {
    log = vi.fn();
  },
}));

import TrackEnrichment from '../../src/trackEnrichment';

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function seed(rows: typeof trackRows) {
  trackRows.length = 0;
  rows.forEach((r) => trackRows.push(r));
}

// Each test suite reloads maps by calling refreshTrackEnrichmentMaps.
// We get a fresh singleton — because TrackEnrichment is a singleton we need
// to reload maps manually after seeding the prisma mock.
let svc: TrackEnrichment;
beforeEach(async () => {
  vi.clearAllMocks();
  // Singleton is already created by the import above. Just reset maps via refresh.
  svc = TrackEnrichment.getInstance();
});

// ──────────────────────────────────────────────
// getByTrackId
// ──────────────────────────────────────────────

describe('TrackEnrichment.getByTrackId', () => {
  it('returns enrichment data after maps are loaded', async () => {
    seed([{ trackId: 'spotify:abc', isrc: 'NLRD71400111', year: 1980, name: 'Song A', artist: 'Artist A' }]);
    await svc.refreshTrackEnrichmentMaps();
    const result = svc.getByTrackId('spotify:abc');
    expect(result).toEqual({ year: 1980, name: 'Song A', artist: 'Artist A' });
  });

  it('returns undefined for unknown trackId', async () => {
    seed([]);
    await svc.refreshTrackEnrichmentMaps();
    expect(svc.getByTrackId('unknown')).toBeUndefined();
  });

  it('skips rows with missing year/name/artist', async () => {
    seed([{ trackId: 'id1', isrc: null, year: 0, name: '', artist: 'A' }]);
    await svc.refreshTrackEnrichmentMaps();
    // Row skipped because year=0 is falsy
    expect(svc.getByTrackId('id1')).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// getByIsrc
// ──────────────────────────────────────────────

describe('TrackEnrichment.getByIsrc', () => {
  it('returns enrichment for ISRC', async () => {
    seed([{ trackId: null, isrc: 'GBUM71029604', year: 2003, name: 'Crazy', artist: 'Gnarls Barkley' }]);
    await svc.refreshTrackEnrichmentMaps();
    expect(svc.getByIsrc('GBUM71029604')).toMatchObject({ year: 2003, name: 'Crazy' });
  });

  it('returns undefined when ISRC is null or not found', async () => {
    seed([{ trackId: 't1', isrc: null, year: 2000, name: 'X', artist: 'Y' }]);
    await svc.refreshTrackEnrichmentMaps();
    expect(svc.getByIsrc('NOTHERE')).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// getByArtistTitle
// ──────────────────────────────────────────────

describe('TrackEnrichment.getByArtistTitle', () => {
  it('matches case-insensitively and with surrounding spaces', async () => {
    seed([{ trackId: 't2', isrc: 'XX001', year: 1995, name: 'Wonderwall', artist: 'Oasis' }]);
    await svc.refreshTrackEnrichmentMaps();
    expect(svc.getByArtistTitle('OASIS', ' Wonderwall ')).toMatchObject({ year: 1995 });
  });

  it('returns undefined when artist+title combo is unknown', async () => {
    seed([]);
    await svc.refreshTrackEnrichmentMaps();
    expect(svc.getByArtistTitle('Nobody', 'Nothing')).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// enrichTrack (waterfall: id → isrc → artist+title)
// ──────────────────────────────────────────────

describe('TrackEnrichment.enrichTrack', () => {
  beforeEach(async () => {
    seed([
      { trackId: 'tid1', isrc: 'ISRC001', year: 1988, name: 'Never Gonna Give You Up', artist: 'Rick Astley' },
      { trackId: null, isrc: 'ISRC002', year: 1994, name: 'All I Want for Christmas', artist: 'Mariah Carey' },
    ]);
    await svc.refreshTrackEnrichmentMaps();
  });

  it('priority 1: returns by trackId', () => {
    expect(svc.enrichTrack({ id: 'tid1' })).toMatchObject({ year: 1988 });
  });

  it('priority 2: falls back to ISRC when id not found', () => {
    expect(svc.enrichTrack({ id: 'unknown', isrc: 'ISRC001' })).toMatchObject({ year: 1988 });
  });

  it('priority 2: finds by ISRC without id', () => {
    expect(svc.enrichTrack({ isrc: 'ISRC002' })).toMatchObject({ year: 1994 });
  });

  it('priority 3: falls back to artist+title', () => {
    expect(svc.enrichTrack({ artist: 'rick astley', name: 'never gonna give you up' })).toMatchObject({ year: 1988 });
  });

  it('returns undefined when nothing matches', () => {
    expect(svc.enrichTrack({ id: 'nope', isrc: 'NOPE', artist: 'Nobody', name: 'Nothing' })).toBeUndefined();
  });

  it('returns undefined with empty track object', () => {
    expect(svc.enrichTrack({})).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// enrichTracksByArtistTitle (batch)
// ──────────────────────────────────────────────

describe('TrackEnrichment.enrichTracksByArtistTitle', () => {
  beforeEach(async () => {
    seed([
      { trackId: 't3', isrc: 'ISRC003', year: 1977, name: 'Hotel California', artist: 'Eagles' },
    ]);
    await svc.refreshTrackEnrichmentMaps();
  });

  it('enriches matched tracks with trueYear', () => {
    const tracks = [{ name: 'Hotel California', artist: 'Eagles', isrc: 'ISRC003' }];
    const result = svc.enrichTracksByArtistTitle(tracks);
    expect(result[0].trueYear).toBe(1977);
  });

  it('leaves unmatched tracks unchanged (no trueYear)', () => {
    const tracks = [{ name: 'Unknown Song', artist: 'Unknown Artist' }];
    const result = svc.enrichTracksByArtistTitle(tracks);
    expect(result[0]).not.toHaveProperty('trueYear');
  });

  it('ISRC takes priority over artist+title match', async () => {
    // Add a second track with same artist+title but different year via different ISRC
    seed([
      { trackId: 't3', isrc: 'ISRC003', year: 1977, name: 'Hotel California', artist: 'Eagles' },
      { trackId: 't4', isrc: 'ISRC004', year: 2001, name: 'Hotel California', artist: 'Eagles' }, // live version
    ]);
    await svc.refreshTrackEnrichmentMaps();
    const tracks = [{ name: 'Hotel California', artist: 'Eagles', isrc: 'ISRC004' }];
    const result = svc.enrichTracksByArtistTitle(tracks);
    // ISRC004 should return year 2001
    expect(result[0].trueYear).toBe(2001);
  });

  it('preserves all original track properties', () => {
    const tracks = [{ name: 'Hotel California', artist: 'Eagles', extraProp: 'kept' }];
    const result = svc.enrichTracksByArtistTitle(tracks);
    expect(result[0].extraProp).toBe('kept');
  });
});

// ──────────────────────────────────────────────
// getStats
// ──────────────────────────────────────────────

describe('TrackEnrichment.getStats', () => {
  it('returns counts for all three maps', async () => {
    seed([
      { trackId: 'id1', isrc: 'ISRC-A', year: 2000, name: 'Song', artist: 'Band' },
    ]);
    await svc.refreshTrackEnrichmentMaps();
    const stats = svc.getStats();
    expect(stats.byTrackId).toBe(1);
    expect(stats.byIsrc).toBe(1);
    expect(stats.byArtistTitle).toBe(1);
  });

  it('returns zeros after empty refresh', async () => {
    seed([]);
    await svc.refreshTrackEnrichmentMaps();
    const stats = svc.getStats();
    expect(stats.byTrackId).toBe(0);
    expect(stats.byIsrc).toBe(0);
    expect(stats.byArtistTitle).toBe(0);
  });
});

// ──────────────────────────────────────────────
// loadTrackEnrichmentMaps – error handling
// ──────────────────────────────────────────────

describe('TrackEnrichment map loading error handling', () => {
  it('handles prisma failure gracefully (maps stay empty)', async () => {
    prismaMock.track.findMany.mockRejectedValueOnce(new Error('DB error'));
    await expect(svc.refreshTrackEnrichmentMaps()).resolves.not.toThrow();
  });
});
