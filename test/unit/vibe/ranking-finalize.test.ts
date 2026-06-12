/**
 * Unit tests for src/vibe.ts — getRanking scoring math, finalizeList
 * orchestration, createPlaylist, status progression and addTrackExtraInfo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, resetAll } from './vibe-mocks';

vi.mock('../../../src/prisma', async () => (await import('./vibe-mocks')).prismaModule());
vi.mock('../../../src/cache', async () => (await import('./vibe-mocks')).cacheModule());
vi.mock('../../../src/utils', async () => (await import('./vibe-mocks')).utilsModule());
vi.mock('../../../src/auth', async () => (await import('./vibe-mocks')).authModule());
vi.mock('../../../src/mollie', async () => (await import('./vibe-mocks')).mollieModule());
vi.mock('../../../src/discount', async () => (await import('./vibe-mocks')).discountModule());
vi.mock('../../../src/data', async () => (await import('./vibe-mocks')).dataModule());
vi.mock('../../../src/spotify', async () => (await import('./vibe-mocks')).spotifyModule());
vi.mock('../../../src/generator', async () => (await import('./vibe-mocks')).generatorModule());
vi.mock('../../../src/translation', async () => (await import('./vibe-mocks')).translationModule());
vi.mock('../../../src/logger', async () => (await import('./vibe-mocks')).loggerModule());
vi.mock('sharp', async () => (await import('./vibe-mocks')).sharpModule());
vi.mock('fs/promises', async () => (await import('./vibe-mocks')).fsModule());

import Vibe from '../../../src/vibe';

const vibe = Vibe.getInstance();

beforeEach(() => {
  resetAll();
});

/** maxPoints=3, top-2 limit; three tracks with a tie broken by vote time. */
function arrangeRankingFixture() {
  h.prisma.companyList.findUnique.mockResolvedValue({
    id: 1,
    name: 'Lijst',
    numberOfTracks: 3,
    numberOfCards: 2,
  });
  h.prisma.companyListSubmission.findMany.mockResolvedValue([
    {
      id: 1,
      firstname: 'Alice',
      lastname: 'A',
      agreeToUseName: true,
      createdAt: new Date('2026-01-01T10:00:00Z'),
      CompanyListSubmissionTrack: [
        { trackId: 10, position: 1, isBirthdayTrack: false },
        { trackId: 11, position: 2, isBirthdayTrack: false },
      ],
    },
    {
      id: 2,
      firstname: 'Bob',
      lastname: null,
      agreeToUseName: false,
      createdAt: new Date('2026-01-02T10:00:00Z'),
      CompanyListSubmissionTrack: [
        { trackId: 11, position: 1, isBirthdayTrack: false },
        { trackId: 12, position: 2, isBirthdayTrack: true },
      ],
    },
  ]);
  h.prisma.track.findMany.mockResolvedValue([
    {
      id: 10,
      trackId: 'sp10',
      name: 'Song 10',
      artist: 'Art 10',
      year: 1990,
      manuallyChecked: true,
      spotifyLink: 'https://open.spotify.com/track/sp10',
      youtubeLink: null,
    },
    {
      id: 11,
      trackId: 'sp11',
      name: 'Song 11',
      artist: 'Art 11',
      year: 1991,
      manuallyChecked: true,
      spotifyLink: 'https://open.spotify.com/track/sp11',
      youtubeLink: null,
    },
    {
      id: 12,
      trackId: 'sp12',
      name: 'Song 12',
      artist: 'Art 12',
      year: 1992,
      manuallyChecked: false,
      spotifyLink: 'https://open.spotify.com/track/sp12',
      youtubeLink: null,
    },
  ]);
}

