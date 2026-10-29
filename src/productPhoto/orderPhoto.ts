import PrismaInstance from '../prisma';
import { CARD_DESIGN_SELECT, sanitizeCardDesign } from '../cardDesigns';
import { forcedPrinterTemplate } from '../pdf';
import { safeTrackFileId } from '../cardPreview';
import MusicServiceRegistry from '../services/MusicServiceRegistry';
import { ProviderTrackData } from '../interfaces/IMusicProvider';
import { renderShowcaseCards, ShowcaseCard } from './cards';
import { cardOf, composePhoto, FacePictures, loadScene } from './compose';
import { CARD_PX, qrUrl } from './photos';
import { MAX_TEXT, PHOTO_SONGS, photoCandidates, pickByRule } from './songs';

/**
 * The product photo of an order line: the photo of the customer's own cards
 * that the summary page shows (made in the browser there, qrhit
 * PhotoComposerService), made here for the help mail after an abandoned
 * payment (src/abandonedPayments.ts). The cards are drawn like a featured
 * playlist's (cards.ts), in the line's designs taking turns as on the summary
 * page, with songs from its playlist picked by the same rule (songs.ts
 * pickByRule), and put into scene-1 (compose.ts).
 */

/** A song for the photo, from the stored playlist or from the music service's list. */
export interface OrderSong {
  // the QR code's file name
  trackId: string;
  artist: string;
  name: string;
  year: number;
  link: string;
  extraArtistAttribute: string | null;
  extraNameAttribute: string | null;
}

/**
 * Which design each of the photo's cards shows, as on the summary page
 * (qrhit SCENE_CARD_DESIGNS): its three fronts (cards 0, 3, 4) and its three
 * backs (cards 0, 1, 2) each show the first three designs. With two designs
 * they take turns, with one every card has it.
 */
const PHOTO_CARD_DESIGNS = [0, 1, 2, 1, 2];
// the code on a card whose song has no link (it only has to look like one)
const QR_TEXT = 'https://www.qrsong.io/';
// how far down the music service's list a playlist with no stored songs is looked at
const LISTED_SONGS = 200;

const prisma = () => PrismaInstance.getInstance();

/** The photo's cards: the songs in turn (repeated when there are fewer), each in its design. */
export function photoCards(songs: OrderSong[], designCount: number): ShowcaseCard[] {
  return Array.from({ length: PHOTO_SONGS }, (_, index) => {
    const song = songs[index % songs.length];
    return {
      trackId: song.trackId,
      artist: song.artist,
      name: song.name,
      year: song.year,
      qrUrl: song.link ? qrUrl(song.link) : QR_TEXT,
      extraArtistAttribute: song.extraArtistAttribute,
      extraNameAttribute: song.extraNameAttribute,
      design: PHOTO_CARD_DESIGNS[index] % designCount,
    };
  });
}

/**
 * The photo of one order line as a transparent PNG (16:10, outputs.ts makes
 * it a picture), or null when it has no cards to show: a gift card, a
 * company's own card template (its cards look nothing like the printer
 * template's), or not one song with a year and a short title. Throws when
 * the cards cannot be drawn.
 */
export async function orderLinePhoto(paymentHasPlaylistId: number): Promise<Buffer | null> {
  const line = await prisma().paymentHasPlaylist.findUnique({
    where: { id: paymentHasPlaylistId },
    select: {
      ...CARD_DESIGN_SELECT,
      eco: true,
      template: true,
      allowDuplicates: true,
      extraDesigns: { select: CARD_DESIGN_SELECT, orderBy: { position: 'asc' } },
      playlist: { select: { id: true, playlistId: true, serviceType: true, type: true } },
    },
  });
  if (!line || line.playlist.type === 'giftcard' || forcedPrinterTemplate(line.template)) return null;
  const songs = await orderSongs(line.playlist, line.allowDuplicates);
  if (!songs.length) return null;

  const designs = [line, ...line.extraDesigns].map((design) => sanitizeCardDesign(design));
  const faces = await renderShowcaseCards(
    {
      design: designs[0],
      extraDesigns: designs.slice(1),
      eco: line.eco,
      cards: photoCards(songs, designs.length),
    },
    CARD_PX
  );
  const scene = await loadScene();
  const pictures: FacePictures = {};
  for (const face of scene.manifest.faces) {
    if (face.side !== 'page') pictures[face.role] = faces[cardOf(face)][face.side];
  }
  return composePhoto(pictures, scene);
}

/** Up to PHOTO_SONGS songs: the stored playlist's, else the music service's list's. */
async function orderSongs(
  playlist: { id: number; playlistId: string; serviceType: string | null },
  allowDuplicates: boolean
): Promise<OrderSong[]> {
  const stored = await photoCandidates(playlist.id);
  const candidates: OrderSong[] = stored.length
    ? stored.map((track) => ({ ...track, trackId: String(track.id) }))
    : await listedSongs(playlist, allowDuplicates);
  return pickByRule(candidates);
}

/**
 * The songs of a playlist nothing was stored for yet, from the music
 * service's list (cached: the order flow fetched it), with our year where we
 * know the track and its release year otherwise.
 */
async function listedSongs(
  playlist: { playlistId: string; serviceType: string | null },
  allowDuplicates: boolean
): Promise<OrderSong[]> {
  const provider = MusicServiceRegistry.getInstance().getProviderByString(playlist.serviceType || 'spotify');
  const result = provider
    ? await provider.getTracks(playlist.playlistId, { cache: true, allowDuplicates }).catch(() => null)
    : null;
  const listed: ProviderTrackData[] = ((result?.success && result.data?.tracks) || [])
    .filter((track: ProviderTrackData) => safeTrackFileId(track.id) && track.name)
    .slice(0, LISTED_SONGS);
  if (!listed.length) return [];

  const ours = await prisma().track.findMany({
    where: { trackId: { in: listed.map((track) => track.id) }, year: { gt: 0 } },
    select: { trackId: true, name: true, artist: true, year: true },
  });
  const byId = new Map(ours.map((track) => [track.trackId, track]));
  return listed
    .map((track) => {
      const own = byId.get(track.id);
      const released = parseInt((track.releaseDate || '').slice(0, 4), 10);
      return {
        trackId: track.id,
        artist: (own?.artist || track.artist || '').trim(),
        name: (own?.name || track.name || '').trim(),
        year: own?.year || (released > 1000 ? released : 0),
        link: track.serviceLink || '',
        extraArtistAttribute: null,
        extraNameAttribute: null,
      };
    })
    .filter(
      (song) =>
        song.year > 0 && song.artist && song.name && song.artist.length <= MAX_TEXT && song.name.length <= MAX_TEXT
    );
}
