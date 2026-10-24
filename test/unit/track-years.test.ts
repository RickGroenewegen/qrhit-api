import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * Unit tests for the auto-mode year fallback in src/data/trackYears.ts.
 *
 * pickAutoModeYear is what auto-mode uses when getReleaseDate could not settle
 * on a year: it walks the collected sources in priority order and takes the
 * first plausible one. autoResolveStoredYears applies it to tracks that were
 * looked up before and never checked, which the lookup itself skips.
 */

const h = vi.hoisted(() => ({
  findAndUpdateTrackByISRC: vi.fn(async () => ({
    wasUpdated: false,
    method: '',
  })),
  isAutoMode: vi.fn(async () => true),
  checkUnfinalizedPayments: vi.fn(async () => []),
}));

vi.mock('../../src/data/tracks', () => ({
  findAndUpdateTrackByISRC: h.findAndUpdateTrackByISRC,
}));
vi.mock('../../src/settings', () => ({
  default: { getInstance: () => ({ isAutoMode: h.isAutoMode }) },
}));
vi.mock('../../src/data/users', () => ({
  checkUnfinalizedPayments: h.checkUnfinalizedPayments,
}));

import {
  pickAutoModeYear,
  autoResolveStoredYears,
  updateTrackYear,
} from '../../src/data/trackYears';

const NEXT_YEAR = new Date().getFullYear() + 1;

function sources(overrides: Record<string, number> = {}) {
  return {
    spotify: 0,
    mb: 0,
    ai: 0,
    openPerplex: 0,
    discogs: 0,
    ...overrides,
  };
}

describe('pickAutoModeYear', () => {
  it('prefers the AI year over every other source', () => {
    const result = pickAutoModeYear(
      sources({ ai: 1975, spotify: 1990, mb: 1980, discogs: 1985 })
    );
    expect(result).toEqual({ year: 1975, source: 'ai' });
  });

  it('falls back to the Spotify year when there is no AI year', () => {
    const result = pickAutoModeYear(
      sources({ spotify: 1990, mb: 1980, discogs: 1985 })
    );
    expect(result).toEqual({ year: 1990, source: 'spotify' });
  });

  it('falls back to MusicBrainz, then Discogs, then OpenPerplex', () => {
    expect(pickAutoModeYear(sources({ mb: 1980, discogs: 1985 }))).toEqual({
      year: 1980,
      source: 'mb',
    });
    expect(pickAutoModeYear(sources({ discogs: 1985, openPerplex: 1988 }))).toEqual({
      year: 1985,
      source: 'discogs',
    });
    expect(pickAutoModeYear(sources({ openPerplex: 1988 }))).toEqual({
      year: 1988,
      source: 'openPerplex',
    });
  });

  it('skips a future year and takes the next usable source', () => {
    const result = pickAutoModeYear(
      sources({ ai: NEXT_YEAR, spotify: 1990 })
    );
    expect(result).toEqual({ year: 1990, source: 'spotify' });
  });

  it('skips zero and negative years', () => {
    const result = pickAutoModeYear(sources({ ai: 0, spotify: -1, mb: 1966 }));
    expect(result).toEqual({ year: 1966, source: 'mb' });
  });

  it('returns null when no source has a usable year', () => {
    expect(pickAutoModeYear(sources())).toBeNull();
    expect(pickAutoModeYear(sources({ ai: NEXT_YEAR }))).toBeNull();
  });

  it('tolerates missing source keys', () => {
    expect(pickAutoModeYear({ spotify: 1994 })).toEqual({
      year: 1994,
      source: 'spotify',
    });
    expect(pickAutoModeYear({})).toBeNull();
  });
});

/** Flatten a tagged-template $queryRaw/$executeRaw call into { sql, values }. */
function flatten(call: any[]) {
  const [strings, ...values] = call;
  const q = (Prisma.sql as any)(strings, ...values);
  return { sql: q.sql.replace(/\s+/g, ' ').trim(), values: q.values };
}

