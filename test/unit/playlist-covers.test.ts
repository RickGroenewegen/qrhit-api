import { describe, it, expect, vi } from 'vitest';
import {
  coverIsAlive,
  repairFeaturedPlaylistCovers,
  syncFeaturedPlaylistCover,
  CoverPlaylist,
} from '../../src/data/playlistCovers';

const DEAD = 'https://image-cdn-fa.spotifycdn.com/image/dead';
const FRESH = 'https://image-cdn-ak.spotifycdn.com/image/fresh';
const FINE = 'https://mosaic.scdn.co/640/fine';

function row(overrides: Partial<CoverPlaylist>): CoverPlaylist {
  return {
    id: 1,
    slug: 'wann-war-das-nochmal',
    playlistId: 'abc',
    serviceType: 'spotify',
    image: DEAD,
    ...overrides,
  };
}

function makeDeps(rows: CoverPlaylist[] = [], headStatus: number | Error = 200) {
  const deps: any = {
    prisma: {
      playlist: {
        findMany: vi.fn().mockResolvedValue(rows),
        update: vi.fn().mockResolvedValue({}),
      },
    },
    cache: { delPattern: vi.fn().mockResolvedValue(undefined) },
    logger: { log: vi.fn() },
    axiosInstance: {
      head: vi.fn().mockImplementation(async () => {
        if (headStatus instanceof Error) throw headStatus;
        return { status: headStatus };
      }),
    },
  };
  return deps;
}

describe('coverIsAlive', () => {
  it('is alive on 200', async () => {
    expect(await coverIsAlive(makeDeps([], 200), FINE)).toBe(true);
  });

  it('is dead on 404 and on the 400 a signed Apple URL gives once expired', async () => {
    expect(await coverIsAlive(makeDeps([], 404), DEAD)).toBe(false);
    expect(await coverIsAlive(makeDeps([], 400), DEAD)).toBe(false);
  });

  it('gives the cover the benefit of the doubt on a 5xx or a network error', async () => {
    expect(await coverIsAlive(makeDeps([], 503), FINE)).toBe(true);
    expect(await coverIsAlive(makeDeps([], new Error('timeout')), FINE)).toBe(true);
  });
});

describe('syncFeaturedPlaylistCover', () => {
  it('stores a changed cover and drops the featured list cache', async () => {
    const deps = makeDeps();
    const changed = await syncFeaturedPlaylistCover(deps, row({}), FRESH);

    expect(changed).toBe(true);
    expect(deps.prisma.playlist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { image: FRESH },
    });
    expect(deps.cache.delPattern).toHaveBeenCalledWith('featuredPlaylists_v4_*');
  });

  it('does nothing when the cover is unchanged or the lookup had none', async () => {
    const deps = makeDeps();
    expect(await syncFeaturedPlaylistCover(deps, row({}), DEAD)).toBe(false);
    expect(await syncFeaturedPlaylistCover(deps, row({}), '')).toBe(false);
    expect(await syncFeaturedPlaylistCover(deps, row({}), null)).toBe(false);
    expect(deps.prisma.playlist.update).not.toHaveBeenCalled();
    expect(deps.cache.delPattern).not.toHaveBeenCalled();
  });
});

describe('repairFeaturedPlaylistCovers', () => {
  const isAlive = async (url: string) => url !== DEAD;

  it('only looks up the playlists whose cover is gone', async () => {
    const deps = makeDeps([
      row({ id: 1, slug: 'dead-one' }),
      row({ id: 2, slug: 'fine-one', image: FINE }),
    ]);
    const fetchCover = vi.fn().mockResolvedValue(FRESH);

    const result = await repairFeaturedPlaylistCovers(deps, fetchCover, isAlive);

    expect(fetchCover).toHaveBeenCalledTimes(1);
    expect(fetchCover.mock.calls[0][0].slug).toBe('dead-one');
    expect(deps.prisma.playlist.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { image: FRESH },
    });
    expect(result).toEqual({ checked: 2, dead: 1, repaired: 1, unresolved: [] });
  });

  it('skips rows with a custom image at the query and rows without a URL', async () => {
    const deps = makeDeps([row({ id: 3, slug: 'no-url', image: '' })]);
    const fetchCover = vi.fn();

    const result = await repairFeaturedPlaylistCovers(deps, fetchCover, isAlive);

    expect(deps.prisma.playlist.findMany.mock.calls[0][0].where).toEqual({
      featured: true,
      featuredHidden: false,
      customImage: null,
    });
    expect(fetchCover).not.toHaveBeenCalled();
    expect(result.checked).toBe(0);
  });

  it('reports a playlist as unresolved when the lookup fails, throws or returns the same dead URL', async () => {
    const deps = makeDeps([
      row({ id: 1, slug: 'no-answer' }),
      row({ id: 2, slug: 'throws' }),
      row({ id: 3, slug: 'same-url' }),
    ]);
    const fetchCover = vi.fn().mockImplementation(async (p: CoverPlaylist) => {
      if (p.slug === 'throws') throw new Error('rate limited');
      if (p.slug === 'same-url') return DEAD;
      return null;
    });

    const result = await repairFeaturedPlaylistCovers(deps, fetchCover, isAlive);

    expect(deps.prisma.playlist.update).not.toHaveBeenCalled();
    expect(result.repaired).toBe(0);
    expect(result.unresolved.sort()).toEqual(['no-answer', 'same-url', 'throws']);
  });
});
