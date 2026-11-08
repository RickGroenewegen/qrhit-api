import slugify from 'slugify';
import PrismaInstance from './prisma';
import Data from './data';
import { MusicProviderFactory } from './providers';

/**
 * Points one order line at another Spotify playlist before it is printed (first: Esther Brauhardt, 100009410,
 * 2026-11-08: she reworked the featured "Dance Dance Dance" she had ordered into her own "Rock the Dancefloor"
 * and asked whether that list could take its place, without cancelling and ordering again).
 *
 * `replace-spotify` (src/playlistReplace.ts) changes a playlist row, and with it every order and the product page
 * of that row. This changes only the line: its design, box, price and paid card count stay, its playlist becomes
 * the row of the new Spotify playlist (made the way checkout makes one when there is none yet), and the tracks
 * are fetched and stored on that row the way an order does. The line's review starts again
 * (`eligableForPrinter`, `userConfirmedPrinting`, `suggestionsPending` off) and so does the order's approval
 * (`userAgreedToPrinting`): the customer has not seen the cards of the new list. The PDFs still hold the old list
 * until the order is regenerated (`qrsong order cards <id> --regenerate`, which also restarts the printer timer).
 *
 * The paid card count (`payment_has_playlist.numberOfTracks`) is not touched: the answer compares it with the
 * new list (`cards`). The generator prints the list as stored, so more songs than paid means free cards unless
 * the customer pays the difference (Rick's call; `mailbox paylink`).
 */

export class LineSwapError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const PLAYLIST_ID = /^[A-Za-z0-9]{22}$/;

export interface SwapLineState {
  orderId: string;
  status: string;
  sentToPrinter: boolean;
  printApiOrderId: string | null;
  type: string;
  /** `ownerUserId` set: a set given to someone else (src/gift.ts). */
  gifted: boolean;
  serviceType: string;
  currentSpotifyId: string;
}

/** Why this line cannot take another playlist, or null when it can. */
export function swapRefusal(line: SwapLineState, newSpotifyId: string): string | null {
  if (!PLAYLIST_ID.test(newSpotifyId)) return 'invalid playlist id';
  if (line.status !== 'paid') return `order ${line.orderId} is not paid (${line.status})`;
  if (line.sentToPrinter || line.printApiOrderId) {
    return `order ${line.orderId} is already at the printer: ask Print&Bind, a swap would change nothing there`;
  }
  // A digital line's PDF went out by mail on finalizing: a swap would hand over a second list
  if (line.type !== 'physical') return `line is ${line.type}: only a printed line that is not at the printer yet`;
  if (line.gifted) return 'the line was given to someone else (gift): its playlist stays';
  if (line.serviceType !== 'spotify') return `the line plays ${line.serviceType}, not spotify`;
  if (line.currentSpotifyId === newSpotifyId) return 'the line already plays this playlist';
  return null;
}

/** The paid cards against the new list, with what it means. */
export function cardComparison(paid: number, tracks: number) {
  const difference = tracks - paid;
  const note =
    difference === 0
      ? 'as many songs as paid cards'
      : difference > 0
        ? `${difference} more songs than paid cards: the generator prints all ${tracks}, so the difference is free unless the customer pays it`
        : `${-difference} fewer songs than paid cards: ${tracks} cards, the price stays`;
  return { paid, tracks, difference, note };
}

