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
  it('schedules (only) an hourly refresh cron', () => {
    expect(h.cronStarts).toEqual(['0 * * * *']);
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
