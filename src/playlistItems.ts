import axios from 'axios';
import SpotifyApi2 from './spotify_api2';

/** One playlist entry exactly as Spotify holds it: nothing merged, filtered or enriched. */
export interface PlaylistItem {
  position: number;
  trackId: string | null;
  name: string | null;
  artists: string[];
  isrc: string | null;
  isLocal: boolean;
  type: string | null;
}

export interface PlaylistItems {
  playlistId: string;
  name: string | null;
  owner: string | null;
  total: number;
  items: PlaylistItem[];
}

const PAGE = 100;

/**
 * Reads a playlist's entries in order, straight from the Spotify Web API with
 * our own account's token. Spotify.getTracks() is meant for card generation:
 * it drops duplicates (same artist + title or ISRC), tracks without album art
 * and unavailable tracks, and rewrites names from our database. That is right
 * for printing and wrong for checking that a playlist holds exactly the tracks
 * it should, which is what this is for (the qrsong toolkit's verify step).
 *
 * Uses /playlists/{id}/items (the post-2026 endpoint, entries under `item`)
 * and falls back to /tracks (entries under `track`) when /items is refused.
 */
export async function readPlaylistItems(playlistId: string): Promise<PlaylistItems> {
  const token = await new SpotifyApi2().getAccessToken();
  if (!token) throw new Error('Spotify authentication required');
  const headers = { Authorization: `Bearer ${token}` };

  const meta = await axios.get(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}`, {
    headers,
    params: { fields: 'name,owner(id)' },
  });

  const fetchPage = async (endpoint: 'items' | 'tracks', offset: number) =>
    axios.get(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/${endpoint}`, {
      headers,
      params: {
        limit: PAGE,
        offset,
        fields:
          'total,next,items(is_local,item(id,name,type,artists(name),external_ids),track(id,name,type,artists(name),external_ids))',
      },
    });

  let endpoint: 'items' | 'tracks' = 'items';
  let first: Awaited<ReturnType<typeof fetchPage>>;
  try {
    first = await fetchPage(endpoint, 0);
  } catch (error: any) {
    const status = error?.response?.status;
    if (status !== 403 && status !== 404) throw error;
    endpoint = 'tracks';
    first = await fetchPage(endpoint, 0);
  }

  const total: number = first.data.total ?? 0;
  const raw: any[] = [...(first.data.items ?? [])];
  while (raw.length < total) {
    const page = await fetchPage(endpoint, raw.length);
    const items = page.data.items ?? [];
    if (items.length === 0) break;
    raw.push(...items);
  }

  const items: PlaylistItem[] = raw.map((entry, position) => {
    const t = entry?.item ?? entry?.track ?? null;
    return {
      position,
      trackId: t?.id ?? null,
      name: t?.name ?? null,
      artists: Array.isArray(t?.artists) ? t.artists.map((a: any) => a?.name).filter(Boolean) : [],
      isrc: t?.external_ids?.isrc ?? null,
      isLocal: !!entry?.is_local,
      type: t?.type ?? null,
    };
  });

  return {
    playlistId,
    name: meta.data?.name ?? null,
    owner: meta.data?.owner?.id ?? null,
    total,
    items,
  };
}
