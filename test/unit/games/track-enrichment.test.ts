import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for src/trackEnrichment.ts. The module starts an hourly
 * CronJob and loads its maps from prisma inside the constructor, so the
 * cron module, prisma and utils are all mocked BEFORE import to neutralize
 * those side effects. Map loading is then driven explicitly via
 * refreshTrackEnrichmentMaps().
 */

const h = vi.hoisted(() => ({
  cronStarts: [] as string[],
  prisma: {
    track: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock('cron', () => ({
  CronJob: class {
    constructor(public schedule: string, public fn: () => void) {}
    start() {
      h.cronStarts.push(this.schedule);
    }
  },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prisma },
}));

vi.mock('../../../src/utils', () => ({
  default: class {
    isMainServer = async () => false;
  },
}));

import TrackEnrichment from '../../../src/trackEnrichment';

const dbTracks = [
  {
    trackId: 'sp-1',
    isrc: 'ISRC1',
    year: 1999,
    name: 'Blue Monday',
    artist: 'New Order',
  },
  {
    trackId: 'sp-2',
    isrc: null,
    year: 1985,
    name: 'Take On Me',
    artist: 'a-ha',
  },
  // Missing year => must be skipped entirely
  {
    trackId: 'sp-3',
    isrc: 'ISRC3',
    year: null,
    name: 'No Year',
    artist: 'Nobody',
  },
  // Missing trackId but valid otherwise => only isrc + artist/title maps
  {
    trackId: null,
    isrc: 'ISRC4',
    year: 2010,
    name: 'Orphan',
    artist: 'Unknown Artist',
  },
];

const enrichment = TrackEnrichment.getInstance();

beforeEach(async () => {
  h.prisma.track.findMany.mockResolvedValue(dbTracks);
  await enrichment.refreshTrackEnrichmentMaps();
});

describe('construction side effects', () => {
  it('schedules the hourly changed-tracks pass and the nightly reload at the primary minutes', () => {
    expect(h.cronStarts).toEqual(['7 * * * *', '10 2 * * *']);
  });

  it('queries only manually checked tracks', () => {
    expect(h.prisma.track.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { manuallyChecked: true } })
    );
  });
});

describe('map loading and stats', () => {
  it('indexes tracks by trackId, ISRC and artist+title, skipping incomplete rows', () => {
    expect(enrichment.getStats()).toEqual({
      byTrackId: 2, // sp-1, sp-2 (sp-3 skipped, ISRC4 row has no trackId)
      byIsrc: 2, // ISRC1, ISRC4
      byArtistTitle: 3, // all rows with year+name+artist
    });
  });

  it('clears stale entries on refresh', async () => {
    h.prisma.track.findMany.mockResolvedValue([dbTracks[0]]);
    await enrichment.refreshTrackEnrichmentMaps();
    expect(enrichment.getStats()).toEqual({
      byTrackId: 1,
      byIsrc: 1,
      byArtistTitle: 1,
    });
  });

  it('keeps existing maps when the database errors', async () => {
    h.prisma.track.findMany.mockRejectedValueOnce(new Error('db gone'));
    await enrichment.refreshTrackEnrichmentMaps();
    // load failed before clear => previous data intact
    expect(enrichment.getStats().byTrackId).toBe(2);
  });
});

describe('hourly refresh of changed tracks', () => {
  const lastWhere = () => (h.prisma.track.findMany.mock.lastCall as any)[0].where;

  it('reads only the tracks written since the last load, ten minutes back', async () => {
    h.prisma.track.findMany.mockResolvedValueOnce([]);
    await enrichment.refreshChangedTracks();

    const since = lastWhere().updatedAt.gte.getTime();
    const lag = Date.now() - 10 * 60 * 1000 - since;
    expect(lag).toBeGreaterThanOrEqual(0);
    expect(lag).toBeLessThan(5000);
  });

  it('adds newly checked tracks, updates changed ones and drops unchecked ones', async () => {
    h.prisma.track.findMany.mockResolvedValueOnce([
      { trackId: 'sp-5', isrc: 'ISRC5', year: 1979, name: 'Heart of Glass', artist: 'Blondie', manuallyChecked: true },
      { trackId: 'sp-1', isrc: 'ISRC1', year: 1999, name: 'Blue Monday', artist: 'New Order', manuallyChecked: false },
      { trackId: 'sp-2', isrc: null, year: 1984, name: 'Take On Me (1984)', artist: 'a-ha', manuallyChecked: true },
    ]);
    await enrichment.refreshChangedTracks();

    expect(enrichment.getByTrackId('sp-5')?.year).toBe(1979);
    expect(enrichment.getByIsrc('ISRC5')?.name).toBe('Heart of Glass');

    expect(enrichment.getByTrackId('sp-1')).toBeUndefined();
    expect(enrichment.getByIsrc('ISRC1')).toBeUndefined();
    expect(enrichment.getByArtistTitle('New Order', 'Blue Monday')).toBeUndefined();

    expect(enrichment.getByTrackId('sp-2')).toEqual({ year: 1984, name: 'Take On Me (1984)', artist: 'a-ha' });
    expect(enrichment.getByArtistTitle('a-ha', 'Take On Me')).toBeUndefined();
    expect(enrichment.getByArtistTitle('a-ha', 'Take On Me (1984)')?.year).toBe(1984);

    // Untouched tracks stay
    expect(enrichment.getByIsrc('ISRC4')?.name).toBe('Orphan');
  });

  it('leaves an ISRC to the other track that holds it', async () => {
    h.prisma.track.findMany.mockResolvedValueOnce([
      { trackId: 'a', isrc: 'DUP', year: 1990, name: 'Song', artist: 'Artist' },
      { trackId: 'b', isrc: 'DUP', year: 1991, name: 'Song (Live)', artist: 'Artist' },
    ]);
    await enrichment.refreshTrackEnrichmentMaps();

    h.prisma.track.findMany.mockResolvedValueOnce([
      { trackId: 'a', isrc: 'DUP', year: 1990, name: 'Song', artist: 'Artist', manuallyChecked: false },
    ]);
    await enrichment.refreshChangedTracks();

    expect(enrichment.getByTrackId('a')).toBeUndefined();
    expect(enrichment.getByIsrc('DUP')?.year).toBe(1991);
  });

  it('reads the same window again after a failed refresh', async () => {
    h.prisma.track.findMany.mockRejectedValueOnce(new Error('db gone'));
    await enrichment.refreshChangedTracks();
    const failedSince = lastWhere().updatedAt.gte.getTime();

    h.prisma.track.findMany.mockResolvedValueOnce([]);
    await enrichment.refreshChangedTracks();
    expect(lastWhere().updatedAt.gte.getTime()).toBe(failedSince);
    expect(enrichment.getStats().byTrackId).toBe(2);
  });
});

describe('lookups', () => {
  it('finds by trackId', () => {
    expect(enrichment.getByTrackId('sp-1')).toEqual({
      year: 1999,
      name: 'Blue Monday',
      artist: 'New Order',
    });
    expect(enrichment.getByTrackId('nope')).toBeUndefined();
  });

  it('finds by ISRC', () => {
    expect(enrichment.getByIsrc('ISRC4')?.name).toBe('Orphan');
    expect(enrichment.getByIsrc('ISRC3')).toBeUndefined();
  });

  it('matches artist+title case-insensitively with surrounding whitespace ignored', () => {
    expect(enrichment.getByArtistTitle('NEW ORDER ', '  blue monday')?.year).toBe(
      1999
    );
    expect(enrichment.getByArtistTitle('New Order', 'Bizarre Love Triangle')).toBeUndefined();
  });
});

describe('enrichTrack waterfall', () => {
  it('prefers trackId over ISRC over artist+title', () => {
    // trackId wins even when isrc points at another track
    const byId = enrichment.enrichTrack({
      id: 'sp-2',
      isrc: 'ISRC1',
      name: 'x',
      artist: 'y',
    });
    expect(byId?.name).toBe('Take On Me');

    // Without id, the ISRC wins over the artist/title
    const byIsrc = enrichment.enrichTrack({
      isrc: 'ISRC1',
      name: 'Take On Me',
      artist: 'a-ha',
    });
    expect(byIsrc?.name).toBe('Blue Monday');

    // Artist+title as last resort
    const byName = enrichment.enrichTrack({
      name: 'take on me',
      artist: 'A-HA',
    });
    expect(byName?.year).toBe(1985);
  });

  it('returns undefined when nothing matches or data is missing', () => {
    expect(enrichment.enrichTrack({})).toBeUndefined();
    expect(enrichment.enrichTrack({ name: 'only name' })).toBeUndefined();
    expect(
      enrichment.enrichTrack({ id: 'zzz', isrc: 'zzz', name: 'z', artist: 'z' })
    ).toBeUndefined();
  });
});

describe('enrichTracksByArtistTitle', () => {
  it('adds trueYear/enrichedName/enrichedArtist via ISRC first, then artist+title', () => {
    const input = [
      { name: 'wrong title', artist: 'wrong artist', isrc: 'ISRC1' },
      { name: 'Take On Me', artist: 'a-ha' },
      { name: 'Unknown Song', artist: 'Unknown' },
    ];

    const [byIsrc, byTitle, miss] = enrichment.enrichTracksByArtistTitle(input);

    expect(byIsrc).toMatchObject({
      isrc: 'ISRC1',
      trueYear: 1999,
      enrichedName: 'Blue Monday',
      enrichedArtist: 'New Order',
    });
    expect(byTitle).toMatchObject({
      trueYear: 1985,
      enrichedName: 'Take On Me',
    });
    // Unmatched tracks pass through untouched
    expect(miss).toEqual({ name: 'Unknown Song', artist: 'Unknown' });
    expect('trueYear' in miss).toBe(false);
  });
});