export async function swapLinePlaylist(lineId: number, newSpotifyId: string, apply: boolean) {
  if (!Number.isInteger(lineId) || lineId <= 0) throw new LineSwapError('invalid line id');
  const prisma = PrismaInstance.getInstance();

  const line = await prisma.paymentHasPlaylist.findUnique({
    where: { id: lineId },
    select: {
      id: true,
      type: true,
      numberOfTracks: true,
      price: true,
      ownerUserId: true,
      allowDuplicates: true,
      playlist: { select: { id: true, playlistId: true, name: true, slug: true, featured: true, serviceType: true } },
      payment: {
        select: {
          id: true,
          orderId: true,
          paymentId: true,
          status: true,
          sentToPrinter: true,
          printApiOrderId: true,
          locale: true,
        },
      },
    },
  });
  if (!line) throw new LineSwapError(`no order line ${lineId}`, 404);

  const refusal = swapRefusal(
    {
      orderId: String(line.payment.orderId),
      status: line.payment.status,
      sentToPrinter: !!line.payment.sentToPrinter,
      printApiOrderId: line.payment.printApiOrderId,
      type: line.type,
      gifted: line.ownerUserId !== null,
      serviceType: line.playlist.serviceType,
      currentSpotifyId: line.playlist.playlistId,
    },
    newSpotifyId
  );
  if (refusal) throw new LineSwapError(refusal, refusal === 'invalid playlist id' ? 400 : 409);

  // Read before anything is written: a private or removed playlist stops here, as it would at checkout
  const provider = MusicProviderFactory.getInstance().getProvider('spotify');
  const meta: any = await provider.getPlaylist(newSpotifyId, false);
  if (!meta?.success || !meta.data) {
    throw new LineSwapError(
      `Spotify gives no playlist ${newSpotifyId} (${meta?.error || 'not found'}): private, removed or a typo? It must be public`,
      404
    );
  }
  const response: any = await provider.getTracks(newSpotifyId, {
    cache: false,
    allowDuplicates: line.allowDuplicates === true,
  });
  const tracks: any[] = response?.success ? response.data?.tracks ?? [] : [];
  if (!tracks.length) {
    throw new LineSwapError(`no tracks fetched from ${newSpotifyId}: ${response?.error || 'the playlist is empty'}`, 502);
  }

  const existing = await prisma.playlist.findUnique({
    where: { playlistId: newSpotifyId },
    select: { id: true, name: true, featured: true },
  });
  const before = {
    lineId: line.id,
    orderId: String(line.payment.orderId),
    paymentId: line.payment.paymentId,
    row: { id: line.playlist.id, name: line.playlist.name, featured: line.playlist.featured, spotify: line.playlist.playlistId },
    paidCards: line.numberOfTracks,
    price: line.price,
  };
  const after = {
    spotify: newSpotifyId,
    name: meta.data.name as string,
    tracks: tracks.length,
    row: existing ? { id: existing.id, name: existing.name, featured: existing.featured } : 'new',
  };
  const cards = cardComparison(line.numberOfTracks, tracks.length);
  if (!apply) return { applied: false, before, after, cards };

  let rowId: number;
  if (existing) {
    rowId = existing.id;
  } else {
    const name = String(meta.data.name || 'Playlist');
    const slug =
      slugify(name, { lower: true, strict: true }).replace(/^-+|-+$/g, '') || `playlist-${newSpotifyId}`;
    const created = await prisma.playlist.create({
      data: {
        playlistId: newSpotifyId,
        name,
        slug,
        image: meta.data.imageUrl || '',
        price: line.price,
        numberOfTracks: tracks.length,
        type: 'cards',
        serviceType: 'spotify',
      },
    });
    rowId = created.id;
  }

  // Stored on the row the way an order does: fetching alone stores nothing
  const data = Data.getInstance();
  const trackOrder = new Map<string, number>();
  tracks.forEach((track: any, index: number) => trackOrder.set(track.id, index + 1));
  await data.storeTracks(rowId, newSpotifyId, tracks, trackOrder, 'spotify', line.payment.locale || 'en');
  await prisma.playlist.update({ where: { id: rowId }, data: { numberOfTracks: tracks.length } });

  await prisma.paymentHasPlaylist.update({
    where: { id: line.id },
    data: {
      playlistId: rowId,
      eligableForPrinter: false,
      eligableForPrinterAt: null,
      userConfirmedPrinting: false,
      suggestionsPending: false,
    },
  });
  await prisma.payment.update({
    where: { id: line.payment.id },
    data: { userAgreedToPrinting: false, userAgreedToPrintingAt: null },
  });
  await data.clearPlaylistCache(newSpotifyId);

  const stored = await prisma.playlistHasTrack.count({ where: { playlistId: rowId } });
  return {
    applied: true,
    before,
    after: { ...after, row: { id: rowId, created: !existing }, storedTracks: stored },
    cards,
    next: `regenerate the order's cards: qrsong order cards ${before.orderId} --regenerate`,
  };
}
