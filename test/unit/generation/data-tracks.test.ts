import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { splitLongWord } from '../../../src/data/hyphenate';

/**
 * Pure unit tests for src/data/tracks.ts.
 *
 * Sibling data modules (trackYears, misc, musicLinks, users) and the
 * provider factory are mocked before import: they pull in heavy module
 * graphs (spotify, exceljs, printenbind) and their behavior is covered
 * elsewhere. hyphenate is kept real (pure function) so the LLM-fallback
 * path is exercised for real.
 */

const h = vi.hoisted(() => ({
  updateTrackYear: vi.fn(async () => undefined),
  clearPlaylistCache: vi.fn(async () => undefined),
  getLink: vi.fn(async () => undefined),
  checkUnfinalizedPayments: vi.fn(async () => undefined),
}));

vi.mock('../../../src/data/trackYears', () => ({
  updateTrackYear: h.updateTrackYear,
}));
vi.mock('../../../src/data/misc', () => ({
  clearPlaylistCache: h.clearPlaylistCache,
}));
vi.mock('../../../src/data/musicLinks', () => ({ getLink: h.getLink }));
vi.mock('../../../src/data/users', () => ({
  checkUnfinalizedPayments: h.checkUnfinalizedPayments,
}));
vi.mock('../../../src/providers/MusicProviderFactory', () => ({
  serviceColumnMap: {
    spotify: 'spotifyLink',
    youtube: 'youtubeMusicLink',
    deezer: 'deezerLink',
    apple: 'appleMusicLink',
    tidal: 'tidalLink',
    amazon: 'amazonMusicLink',
  },
}));

import {
  sanitizeTitleOrArtist,
  findAndUpdateTrackByISRC,
  getTracks,
  getTrackById,
  updateTrack,
  storeTracks,
  searchTracks,
  getTracksMissingSpotifyLink,
  getTracksMissingSpotifyLinkCount,
  toggleSpotifyLinkIgnored,
} from '../../../src/data/tracks';

/** Flatten a tagged-template $queryRaw/$executeRaw call into { sql, values }. */
function flatten(call: any[]) {
  const [strings, ...values] = call;
  const q = (Prisma.sql as any)(strings, ...values);
  return { sql: q.sql.replace(/\s+/g, ' ').trim(), values: q.values };
}

function makeDeps() {
  const prisma = {
    track: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    playlist: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
  };
  return {
    deps: {
      prisma,
      logger: { log: vi.fn() },
      openai: { splitArtistOrString: vi.fn(async () => []) },
      utils: { cleanTrackName: vi.fn((s: string) => s) },
      cache: { delPatternNonBlocking: vi.fn(async () => 2) },
    } as any,
    prisma,
  };
}

beforeEach(() => {
  h.updateTrackYear.mockClear();
  h.clearPlaylistCache.mockClear();
  h.getLink.mockClear();
  h.checkUnfinalizedPayments.mockClear();
});

const LONG = 'ABCDEFGHIJKLMNOPQRSTUVWXY'; // 25 chars > MAX_WORD_LEN 20

describe('sanitizeTitleOrArtist', () => {
  it('returns short text untouched without calling the LLM', async () => {
    const { deps } = makeDeps();
    expect(await sanitizeTitleOrArtist(deps, 'Normal Song Title', 'title')).toBe(
      'Normal Song Title'
    );
    expect(deps.openai.splitArtistOrString).not.toHaveBeenCalled();
  });

  it('returns falsy input as-is', async () => {
    const { deps } = makeDeps();
    expect(await sanitizeTitleOrArtist(deps, '', 'title')).toBe('');
  });

  it('uses a valid LLM split for long words', async () => {
    const { deps } = makeDeps();
    deps.openai.splitArtistOrString.mockResolvedValue([
      'ABCDEFGHIJKL',
      'MNOPQRSTUVWXY',
    ]);

    const result = await sanitizeTitleOrArtist(deps, `Intro ${LONG}`, 'artist');

    expect(result).toBe('Intro ABCDEFGHIJKL MNOPQRSTUVWXY');
    expect(deps.openai.splitArtistOrString).toHaveBeenCalledWith(LONG, 'artist');
  });

  it('falls back to hyphenation when the LLM split does not reassemble the word', async () => {
    const { deps } = makeDeps();
    deps.openai.splitArtistOrString.mockResolvedValue(['garbage']);

    const expected = splitLongWord(LONG, 'en', 20).join(' ');
    const result = await sanitizeTitleOrArtist(deps, LONG, 'title', 'en');

    expect(result).toBe(expected);
    expect(result.split(/\s+/).every((w) => w.length <= 20)).toBe(true);
  });

  it('falls back when an LLM segment is still longer than the limit', async () => {
    const { deps } = makeDeps();
    deps.openai.splitArtistOrString.mockResolvedValue([LONG.slice(0, 24), 'Y']);

    const expected = splitLongWord(LONG, 'en', 20).join(' ');
    expect(await sanitizeTitleOrArtist(deps, LONG, 'title', 'en')).toBe(expected);
  });
});