describe('getRanking', () => {
  it('validates the list id', async () => {
    expect(await vibe.getRanking(NaN)).toMatchObject({
      success: false,
      error: 'Invalid list ID provided',
    });
  });

  it('returns not-found for a missing list', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(null);
    expect(await vibe.getRanking(1)).toMatchObject({
      success: false,
      error: 'Company list not found',
    });
  });

  it('refuses to rank a list with zero numberOfTracks', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 1,
      numberOfTracks: 0,
      numberOfCards: 5,
    });
    expect(await vibe.getRanking(1)).toMatchObject({
      success: false,
      error: 'List has zero or negative numberOfTracks, cannot rank.',
    });
  });

  it('returns an empty ranking when there are no verified submissions', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 1,
      numberOfTracks: 3,
      numberOfCards: 5,
    });
    h.prisma.companyListSubmission.findMany.mockResolvedValue([]);
    const res = await vibe.getRanking(1);
    expect(res.success).toBe(true);
    expect(res.data.ranking).toEqual([]);
    // Only verified submissions are considered
    expect(
      h.prisma.companyListSubmission.findMany.mock.calls[0][0].where
    ).toMatchObject({ companyListId: 1, verified: true });
  });

  it('scores positions, gives birthday tracks max points and tie-breaks on first vote', async () => {
    arrangeRankingFixture();
    const res = await vibe.getRanking(1);
    expect(res.success).toBe(true);
    const ranking = res.data.ranking;

    // Scores: t11 = 2 (pos2) + 3 (pos1) = 5; t10 = 3 (pos1);
    // t12 birthday -> max 3 despite pos2. Tie t10/t12 broken by first vote
    // (t10 voted Jan 1, t12 Jan 2).
    expect(ranking.map((t: any) => t.id)).toEqual([11, 10, 12]);
    expect(ranking.map((t: any) => t.score)).toEqual([5, 3, 3]);
    expect(ranking.map((t: any) => t.voteCount)).toEqual([2, 1, 1]);

    // withinLimit honours numberOfCards = 2
    expect(ranking.map((t: any) => t.withinLimit)).toEqual([true, true, false]);

    // Voters: full name built from first+last, agree flag carried through
    expect(ranking[1].voters).toEqual([
      { name: 'Alice A', agreeToUseName: true, isBirthdayTrack: false },
    ]);
    expect(ranking[0].voters).toEqual([
      { name: 'Alice A', agreeToUseName: true, isBirthdayTrack: false },
      { name: 'Bob', agreeToUseName: false, isBirthdayTrack: false },
    ]);
    expect(ranking[2].voters).toEqual([
      { name: 'Bob', agreeToUseName: false, isBirthdayTrack: true },
    ]);

    // Track details fetched for exactly the scored tracks
    expect(h.prisma.track.findMany.mock.calls[0][0].where).toEqual({
      id: { in: [10, 11, 12] },
    });
  });

  it('drops votes beyond the points window (position > maxPoints)', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 1,
      numberOfTracks: 3,
      numberOfCards: 5,
    });
    h.prisma.companyListSubmission.findMany.mockResolvedValue([
      {
        id: 1,
        firstname: null,
        lastname: null,
        agreeToUseName: false,
        createdAt: new Date(),
        CompanyListSubmissionTrack: [
          { trackId: 10, position: 4, isBirthdayTrack: false }, // 3-4+1 = 0 pts
        ],
      },
    ]);
    h.prisma.track.findMany.mockResolvedValue([]);
    const res = await vibe.getRanking(1);
    expect(res.success).toBe(true);
    expect(res.data.ranking).toEqual([]);
    // Track never earned points so it is not even looked up
    expect(h.prisma.track.findMany.mock.calls[0][0].where).toEqual({
      id: { in: [] },
    });
  });

  it('omits anonymous voters (no name parts) from the voters array', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      id: 1,
      numberOfTracks: 3,
      numberOfCards: 5,
    });
    h.prisma.companyListSubmission.findMany.mockResolvedValue([
      {
        id: 1,
        firstname: null,
        lastname: null,
        agreeToUseName: true,
        createdAt: new Date(),
        CompanyListSubmissionTrack: [
          { trackId: 10, position: 1, isBirthdayTrack: false },
        ],
      },
    ]);
    h.prisma.track.findMany.mockResolvedValue([
      { id: 10, trackId: 'sp10', name: 'S', artist: 'A', year: 1, spotifyLink: 'x', youtubeLink: null, manuallyChecked: false },
    ]);
    const res = await vibe.getRanking(1);
    expect(res.data.ranking[0].voters).toEqual([]);
    expect(res.data.ranking[0].voteCount).toBe(1);
  });

  it('maps prisma errors', async () => {
    h.prisma.companyList.findUnique.mockRejectedValue(new Error('x'));
    expect(await vibe.getRanking(1)).toMatchObject({
      success: false,
      error: 'Error calculating list ranking',
    });
  });
});

