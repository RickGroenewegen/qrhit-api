import PrismaInstance from './prisma';
import Data from './data';
import { queueProductPhoto } from './productPhoto/triggers';
import { MusicProviderFactory } from './providers';

/**
 * Points an existing playlist row at another Spotify playlist, keeping everything the row carries: slug and
 * product page, featured state, texts and translations, image, ranking and the Merchant Center product
 * (first: "Russian Hits", 2026-10-21, a featured list on someone else's Spotify account; the cleaned copy in our
 * own account takes its place). The tracks are then fetched from the new playlist and stored on the row the
 * way an order does (`storeTracks`, which also drops the ones that are no longer in it); a song new to the
 * database comes in without a checked year, and `openYears` in the toolkit lists those.
 *
 * Orders keep referencing the same row, so a regenerate or "order again" of an older order uses the new list.
 * That is why it refuses while an order of the row is still open: paid but not finalized, or a physical
 * Print&Bind line not yet sent to the printer. Our own business orders (toolkit_…) go to their printer by mail
 * and are judged on finalized only.
 */

export class PlaylistReplaceError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface ReplaceOrderRow {
  orderId: string | number;
  paymentId: string;
  status: string;
  type: string;
  finalized: boolean;
  sentToPrinter: boolean;
}

/** The orders that block a swap: paid, and not finalized or (Print&Bind, physical) not sent to the printer yet. */
export function openOrders(rows: ReplaceOrderRow[]): ReplaceOrderRow[] {
  return rows.filter((r) => {
    if (r.status !== 'paid') return false;
    if (!r.finalized) return true;
    const ownPrinter = r.paymentId.startsWith('toolkit_');
    return r.type === 'physical' && !ownPrinter && !r.sentToPrinter;
  });
}

const PLAYLIST_ID = /^[A-Za-z0-9]{22}$/;

export async function replaceSpotifyPlaylist(oldPlaylistId: string, newPlaylistId: string, apply: boolean) {
  if (!PLAYLIST_ID.test(oldPlaylistId) || !PLAYLIST_ID.test(newPlaylistId)) {
    throw new PlaylistReplaceError('invalid playlist id');
  }
  // The same id twice: the row already plays this playlist, only its tracks are stored again (a swap whose
  // track load failed, or a list changed on Spotify since).
  const reloadOnly = oldPlaylistId === newPlaylistId;
  const prisma = PrismaInstance.getInstance();

  const row = await prisma.playlist.findUnique({
    where: { playlistId: oldPlaylistId },
    select: { id: true, playlistId: true, name: true, slug: true, featured: true, serviceType: true, numberOfTracks: true },
  });
  if (!row) throw new PlaylistReplaceError(`no playlist row for ${oldPlaylistId}`, 404);
  if (row.serviceType !== 'spotify') throw new PlaylistReplaceError(`playlist ${oldPlaylistId} is ${row.serviceType}, not spotify`);

  const taken = reloadOnly
    ? null
    : await prisma.playlist.findUnique({ where: { playlistId: newPlaylistId }, select: { id: true, name: true } });
  if (taken) {
    throw new PlaylistReplaceError(
      `Spotify playlist ${newPlaylistId} already has its own row (${taken.id}, "${taken.name}"); it cannot take over row ${row.id}`,
      409
    );
  }

  const lines = await prisma.paymentHasPlaylist.findMany({
    where: { playlistId: row.id },
    select: {
      type: true,
      payment: { select: { orderId: true, paymentId: true, status: true, finalized: true, sentToPrinter: true } },
    },
  });
  const orders: ReplaceOrderRow[] = lines.map((l: any) => ({
    orderId: String(l.payment.orderId),
    paymentId: l.payment.paymentId,
    status: l.payment.status,
    type: l.type,
    finalized: !!l.payment.finalized,
    sentToPrinter: !!l.payment.sentToPrinter,
  }));
  const blocking = openOrders(orders);
  const before = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    featured: row.featured,
    spotify: oldPlaylistId,
    tracks: row.numberOfTracks,
    paidOrders: orders.filter((o) => o.status === 'paid').length,
  };
  if (blocking.length) {
    throw new PlaylistReplaceError(
      `orders of this playlist are still open: ${blocking.map((o) => o.orderId).join(', ')}; swap after they are printed`,
      409
    );
  }
  if (!apply) return { applied: false, before, after: { spotify: newPlaylistId } };

  const data = Data.getInstance();
  if (!reloadOnly) {
    await prisma.playlist.update({
      where: { id: row.id },
      data: { playlistId: newPlaylistId, markedForMerchantCenter: true },
    });
    await data.clearPlaylistCache(oldPlaylistId, row.slug || undefined);
  }
  await data.clearPlaylistCache(newPlaylistId, row.slug || undefined);

  // Fetched like the generator does, and stored on the row like an order does: fetching alone stores nothing.
  const provider = MusicProviderFactory.getInstance().getProvider('spotify');
  const response: any = await provider.getTracks(newPlaylistId, { cache: false, allowDuplicates: false });
  let error: string | undefined;
  if (response?.success && response.data?.tracks?.length) {
    const tracks = response.data.tracks;
    const trackOrder = new Map<string, number>();
    tracks.forEach((track: any, index: number) => trackOrder.set(track.id, index + 1));
    await data.storeTracks(row.id, newPlaylistId, tracks, trackOrder, 'spotify', 'en');
    await prisma.playlist.update({ where: { id: row.id }, data: { numberOfTracks: tracks.length } });
    await data.clearPlaylistCache(newPlaylistId, row.slug || undefined);
    // songs that left the playlist are picked again
    if (row.featured) queueProductPhoto(row.id);
  } else {
    error = response?.error || 'no tracks fetched';
  }
  const after = await prisma.playlist.findUnique({
    where: { id: row.id },
    select: { playlistId: true, slug: true, name: true, featured: true, numberOfTracks: true },
  });
  const stored = await prisma.playlistHasTrack.count({ where: { playlistId: row.id } });
  return {
    applied: true,
    reloadOnly,
    before,
    after: { ...after, storedTracks: stored, loaded: !error, error },
  };
}