describe('findAndUpdateTrackByISRC', () => {
  const linkSet = {
    spotifyLink: 'sp',
    deezerLink: 'dz',
    youtubeMusicLink: null,
    appleMusicLink: null,
    amazonMusicLink: null,
    tidalLink: null,
    musicFetchLastAttempt: null,
    musicFetchAttempts: 1,
  };

  it('copies year + links from a manually checked ISRC sibling', async () => {
    const { deps, prisma } = makeDeps();
    prisma.track.findFirst.mockResolvedValue({
      id: 50,
      year: 1999,
      yearSource: 'spotify',
      certainty: 90,
      reasoning: 'r',
      ...linkSet,
    });
    prisma.track.findUnique.mockResolvedValue({ spotifyLink: null }); // target lacks link

    const res = await findAndUpdateTrackByISRC(deps, 'ISRC1', 7);

    expect(res).toEqual({ wasUpdated: true, method: 'isrc' });
    expect(prisma.track.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isrc: 'ISRC1', year: { not: null }, manuallyChecked: true },
      })
    );
    const data = prisma.track.update.mock.calls[0][0].data;
    expect(data.year).toBe(1999);
    expect(data.yearSource).toBe('otherTrack_spotify');
    expect(data.manuallyChecked).toBe(true);
    expect(data.spotifyLink).toBe('sp'); // copied because target had none
  });

  it('keeps the target spotifyLink when it already has one', async () => {
    const { deps, prisma } = makeDeps();
    prisma.track.findFirst.mockResolvedValue({
      id: 50,
      year: 1999,
      yearSource: 'spotify',
      certainty: 90,
      reasoning: 'r',
      ...linkSet,
    });
    prisma.track.findUnique.mockResolvedValue({ spotifyLink: 'mine' });

    await findAndUpdateTrackByISRC(deps, 'ISRC1', 7);

    expect(prisma.track.update.mock.calls[0][0].data.spotifyLink).toBeUndefined();
  });

  it('falls back to a single artist+title match (case-insensitive, trimmed)', async () => {
    const { deps, prisma } = makeDeps();
    prisma.track.findUnique
      .mockResolvedValueOnce({
        artist: ' The Beatles ',
        name: ' Help ',
        spotifyLink: null,
      })
      .mockResolvedValueOnce({
        year: 1965,
        yearSource: 'discogs',
        certainty: 80,
        reasoning: 'x',
        ...linkSet,
      });
    prisma.$queryRaw.mockResolvedValue([{ id: 60, year: 1965 }]);

    const res = await findAndUpdateTrackByISRC(deps, '', 7);

    expect(res).toEqual({ wasUpdated: true, method: 'artistTitle' });
    // No ISRC -> the ISRC lookup is skipped entirely.
    expect(prisma.track.findFirst).not.toHaveBeenCalled();
    const { sql, values } = flatten(prisma.$queryRaw.mock.calls[0]);
    expect(sql).toContain('LOWER(TRIM(artist)) = ?');
    expect(sql).toContain('manuallyChecked = true');
    expect(values).toEqual(['the beatles', 'help', 7]);
    expect(prisma.track.update.mock.calls[0][0].data.yearSource).toBe(
      'otherTrack_metadata_discogs'
    );
  });

  it('uses the first match when multiple matches agree on the year', async () => {
    const { deps, prisma } = makeDeps();
    prisma.track.findUnique
      .mockResolvedValueOnce({ artist: 'A', name: 'N', spotifyLink: 'have' })
      .mockResolvedValueOnce({
        year: 1990,
        yearSource: 'mb',
        certainty: 70,
        reasoning: 'y',
        ...linkSet,
      });
    prisma.$queryRaw.mockResolvedValue([
      { id: 61, year: 1990 },
      { id: 62, year: 1990 },
    ]);

    const res = await findAndUpdateTrackByISRC(deps, '', 7);

    expect(res).toEqual({ wasUpdated: true, method: 'artistTitle_multiple' });
    expect(prisma.track.findUnique).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { id: 61 } })
    );
    const data = prisma.track.update.mock.calls[0][0].data;
    expect(data.yearSource).toBe('otherTrack_metadata_multiple_mb');
    expect(data.spotifyLink).toBeUndefined(); // target already had a link
  });

  it('does not update when matches disagree on the year', async () => {
    const { deps, prisma } = makeDeps();
    prisma.track.findUnique.mockResolvedValueOnce({
      artist: 'A',
      name: 'N',
      spotifyLink: null,
    });
    prisma.$queryRaw.mockResolvedValue([
      { id: 61, year: 1990 },
      { id: 62, year: 1991 },
    ]);

    const res = await findAndUpdateTrackByISRC(deps, '', 7);

    expect(res).toEqual({ wasUpdated: false, method: '' });
    expect(prisma.track.update).not.toHaveBeenCalled();
  });

  it('returns not-updated when the current track does not exist', async () => {
    const { deps, prisma } = makeDeps();
    prisma.track.findUnique.mockResolvedValue(null);
    const res = await findAndUpdateTrackByISRC(deps, '', 7);
    expect(res).toEqual({ wasUpdated: false, method: '' });
  });
});