describe('finalizeList', () => {
  function arrangeFinalize() {
    // finalizeList's own lookup (include) vs getRanking's lookup (select)
    h.prisma.companyList.findUnique.mockImplementation(async (args: any) =>
      args.include
        ? {
            id: 1,
            name: 'Lijst',
            numberOfCards: 2,
            Company: { id: 7, name: 'Acme' },
          }
        : { id: 1, name: 'Lijst', numberOfTracks: 3, numberOfCards: 2 }
    );
    // finalize submissions query (status submitted) vs ranking query
    h.prisma.companyListSubmission.findMany.mockImplementation(async ({ where }: any) => {
      const fixture = [
        {
          id: 1,
          firstname: 'Alice',
          lastname: 'A',
          agreeToUseName: true,
          createdAt: new Date('2026-01-01T10:00:00Z'),
          CompanyListSubmissionTrack: [
            { trackId: 10, position: 1, isBirthdayTrack: false },
            { trackId: 11, position: 2, isBirthdayTrack: false },
          ],
        },
        {
          id: 2,
          firstname: 'Bob',
          lastname: null,
          agreeToUseName: false,
          createdAt: new Date('2026-01-02T10:00:00Z'),
          CompanyListSubmissionTrack: [
            { trackId: 11, position: 1, isBirthdayTrack: false },
            { trackId: 12, position: 2, isBirthdayTrack: true },
          ],
        },
      ];
      return where.status === 'submitted' ? fixture : fixture;
    });
    h.prisma.track.findMany.mockResolvedValue([
      { id: 10, trackId: 'sp10', name: 'Song 10', artist: 'Art 10', year: 1990, manuallyChecked: true, spotifyLink: 'https://open.spotify.com/track/sp10', youtubeLink: null },
      { id: 11, trackId: 'sp11', name: 'Song 11', artist: 'Art 11', year: 1991, manuallyChecked: true, spotifyLink: 'https://open.spotify.com/track/sp11', youtubeLink: null },
      { id: 12, trackId: 'sp12', name: 'Song 12', artist: 'Art 12', year: 1992, manuallyChecked: false, spotifyLink: 'https://open.spotify.com/track/sp12', youtubeLink: null },
    ]);
    h.prisma.companyList.update.mockResolvedValue({ id: 1, slug: 'lijst-slug' });
  }

  it('returns not-found when the list is missing', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(null);
    expect(await vibe.finalizeList(1)).toMatchObject({
      success: false,
      error: 'Company list not found',
    });
  });

  it('propagates ranking failures', async () => {
    h.prisma.companyList.findUnique.mockImplementation(async (args: any) =>
      args.include
        ? { id: 1, name: 'L', numberOfCards: 2, Company: { name: 'Acme' } }
        : { id: 1, name: 'L', numberOfTracks: 0, numberOfCards: 2 }
    );
    h.prisma.companyListSubmission.findMany.mockResolvedValue([]);
    const res = await vibe.finalizeList(1);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Failed to calculate ranking');
  });

  it('creates limited + full playlists, stores their URLs and finalizes status', async () => {
    arrangeFinalize();
    h.spotify.createOrUpdatePlaylist
      .mockResolvedValueOnce({
        success: true,
        data: { playlistId: 'lim1', playlistUrl: 'https://sp/limited' },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { playlistId: 'full1', playlistUrl: 'https://sp/full' },
      });

    const res = await vibe.finalizeList(1);
    expect(res.success).toBe(true);

    // Limited playlist: top-2 by ranking (t11, t10), via Track.trackId
    expect(h.spotify.createOrUpdatePlaylist).toHaveBeenNthCalledWith(
      1,
      'Acme - Lijst',
      ['sp11', 'sp10']
    );
    // Full playlist: every ranked track, ids parsed from spotifyLink
    expect(h.spotify.createOrUpdatePlaylist).toHaveBeenNthCalledWith(
      2,
      'Acme - Lijst (FULL)',
      ['sp11', 'sp10', 'sp12']
    );

    // URL updates + final status flip
    const updates = h.prisma.companyList.update.mock.calls.map((c) => c[0].data);
    expect(updates).toContainEqual({ playlistUrl: 'https://sp/limited' });
    expect(updates).toContainEqual({ playlistUrlFull: 'https://sp/full' });
    expect(updates).toContainEqual({
      status: 'spotify_list_generated',
      spotifyRefreshRequired: false,
    });
    expect(h.cacheDel).toHaveBeenCalledWith('companyListByDomain:lijst-slug');

    // Result payload
    expect(res.data.companyName).toBe('Acme');
    expect(res.data.totalSubmissions).toBe(2);
    expect(res.data.tracks).toEqual([
      expect.objectContaining({
        position: 1,
        trackId: 11,
        spotifyTrackId: 'sp11',
        artist: 'Art 11',
        title: 'Song 11',
        score: 5,
        voteCount: 2,
      }),
      expect.objectContaining({ position: 2, trackId: 10, spotifyTrackId: 'sp10' }),
    ]);
    expect(res.data.playlistLimited).toEqual({
      playlistId: 'lim1',
      playlistUrl: 'https://sp/limited',
    });
  });

  it('skips URL updates when playlist creation fails but still finalizes', async () => {
    arrangeFinalize();
    h.spotify.createOrUpdatePlaylist.mockResolvedValue({
      success: false,
      error: 'spotify down',
    });

    const res = await vibe.finalizeList(1);
    expect(res.success).toBe(true);
    const updates = h.prisma.companyList.update.mock.calls.map((c) => c[0].data);
    expect(updates).toEqual([
      { status: 'spotify_list_generated', spotifyRefreshRequired: false },
    ]);
    expect(res.data.playlistLimited).toEqual({ error: 'spotify down' });
    expect(res.data.playlistFull).toEqual({ error: 'spotify down' });
  });
});

