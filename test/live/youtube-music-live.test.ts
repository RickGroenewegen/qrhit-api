import { describe, it, expect } from 'vitest';
import YouTubeMusicProvider from '../../src/providers/YouTubeMusicProvider';
import { ServiceType } from '../../src/enums/ServiceType';

/**
 * Live tests against the real YouTube Music innertube API. Every call passes
 * cache=false so the request actually leaves the machine.
 *
 * These guard the browse-ID handling: auto-generated (RD...) and album
 * (OLAK5uy...) playlists 400 unless the ID is VL-prefixed, which is how
 * playlist fetching broke on 28-07-2026.
 *
 * Assertions stay loose on anything YouTube can change (titles, exact track
 * counts) and strict on the things we control (no duplicates, every track
 * usable, counts consistent with the metadata).
 */

// '80s Pop - a YouTube-generated playlist, ~100 tracks
const AUTO_GENERATED_ID = 'RDCLAK5uy_k1Wu8QbZASiGVqr1wmie9NIYo38aBqscQ';
// The Beatles - Abbey Road, an album playlist
const ALBUM_ID = 'OLAK5uy_k2JcEE3_maNjnVBKU2s1JjhaZ4rxwgaME';
// A regular user-facing playlist
const REGULAR_ID = 'PLFgquLnL59alW3xmYiWRaoz0oM3H17Lth';
// A personalised mix: browses fine, but never returns items
const MIX_ID = 'RDAMVMlcOxhH8N3Bo';

const provider = YouTubeMusicProvider.getInstance();

function expectUsableTracks(tracks: any[]) {
  for (const track of tracks) {
    expect(track.id, 'every track needs an id').toBeTruthy();
    expect(track.name, `track ${track.id} needs a name`).toBeTruthy();
    expect(track.artist, `track ${track.id} needs an artist`).toBeTruthy();
    expect(track.serviceType).toBe(ServiceType.YOUTUBE_MUSIC);
    expect(track.serviceLink).toBe(`https://music.youtube.com/watch?v=${track.id}`);
  }
}

describe('live: YouTube Music auto-generated playlist', () => {
  it('fetches metadata', async () => {
    const result = await provider.getPlaylist(AUTO_GENERATED_ID, false);

    expect(result.success, `getPlaylist failed: ${result.error}`).toBe(true);
    expect(result.data?.name).toBeTruthy();
    expect(result.data?.name).not.toBe('Unknown Playlist');
    expect(result.data?.trackCount).toBeGreaterThan(50);
    expect(result.data?.imageUrl).toMatch(/^https?:\/\//);
    expect(result.data?.originalUrl).toBe(
      `https://music.youtube.com/playlist?list=${AUTO_GENERATED_ID}`
    );
  });

  it('fetches every track once, with no duplicates from the repeated pages', async () => {
    const result = await provider.getTracks(AUTO_GENERATED_ID, false);

    expect(result.success, `getTracks failed: ${result.error}`).toBe(true);

    const tracks = result.data!.tracks;
    expect(tracks.length).toBeGreaterThan(50);
    expect(result.data!.total).toBe(tracks.length);

    // YouTube resends the first page inside the continuation for these
    // playlists, so a naive append doubles the deck
    const ids = tracks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);

    expectUsableTracks(tracks);
  });

  it('returns roughly the number of tracks the playlist claims to hold', async () => {
    const meta = await provider.getPlaylist(AUTO_GENERATED_ID, false);
    const tracks = await provider.getTracks(AUTO_GENERATED_ID, false);

    const claimed = meta.data!.trackCount;
    const fetched = tracks.data!.total;

    // Unavailable tracks are dropped by YouTube, so allow a small shortfall,
    // but never more than claimed: that would mean duplicates crept back in
    expect(fetched).toBeLessThanOrEqual(claimed);
    expect(fetched).toBeGreaterThanOrEqual(claimed - 5);
  });
});

describe('live: YouTube Music album playlist', () => {
  it('fetches the album tracks', async () => {
    const result = await provider.getTracks(ALBUM_ID, false);

    expect(result.success, `getTracks failed: ${result.error}`).toBe(true);

    const tracks = result.data!.tracks;
    expect(tracks.length).toBeGreaterThan(5);
    expect(new Set(tracks.map((t) => t.id)).size).toBe(tracks.length);
    expectUsableTracks(tracks);
  });
});

describe('live: YouTube Music regular playlist', () => {
  it('fetches metadata and tracks', async () => {
    const meta = await provider.getPlaylist(REGULAR_ID, false);
    expect(meta.success, `getPlaylist failed: ${meta.error}`).toBe(true);
    expect(meta.data?.name).toBeTruthy();

    const tracks = await provider.getTracks(REGULAR_ID, false);
    expect(tracks.success, `getTracks failed: ${tracks.error}`).toBe(true);
    expect(tracks.data!.tracks.length).toBeGreaterThan(0);
    expectUsableTracks(tracks.data!.tracks);
  });
});

describe('live: YouTube Music personalised mix', () => {
  it('reports mixes as unsupported instead of returning an empty deck', async () => {
    const result = await provider.getTracks(MIX_ID, false);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Radio/mix playlists are not supported');
  });
});

describe('live: YouTube Music search', () => {
  it('finds a well-known track', async () => {
    const result = await provider.searchTracks('Bonnie Tyler Total Eclipse of the Heart', 5);

    expect(result.success, `searchTracks failed: ${result.error}`).toBe(true);
    expect(result.data!.tracks.length).toBeGreaterThan(0);

    const hit = result.data!.tracks.some((t) =>
      `${t.artist} ${t.name}`.toLowerCase().includes('bonnie tyler')
    );
    expect(hit, 'expected Bonnie Tyler in the results').toBe(true);
  });
});