describe('getTracks', () => {
  it('queries by playlist with extra-info coalescing and order', async () => {
    const { deps, prisma } = makeDeps();
    const rows = [{ id: 1, artist: 'A' }];
    prisma.$queryRaw.mockResolvedValue(rows);

    const result = await getTracks(deps, 5);

    expect(result).toBe(rows);
    const { sql, values } = flatten(prisma.$queryRaw.mock.calls[0]);
    expect(sql).toContain("COALESCE(NULLIF(tei.artist, ''), tracks.artist) as artist");
    expect(sql).toContain('ORDER BY playlist_has_tracks.order ASC');
    // userId appears 3x in the payment subquery, playlistId 2x.
    expect(values).toEqual([0, 0, 0, 5, 5]);
  });

  it('passes a non-zero userId into the payment ownership subquery', async () => {
    const { deps, prisma } = makeDeps();
    await getTracks(deps, 5, 42);
    const { values } = flatten(prisma.$queryRaw.mock.calls[0]);
    expect(values).toEqual([42, 42, 42, 5, 5]);
  });
});

describe('getTrackById', () => {
  it('selects the track with all service links', async () => {
    const { deps, prisma } = makeDeps();
    prisma.track.findUnique.mockResolvedValue({ id: 9, artist: 'A' });

    const res = await getTrackById(deps, 9);

    expect(res).toEqual({ id: 9, artist: 'A' });
    expect(prisma.track.findUnique).toHaveBeenCalledWith({
      where: { id: 9 },
      select: {
        id: true,
        artist: true,
        name: true,
        year: true,
        spotifyLink: true,
        youtubeMusicLink: true,
        appleMusicLink: true,
        tidalLink: true,
        deezerLink: true,
        amazonMusicLink: true,
      },
    });
  });
});