describe('createPlaylist', () => {
  it('rejects empty track lists', async () => {
    expect(await vibe.createPlaylist('Acme', 'L', [])).toMatchObject({
      success: false,
      error: 'No tracks provided',
    });
    expect(h.spotify.createOrUpdatePlaylist).not.toHaveBeenCalled();
  });

  it('delegates to Spotify with the combined name', async () => {
    h.spotify.createOrUpdatePlaylist.mockResolvedValue({
      success: true,
      data: { playlistId: 'p1' },
    });
    const res = await vibe.createPlaylist('Acme', 'Lijst', ['a', 'b']);
    expect(res).toEqual({ success: true, data: { playlistId: 'p1' } });
    expect(h.spotify.createOrUpdatePlaylist).toHaveBeenCalledWith('Acme - Lijst', [
      'a',
      'b',
    ]);
  });

  it('passes through Spotify failures untouched', async () => {
    h.spotify.createOrUpdatePlaylist.mockResolvedValue({
      success: false,
      error: 'nope',
    });
    expect(await vibe.createPlaylist('Acme', 'L', ['a'])).toEqual({
      success: false,
      error: 'nope',
    });
  });

  it('catches thrown errors', async () => {
    h.spotify.createOrUpdatePlaylist.mockRejectedValue(new Error('boom'));
    expect(await vibe.createPlaylist('Acme', 'L', ['a'])).toMatchObject({
      success: false,
      error: 'Error creating Spotify playlist',
    });
  });
});

