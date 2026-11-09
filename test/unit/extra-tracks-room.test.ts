import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Extra cards on the corrections page for a playlist the customer cannot add
 * songs to (src/extraTracksRoom.ts, Upgrade.extraTracksForLine). The cases are
 * the real ones from production: order 100009738 line 10825 bought +10 on
 * "House & Techno Classics" (150 songs, featured, another customer's) and was
 * stuck; 10807 Blasmusikster had 150 songs on 140 paid cards and reloaded
 * fine after +10; 10056 "Marlous en Erik 2026" is featured but the buyer's
 * own submission.
 */

const h = vi.hoisted(() => ({
  prisma: {
    paymentHasPlaylist: { findUnique: vi.fn() },
    aISearch: { count: vi.fn() },
    playlistHasTrack: { count: vi.fn() },
  },
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  getProviderByString: vi.fn(),
  getTracks: vi.fn(),
  getStorefrontForLocale: vi.fn(),
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => h.prisma },
}));
vi.mock('../../src/cache', () => ({
  default: { getInstance: () => ({ get: h.cacheGet, set: h.cacheSet }) },
}));
vi.mock('../../src/services/MusicServiceRegistry', () => ({
  default: {
    getInstance: () => ({ getProviderByString: h.getProviderByString }),
  },
}));
vi.mock('../../src/providers/AppleMusicProvider', () => ({
  default: {
    getInstance: () => ({ getStorefrontForLocale: h.getStorefrontForLocale }),
  },
}));

import {
  customerCanAddSongs,
  extraTracksRoom,
  tierFitsRoom,
  sourceCountCacheKey,
  SOURCE_COUNT_TTL_SECONDS,
} from '../../src/extraTracksRoom';
import Upgrade from '../../src/upgrade';
import { EXTRA_TRACK_TIERS, MAX_CARDS_PHYSICAL } from '../../src/config/constants';

const upgrade = Upgrade.getInstance();
const tracksOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));

describe('customerCanAddSongs', () => {
  it("refuses a featured playlist submitted by another customer (line 10825)", () => {
    expect(
      customerCanAddSongs({
        featured: true,
        promotionalUserId: 2315,
        holderUserId: 7039,
        aiGenerated: false,
      })
    ).toBe(false);
  });

  it('refuses one of our own featured playlists (no submitter)', () => {
    expect(
      customerCanAddSongs({
        featured: true,
        promotionalUserId: null,
        holderUserId: 7039,
        aiGenerated: false,
      })
    ).toBe(false);
  });

  it('accepts a featured playlist the holder submitted themself (line 10056)', () => {
    expect(
      customerCanAddSongs({
        featured: true,
        promotionalUserId: 6533,
        holderUserId: 6533,
        aiGenerated: false,
      })
    ).toBe(true);
  });

  it("accepts the customer's own playlist", () => {
    expect(
      customerCanAddSongs({
        featured: false,
        promotionalUserId: null,
        holderUserId: 7039,
        aiGenerated: false,
      })
    ).toBe(true);
  });

  it('refuses an AI playlist: it lives in our account', () => {
    expect(
      customerCanAddSongs({
        featured: false,
        promotionalUserId: null,
        holderUserId: 7039,
        aiGenerated: true,
      })
    ).toBe(false);
  });
});

describe('extraTracksRoom', () => {
  it('sets no limit of its own when the customer can add songs', () => {
    expect(extraTracksRoom(true, 150, 150)).toBeNull();
    expect(extraTracksRoom(true, null, 150)).toBeNull();
  });

  it('has no room when every song is paid for (line 10825)', () => {
    expect(extraTracksRoom(false, 150, 150)).toBe(0);
  });

  it('never goes below zero once more cards are paid than there are songs', () => {
    // line 10825 after its +10: 160 paid, 150 songs
    expect(extraTracksRoom(false, 150, 160)).toBe(0);
  });

  it('counts the unpaid songs (line 10807 before its +10)', () => {
    expect(extraTracksRoom(false, 150, 140)).toBe(10);
  });

  it('sells nothing when the song count is unknown', () => {
    expect(extraTracksRoom(false, null, 140)).toBe(0);
    expect(extraTracksRoom(false, NaN, 140)).toBe(0);
  });
});