describe('updateTrack', () => {
  const callUpdate = (deps: any, appleLink = '') =>
    updateTrack(
      deps,
      5,
      'Artist',
      'Name',
      1999,
      'sp',
      'yt',
      appleLink,
      'td',
      'dz',
      'am',
      '1.2.3.4'
    );

  it('updates the track, refreshes links, and clears featured playlist caches', async () => {
    const { deps, prisma } = makeDeps();
    prisma.playlist.findMany.mockResolvedValue([{ playlistId: 'plX' }]);

    const res = await callUpdate(deps);

    expect(res).toEqual({ success: true });
    expect(prisma.track.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: {
        artist: 'Artist',
        name: 'Name',
        year: 1999,
        spotifyLink: 'sp',
        youtubeMusicLink: 'yt',
        appleMusicLink: '',
        tidalLink: 'td',
        deezerLink: 'dz',
        amazonMusicLink: 'am',
        manuallyCorrected: true,
      },
    });
    expect(h.getLink).toHaveBeenCalledWith(deps, 5, '1.2.3.4', false);
    expect(h.checkUnfinalizedPayments).toHaveBeenCalledWith(deps);
    expect(prisma.playlist.findMany).toHaveBeenCalledWith({
      where: { featured: true, tracks: { some: { trackId: 5 } } },
      select: { playlistId: true },
    });
    expect(h.clearPlaylistCache).toHaveBeenCalledWith(deps, 'plX');
    // No apple link -> no storefront cache bust.
    expect(deps.cache.delPatternNonBlocking).not.toHaveBeenCalled();
  });

  it('busts the Apple storefront cache using the ?i= song id when present', async () => {
    const { deps } = makeDeps();
    await callUpdate(deps, 'https://music.apple.com/us/album/foo/123?i=456');
    expect(deps.cache.delPatternNonBlocking).toHaveBeenCalledWith('am_sf:456:*');
  });

  it('falls back to the song-URL id when there is no ?i= parameter', async () => {
    const { deps } = makeDeps();
    await callUpdate(deps, 'https://music.apple.com/us/song/title/789');
    expect(deps.cache.delPatternNonBlocking).toHaveBeenCalledWith('am_sf:789:*');
  });

  it('reports failures instead of throwing', async () => {
    const { deps, prisma } = makeDeps();
    prisma.track.update.mockRejectedValue(new Error('locked'));

    const res = await callUpdate(deps);
    expect(res).toEqual({ success: false, error: 'locked' });
    expect(h.checkUnfinalizedPayments).not.toHaveBeenCalled();
  });
});