/** A track looked up before auto-mode and never checked (Nina & Mike, 2026-10-24). */
function storedTrack(overrides: Record<string, unknown> = {}) {
  return {
    id: 348970,
    isrc: 'XX0000000001',
    name: 'La Paloma Blanca',
    artist: 'Nina & Mike',
    spotifyYear: 2017,
    aiYear: 1975,
    musicBrainzYear: 1998,
    discogsYear: 2025,
    openPerplexYear: 0,
    ...overrides,
  };
}

function makeDeps() {
  const prisma = {
    $queryRaw: vi.fn(async () => [] as any[]),
    $executeRaw: vi.fn(async () => 1),
  };
  return {
    deps: { prisma, logger: { log: vi.fn() }, music: {} } as any,
    prisma,
  };
}

beforeEach(() => {
  h.findAndUpdateTrackByISRC.mockClear();
  h.findAndUpdateTrackByISRC.mockResolvedValue({ wasUpdated: false, method: '' });
  h.isAutoMode.mockClear();
  h.isAutoMode.mockResolvedValue(true);
  h.checkUnfinalizedPayments.mockClear();
});

describe('autoResolveStoredYears', () => {
  it('only looks at unchecked tracks of these track ids that already have a year', async () => {
    const { deps, prisma } = makeDeps();

    await autoResolveStoredYears(deps, ['sp1', 'sp2']);

    const { sql, values } = flatten(prisma.$queryRaw.mock.calls[0]);
    expect(sql).toContain('manuallyChecked = false');
    expect(sql).toContain('year IS NOT NULL');
    expect(sql).toContain('trackId IN');
    expect(values).toEqual(['sp1', 'sp2']);
  });

  it('settles a track from the sources of its earlier lookup', async () => {
    const { deps, prisma } = makeDeps();
    prisma.$queryRaw.mockResolvedValueOnce([storedTrack()]);

    const resolved = await autoResolveStoredYears(deps, ['sp1']);

    expect(resolved).toBe(1);
    expect(h.findAndUpdateTrackByISRC).toHaveBeenCalledWith(
      deps,
      'XX0000000001',
      348970
    );
    const { sql, values } = flatten(prisma.$executeRaw.mock.calls[0]);
    expect(sql).toContain('manuallyChecked = true');
    expect(values[0]).toBe(1975);
    expect(values[values.length - 1]).toBe(348970);
  });

  it('lets a checked twin decide before the stored sources', async () => {
    const { deps, prisma } = makeDeps();
    prisma.$queryRaw.mockResolvedValueOnce([storedTrack()]);
    h.findAndUpdateTrackByISRC.mockResolvedValueOnce({
      wasUpdated: true,
      method: 'isrc',
    });

    const resolved = await autoResolveStoredYears(deps, ['sp1']);

    expect(resolved).toBe(1);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('leaves a track without any usable stored year for the queue', async () => {
    const { deps, prisma } = makeDeps();
    prisma.$queryRaw.mockResolvedValueOnce([
      storedTrack({
        spotifyYear: null,
        aiYear: 0,
        musicBrainzYear: 0,
        discogsYear: null,
        openPerplexYear: null,
      }),
    ]);

    const resolved = await autoResolveStoredYears(deps, ['sp1']);

    expect(resolved).toBe(0);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('does not query without track ids', async () => {
    const { deps, prisma } = makeDeps();

    expect(await autoResolveStoredYears(deps, [])).toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('updateTrackYear and earlier looked-up tracks', () => {
  it('settles them with auto-mode on and lets waiting payments move on', async () => {
    const { deps, prisma } = makeDeps();
    prisma.$queryRaw
      .mockResolvedValueOnce([]) // no track without a year
      .mockResolvedValueOnce([storedTrack()]);

    await updateTrackYear(deps, ['sp1'], []);

    expect(flatten(prisma.$queryRaw.mock.calls[1]).sql).toContain(
      'year IS NOT NULL'
    );
    expect(flatten(prisma.$executeRaw.mock.calls[0]).values[0]).toBe(1975);
    expect(h.checkUnfinalizedPayments).toHaveBeenCalledWith(deps);
  });

  it('leaves them alone with auto-mode off', async () => {
    const { deps, prisma } = makeDeps();
    h.isAutoMode.mockResolvedValue(false);

    await updateTrackYear(deps, ['sp1'], []);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(h.checkUnfinalizedPayments).not.toHaveBeenCalled();
  });
});