describe('tierFitsRoom', () => {
  it('lets every tier through without a room of its own', () => {
    for (const tier of EXTRA_TRACK_TIERS) expect(tierFitsRoom(tier, null)).toBe(true);
  });

  it('only lets the tiers through that the unpaid songs fill', () => {
    expect(tierFitsRoom(10, 10)).toBe(true);
    expect(tierFitsRoom(25, 10)).toBe(false);
    expect(tierFitsRoom(10, 9)).toBe(false);
    expect(tierFitsRoom(10, 0)).toBe(false);
  });
});

describe('Upgrade.availableTrackTiers with a room', () => {
  it('takes the lower of the physical cap and the room', () => {
    expect(upgrade.availableTrackTiers({ numberOfTracks: 140 }, 30)).toEqual([10, 25]);
    expect(upgrade.availableTrackTiers({ numberOfTracks: 150 }, 0)).toEqual([]);
    expect(
      upgrade.availableTrackTiers({ numberOfTracks: MAX_CARDS_PHYSICAL - 25 }, 500)
    ).toEqual([10, 25]);
    expect(upgrade.availableTrackTiers({ numberOfTracks: 140 }, null)).toEqual([
      ...EXTRA_TRACK_TIERS,
    ]);
  });
});

describe('Upgrade.extraTracksForLine', () => {
  const line = (overrides: {
    numberOfTracks?: number;
    aiPrompt?: string | null;
    featured?: boolean;
    promotionalUserId?: number | null;
    serviceType?: string;
    allowDuplicates?: boolean;
  } = {}) => ({
    numberOfTracks: overrides.numberOfTracks ?? 150,
    allowDuplicates: overrides.allowDuplicates ?? false,
    aiPrompt: overrides.aiPrompt ?? null,
    payment: { locale: 'nl' },
    playlist: {
      id: 77,
      playlistId: 'house_techno',
      featured: overrides.featured ?? true,
      promotionalUserId:
        overrides.promotionalUserId === undefined ? 2315 : overrides.promotionalUserId,
      serviceType: overrides.serviceType ?? 'spotify',
    },
  });

  beforeEach(() => {
    for (const fn of [
      h.prisma.paymentHasPlaylist.findUnique,
      h.prisma.aISearch.count,
      h.prisma.playlistHasTrack.count,
      h.cacheGet,
      h.cacheSet,
      h.getProviderByString,
      h.getTracks,
      h.getStorefrontForLocale,
    ]) {
      fn.mockReset();
    }
    h.prisma.aISearch.count.mockResolvedValue(0);
    h.cacheGet.mockResolvedValue(null);
    h.cacheSet.mockResolvedValue(undefined);
    h.getProviderByString.mockReturnValue({ getTracks: h.getTracks });
    h.getStorefrontForLocale.mockReturnValue('nl');
  });

  it("leaves the customer's own playlist alone and asks no music service", async () => {
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue(
      line({ featured: false, promotionalUserId: null })
    );

    expect(await upgrade.extraTracksForLine(10825, 7039)).toEqual({
      playlistEditable: true,
      extraTracksRoom: null,
    });
    expect(h.getTracks).not.toHaveBeenCalled();
  });

  it('gives a featured playlist of another customer no room when every song is paid (line 10825)', async () => {
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue(line());
    h.getTracks.mockResolvedValue({ success: true, data: { tracks: tracksOf(150) } });

    expect(await upgrade.extraTracksForLine(10825, 7039)).toEqual({
      playlistEditable: false,
      extraTracksRoom: 0,
    });
    // read the way the reload reads it, and kept for the next ask
    expect(h.getTracks).toHaveBeenCalledWith('house_techno', {
      cache: false,
      allowDuplicates: false,
      storefront: undefined,
    });
    expect(h.cacheSet).toHaveBeenCalledWith(
      sourceCountCacheKey('house_techno', false),
      '150',
      SOURCE_COUNT_TTL_SECONDS
    );
  });

  it('gives the unpaid songs as room (line 10807 before its +10)', async () => {
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue(
      line({ numberOfTracks: 140, promotionalUserId: 2687 })
    );
    h.getTracks.mockResolvedValue({ success: true, data: { tracks: tracksOf(150) } });

    expect(await upgrade.extraTracksForLine(10807, 7025)).toEqual({
      playlistEditable: false,
      extraTracksRoom: 10,
    });
  });

  it("treats a featured playlist the holder submitted as their own (line 10056)", async () => {
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue(
      line({ promotionalUserId: 6533 })
    );

    expect(await upgrade.extraTracksForLine(10056, 6533)).toEqual({
      playlistEditable: true,
      extraTracksRoom: null,
    });
  });

  it('knows an AI playlist by the prompt on the line', async () => {
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue(
      line({ featured: false, promotionalUserId: null, aiPrompt: '90s eurodance' })
    );
    h.getTracks.mockResolvedValue({ success: true, data: { tracks: tracksOf(150) } });

    const res = await upgrade.extraTracksForLine(1, 7039);

    expect(res).toEqual({ playlistEditable: false, extraTracksRoom: 0 });
    expect(h.prisma.aISearch.count).not.toHaveBeenCalled();
  });

  it('knows an AI playlist by its search when the line has no prompt', async () => {
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue(
      line({ featured: false, promotionalUserId: null })
    );
    h.prisma.aISearch.count.mockResolvedValue(1);
    h.getTracks.mockResolvedValue({ success: true, data: { tracks: tracksOf(150) } });

    expect((await upgrade.extraTracksForLine(1, 7039)).playlistEditable).toBe(false);
    expect(h.prisma.aISearch.count).toHaveBeenCalledWith({
      where: { spotifyPlaylistId: 'house_techno' },
    });
  });

  it('uses the count the last reload kept instead of asking again', async () => {
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue(line({ numberOfTracks: 140 }));
    h.cacheGet.mockResolvedValue('175');

    expect((await upgrade.extraTracksForLine(1, 7039)).extraTracksRoom).toBe(35);
    expect(h.getTracks).not.toHaveBeenCalled();
  });

  it('falls back to the songs we stored when the service does not answer', async () => {
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue(line({ numberOfTracks: 140 }));
    h.getTracks.mockResolvedValue({ success: false });
    h.prisma.playlistHasTrack.count.mockResolvedValue(150);

    expect((await upgrade.extraTracksForLine(1, 7039)).extraTracksRoom).toBe(10);
    expect(h.prisma.playlistHasTrack.count).toHaveBeenCalledWith({
      where: { playlistId: 77 },
    });
    expect(h.cacheSet).not.toHaveBeenCalled();
  });

  it('sells nothing when neither the service nor the database answers', async () => {
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue(line({ numberOfTracks: 140 }));
    h.getTracks.mockRejectedValue(new Error('timeout'));
    h.prisma.playlistHasTrack.count.mockRejectedValue(new Error('db down'));

    expect((await upgrade.extraTracksForLine(1, 7039)).extraTracksRoom).toBe(0);
  });

  it('reads Apple Music in the storefront of the order language', async () => {
    h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue(
      line({ serviceType: 'apple_music', allowDuplicates: true })
    );
    h.getTracks.mockResolvedValue({ success: true, data: { tracks: tracksOf(150) } });

    await upgrade.extraTracksForLine(1, 7039);

    expect(h.getStorefrontForLocale).toHaveBeenCalledWith('nl');
    expect(h.getTracks).toHaveBeenCalledWith('house_techno', {
      cache: false,
      allowDuplicates: true,
      storefront: 'nl',
    });
  });
});