describe('storeTracks', () => {
  const goodTrack = {
    id: 's1',
    name: 'Song One',
    artist: 'Artist',
    isrc: 'I1',
    album: 'Alb',
    preview: 'prev',
    link: 'https://open.spotify.com/track/s1',
  };

  it('filters out artistless tracks and podcast episodes, inserts the rest', async () => {
    const { deps, prisma } = makeDeps();
    const tracks = [
      goodTrack,
      { id: 's2', name: 'Pod', artist: 'A', link: 'https://open.spotify.com/episode/x' },
      { id: 's3', name: 'NoArtist', artist: null },
    ];

    await storeTracks(deps, 99, 'pl1', tracks);

    // Stale playlist links removed first.
    const del = flatten(prisma.$executeRaw.mock.calls[0]);
    expect(del.sql).toContain('DELETE FROM playlist_has_tracks');
    expect(del.values).toEqual([99, 's1']); // only the valid track id survives

    expect(prisma.track.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { trackId: { in: ['s1'] } } })
    );
    expect(prisma.track.createMany).toHaveBeenCalledWith({
      data: [
        {
          trackId: 's1',
          name: 'Song One',
          isrc: 'I1',
          artist: 'Artist',
          spotifyLink: 'https://open.spotify.com/track/s1',
          album: 'Alb',
          preview: 'prev',
        },
      ],
      skipDuplicates: true,
    });

    // Without trackOrder there is exactly one INSERT IGNORE (plus the delete).
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    const ins = flatten(prisma.$executeRaw.mock.calls[1]);
    expect(ins.sql).toContain('INSERT IGNORE INTO playlist_has_tracks (playlistId, trackId)');
    expect(ins.values).toEqual([99, 's1']);

    expect(h.updateTrackYear).toHaveBeenCalledWith(deps, ['s1'], tracks);
  });

  it('stores the link in the service-specific column for non-spotify services', async () => {
    const { deps, prisma } = makeDeps();
    const tidalTrack = { ...goodTrack, link: undefined, serviceLink: 'https://tidal.com/t/1' };

    await storeTracks(deps, 99, 'pl1', [tidalTrack], undefined, 'tidal');

    const data = prisma.track.createMany.mock.calls[0][0].data[0];
    expect(data.tidalLink).toBe('https://tidal.com/t/1');
    expect(data.spotifyLink).toBeUndefined();
  });

  it('updates changed existing tracks unless they were manually corrected', async () => {
    const { deps, prisma } = makeDeps();
    prisma.track.findMany.mockResolvedValue([
      {
        trackId: 's1',
        name: 'Old name',
        isrc: 'I1',
        artist: 'Artist',
        spotifyLink: 'https://open.spotify.com/track/s1',
        album: 'Alb',
        preview: 'prev',
        manuallyCorrected: false,
      },
    ]);

    await storeTracks(deps, 99, 'pl1', [{ ...goodTrack, name: 'New name' }]);

    expect(prisma.track.createMany).not.toHaveBeenCalled();
    expect(prisma.track.update).toHaveBeenCalledWith({
      where: { trackId: 's1' },
      data: {
        name: 'New name',
        isrc: 'I1',
        artist: 'Artist',
        spotifyLink: 'https://open.spotify.com/track/s1',
        album: 'Alb',
        preview: 'prev',
      },
    });
  });

  it('leaves manually corrected tracks alone even when provider data changed', async () => {
    const { deps, prisma } = makeDeps();
    prisma.track.findMany.mockResolvedValue([
      {
        trackId: 's1',
        name: 'Curated name',
        isrc: 'I1',
        artist: 'Artist',
        spotifyLink: 'https://open.spotify.com/track/s1',
        album: 'Alb',
        preview: 'prev',
        manuallyCorrected: true,
      },
    ]);

    await storeTracks(deps, 99, 'pl1', [{ ...goodTrack, name: 'Provider name' }]);

    expect(prisma.track.update).not.toHaveBeenCalled();
    expect(prisma.track.createMany).not.toHaveBeenCalled();
  });

  it('skips identical existing tracks entirely', async () => {
    const { deps, prisma } = makeDeps();
    prisma.track.findMany.mockResolvedValue([
      {
        trackId: 's1',
        name: 'Song One',
        isrc: 'I1',
        artist: 'Artist',
        spotifyLink: 'https://open.spotify.com/track/s1',
        album: 'Alb',
        preview: 'prev',
        manuallyCorrected: false,
      },
    ]);

    await storeTracks(deps, 99, 'pl1', [goodTrack]);

    expect(prisma.track.update).not.toHaveBeenCalled();
    expect(prisma.track.createMany).not.toHaveBeenCalled();
  });

  it('writes ordered playlist_has_tracks rows when a track order is provided', async () => {
    const { deps, prisma } = makeDeps();
    const order = new Map([['s1', 2]]);

    await storeTracks(deps, 99, 'pl1', [goodTrack], order);

    // delete + ordered insert + order update
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    const ins = flatten(prisma.$executeRaw.mock.calls[1]);
    expect(ins.sql).toContain('INSERT IGNORE INTO playlist_has_tracks (playlistId, trackId, `order`)');
    expect(ins.sql).toContain('CASE');
    expect(ins.values).toEqual([99, 's1', 2, 's1']);

    const upd = flatten(prisma.$executeRaw.mock.calls[2]);
    expect(upd.sql).toContain('UPDATE playlist_has_tracks pht');
    expect(upd.values).toEqual(['s1', 2, 99, 's1']);
  });
});