describe('status progression (private helpers)', () => {
  const anyVibe = vibe as any;

  it('only ever moves forward through the progression', () => {
    expect(anyVibe.getUpdatedStatus('new', 'card')).toBe('card');
    expect(anyVibe.getUpdatedStatus('card', 'new')).toBe('card');
    expect(anyVibe.getUpdatedStatus('questions', 'questions')).toBe('questions');
  });

  it('falls back sensibly for statuses outside the progression', () => {
    expect(anyVibe.getUpdatedStatus('weird', 'box')).toBe('box');
    expect(anyVibe.getUpdatedStatus('box', 'weird')).toBe('box');
  });

  it('exposes the canonical progression order', () => {
    expect(anyVibe.getStatusProgression()).toEqual([
      'new',
      'company',
      'questions',
      'box',
      'card',
      'playlist',
      'personalize',
    ]);
  });
});

describe('addTrackExtraInfo (private)', () => {
  const anyVibe = vibe as any;

  function arrangeSubmissionTracks() {
    h.prisma.companyListSubmissionTrack.findMany.mockResolvedValue([
      {
        trackId: 10,
        CompanyListSubmission: {
          firstname: 'A',
          lastname: 'B',
          cardName: 'Rick G',
          agreeToUseName: true,
        },
      },
      {
        trackId: 10,
        CompanyListSubmission: {
          firstname: 'C',
          lastname: 'D',
          cardName: 'Jane D',
          agreeToUseName: true,
        },
      },
      {
        trackId: 10,
        CompanyListSubmission: {
          firstname: 'E',
          lastname: 'F',
          cardName: 'Hidden',
          agreeToUseName: false,
        },
      },
      {
        trackId: 20,
        CompanyListSubmission: {
          firstname: 'G',
          lastname: 'H',
          cardName: null,
          agreeToUseName: true,
        },
      },
    ]);
    h.prisma.trackExtraInfo.create.mockResolvedValue({});
  }

  it('writes ranked positions and consenting card names (nbsp-joined)', async () => {
    arrangeSubmissionTracks();
    await anyVibe.addTrackExtraInfo(1, 500, true, [20, 10]);

    expect(h.prisma.trackExtraInfo.create).toHaveBeenCalledTimes(2);
    const datas = h.prisma.trackExtraInfo.create.mock.calls.map((c) => c[0].data);
    expect(datas[0]).toEqual({
      playlistId: 500,
      trackId: 20,
      extraNameAttribute: '', // voter had no cardName
      extraArtistAttribute: '#1',
    });
    expect(datas[1]).toEqual({
      playlistId: 500,
      trackId: 10,
      extraNameAttribute: 'Rick&nbsp;G • Jane&nbsp;D', // non-consenting voter excluded
      extraArtistAttribute: '#2',
    });
  });

  it('omits all names when shownames is false', async () => {
    arrangeSubmissionTracks();
    await anyVibe.addTrackExtraInfo(1, 500, false, [10, 20]);
    const datas = h.prisma.trackExtraInfo.create.mock.calls.map((c) => c[0].data);
    expect(datas.every((d: any) => d.extraNameAttribute === '')).toBe(true);
  });

  it('falls back to map ordering when no ranking is provided', async () => {
    arrangeSubmissionTracks();
    await anyVibe.addTrackExtraInfo(1, 500, true);
    expect(h.prisma.trackExtraInfo.create).toHaveBeenCalledTimes(2);
  });

  it('swallows database errors instead of failing the caller', async () => {
    h.prisma.companyListSubmissionTrack.findMany.mockRejectedValue(new Error('x'));
    await expect(anyVibe.addTrackExtraInfo(1, 500, true)).resolves.toBeUndefined();
    expect(h.prisma.trackExtraInfo.create).not.toHaveBeenCalled();
  });
});