describe('searchTracks', () => {
  it('numeric search matches id OR artist/name LIKE, with pagination values', async () => {
    const { deps, prisma } = makeDeps();
    const rows = [{ id: 123 }];
    prisma.$queryRaw
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{ total: 7n }]);

    const res = await searchTracks(deps, '123');

    expect(res).toEqual({ tracks: rows, total: 7, page: 1, totalPages: 1 });
    const { sql, values } = flatten(prisma.$queryRaw.mock.calls[0]);
    expect(sql).toContain('(t.id = ? OR t.artist LIKE ? OR t.name LIKE ?)');
    expect(sql).toContain('ORDER BY t.id DESC LIMIT ? OFFSET ?');
    expect(values).toEqual([123, '%123%', '%123%', 50, 0]);

    const count = flatten(prisma.$queryRaw.mock.calls[1]);
    expect(count.sql).toContain('COUNT(DISTINCT t.id) as total');
    expect(count.values).toEqual([123, '%123%', '%123%']);
  });

  it('non-numeric search omits the id clause and computes the offset from page/limit', async () => {
    const { deps, prisma } = makeDeps();
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 21n }]);

    const res = await searchTracks(deps, 'abba', undefined, undefined, 3, 10);

    const { sql, values } = flatten(prisma.$queryRaw.mock.calls[0]);
    expect(sql).toContain('(t.artist LIKE ? OR t.name LIKE ?)');
    expect(sql).not.toContain('t.id = ?');
    expect(values).toEqual(['%abba%', '%abba%', 10, 20]);
    expect(res.totalPages).toBe(3);
    expect(res.page).toBe(3);
  });

  it('filters on the missing service column and joins the playlist when given', async () => {
    const { deps, prisma } = makeDeps();
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0n }]);

    await searchTracks(deps, '', 'tidal', 9);

    const { sql, values } = flatten(prisma.$queryRaw.mock.calls[0]);
    expect(sql).toContain("(t.tidalLink IS NULL OR t.tidalLink = '')");
    expect(sql).toContain('JOIN playlist_has_tracks pht ON pht.trackId = t.id');
    expect(sql).toContain(
      '(SELECT playlistId FROM payment_has_playlist WHERE id = ?)'
    );
    expect(values).toEqual([9, 50, 0]);
  });

  it('an unknown missing service and empty search produce no WHERE clause', async () => {
    const { deps, prisma } = makeDeps();
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const res = await searchTracks(deps, '', 'bogus-service');

    const { sql } = flatten(prisma.$queryRaw.mock.calls[0]);
    expect(sql).not.toContain('WHERE');
    expect(res.total).toBe(0); // empty count result coerces to 0
  });
});

describe('getTracksMissingSpotifyLink', () => {
  it('applies the LIKE filter when searching', async () => {
    const { deps, prisma } = makeDeps();
    const rows = [{ id: 1 }];
    prisma.$queryRaw.mockResolvedValue(rows);

    const res = await getTracksMissingSpotifyLink(deps, 'queen');

    expect(res).toBe(rows);
    const { sql, values } = flatten(prisma.$queryRaw.mock.calls[0]);
    expect(sql).toContain("(spotifyLink IS NULL OR spotifyLink = '')");
    expect(sql).toContain('spotifyLinkIgnored = false');
    expect(sql).toContain('(artist LIKE ? OR name LIKE ?)');
    expect(values).toEqual(['%queen%', '%queen%']);
  });

  it('omits the LIKE filter without a search term', async () => {
    const { deps, prisma } = makeDeps();
    prisma.$queryRaw.mockResolvedValue([]);

    await getTracksMissingSpotifyLink(deps);

    const { sql, values } = flatten(prisma.$queryRaw.mock.calls[0]);
    expect(sql).not.toContain('LIKE');
    expect(sql).toContain('LIMIT 100');
    expect(values).toEqual([]);
  });
});

describe('getTracksMissingSpotifyLinkCount', () => {
  it('converts the bigint count to a number', async () => {
    const { deps, prisma } = makeDeps();
    prisma.$queryRaw.mockResolvedValue([{ count: 5n }]);
    expect(await getTracksMissingSpotifyLinkCount(deps)).toBe(5);
  });

  it('returns 0 for an empty result set', async () => {
    const { deps, prisma } = makeDeps();
    prisma.$queryRaw.mockResolvedValue([]);
    expect(await getTracksMissingSpotifyLinkCount(deps)).toBe(0);
  });
});

describe('toggleSpotifyLinkIgnored', () => {
  it('flips the flag and returns the new value', async () => {
    const { deps, prisma } = makeDeps();
    prisma.track.findUnique.mockResolvedValue({ spotifyLinkIgnored: false });
    prisma.track.update.mockResolvedValue({ spotifyLinkIgnored: true });

    const res = await toggleSpotifyLinkIgnored(deps, 5);

    expect(res).toEqual({ spotifyLinkIgnored: true });
    expect(prisma.track.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { spotifyLinkIgnored: true },
      select: { spotifyLinkIgnored: true },
    });
  });

  it('throws for unknown tracks', async () => {
    const { deps, prisma } = makeDeps();
    prisma.track.findUnique.mockResolvedValue(null);
    await expect(toggleSpotifyLinkIgnored(deps, 5)).rejects.toThrow(
      'Track not found'
    );
  });
});
