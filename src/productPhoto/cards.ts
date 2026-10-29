import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { color, white } from 'console-log-colors';
import Logger from '../logger';
import Cache from '../cache';
import PDF from '../pdf';
import Qr from '../qr';
import { CardDesign } from '../cardDesigns';
import { safeTrackFileId } from '../cardPreview';
import { renderPdfPages } from '../pdfRaster';
import { applyQrLogo, qrLogoOptionsFor } from '../qr-logo';
import { signedRenderQuery } from '../renderSignature';

/**
 * The cards a product photo shows, front and back, drawn exactly as the
 * printer gets them: the printer template (views/pdf_printer.ejs, 60 mm)
 * through the PDF Lambda, then PDFium. Unlike CardPreviews this needs no
 * order line, so a featured playlist nobody ordered yet gets its photo too.
 *
 * What to draw travels as a spec in Redis under a random token, for the
 * minutes the render takes: GET /qr/pdf-showcase/:token (signed, opened by
 * the Lambda only) reads it back. Each card's QR code is made here, locally,
 * from the link the spec gives, so nothing calls /qrlink (AbuseGuard).
 */

/** One card: its back as printed, and the link its QR code opens. */
export interface ShowcaseCard {
  // the QR code's file name; a track id
  trackId: string;
  artist: string;
  name: string;
  year: number;
  qrUrl: string;
  extraArtistAttribute?: string | null;
  extraNameAttribute?: string | null;
  // which design draws it: 0 (or none) the spec's design, k its extraDesigns[k - 1]
  design?: number;
}

export interface ShowcaseSpec {
  design: CardDesign;
  // the designs the cards take turns with, as an order line's designs 2..N
  extraDesigns?: CardDesign[];
  // drawn as an eco deck prints
  eco?: boolean;
  cards: ShowcaseCard[];
}

/** One card as square PNGs, front (the QR side) and back (the song). */
export interface ShowcaseFaces {
  front: Buffer;
  back: Buffer;
}

const CARD_MM = 60;
const POINTS_PER_MM = 72 / 25.4;
// the Lambda opens the page within seconds; this only bounds a stuck render
const SPEC_SECONDS = 15 * 60;
const MAX_CARDS = 12;
const TOKEN = /^[0-9a-f]{24}$/;

const specKey = (token: string) => `product-photo-cards:${token}`;
const qrDir = (token: string) => path.join(process.env['PUBLIC_DIR'] as string, 'qr', 'showcase', token);

const logger = new Logger();

/**
 * Renders every card of the spec at `px` pixels square, in spec order. Throws
 * when the Lambda fails; the caller decides what that means.
 */
export async function renderShowcaseCards(spec: ShowcaseSpec, px: number = 1200): Promise<ShowcaseFaces[]> {
  if (!spec.cards.length || spec.cards.length > MAX_CARDS) {
    throw new Error(`a showcase has 1 to ${MAX_CARDS} cards, not ${spec.cards.length}`);
  }
  const designs = [spec.design, ...(spec.extraDesigns ?? [])];
  // one QR code file per card: a song can show twice, in two designs' QR colours
  const cards = spec.cards.map((card, index) => {
    const id = safeTrackFileId(card.trackId);
    return { ...card, trackId: id && `${index}-${id}` };
  });
  if (cards.some((card) => !card.trackId)) throw new Error('a showcase card has no track id');
  if (cards.some((card) => !designs[card.design ?? 0])) throw new Error('a showcase card has no such design');

  const token = crypto.randomBytes(12).toString('hex');
  const dir = qrDir(token);
  const cache = Cache.getInstance();
  try {
    await fs.mkdir(dir, { recursive: true });
    const logos = designs.map((design) => qrLogoOptionsFor(design, logger));
    for (const card of cards) {
      const file = path.join(dir, `${card.trackId}.png`);
      await new Qr().generateQR(card.qrUrl, file, designs[card.design ?? 0].qrColor);
      const logo = logos[card.design ?? 0];
      if (logo) await applyQrLogo(file, card.qrUrl, logo, logger);
    }
    await cache.set(specKey(token), JSON.stringify({ ...spec, cards }), SPEC_SECONDS);

    const url = `${process.env['API_URI']}/qr/pdf-showcase/${token}?${signedRenderQuery('card-showcase', { token }, {})}`;
    const pdf = await new PDF().renderUrlToPdfBuffer(url, {
      width: CARD_MM,
      height: CARD_MM,
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
      pageRanges: `1-${cards.length * 2}`,
    });
    const numbers = cards.flatMap((_, index) => [index * 2 + 1, index * 2 + 2]);
    const pages = await renderPdfPages(pdf, numbers, px / (CARD_MM * POINTS_PER_MM));
    // PDFium sizes the bitmap from the page's exact size, a pixel either way
    const squared = await Promise.all(
      pages.map((page) => sharp(page.png).resize(px, px, { fit: 'fill' }).png().toBuffer())
    );
    logger.log(color.green.bold(`Product photo: ${white.bold(cards.length)} cards rendered at ${white.bold(px)} px`));
    return cards.map((_, index) => ({ front: squared[index * 2], back: squared[index * 2 + 1] }));
  } finally {
    await cache.del(specKey(token)).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** What GET /qr/pdf-showcase/:token hands to the card pages, or null. */
export async function showcaseView(token: string) {
  if (!TOKEN.test(token)) return null;
  const stored = await Cache.getInstance().get(specKey(token), false);
  if (!stored) return null;
  const spec = JSON.parse(stored) as ShowcaseSpec;
  return {
    payment: null,
    user: null,
    playlist: null,
    // the design stands in for an order line: no how-to card, no batch number
    php: { ...spec.design, paymentHasPlaylistId: 0, addHowToCard: false, orderTemplate: null },
    extraDesigns: spec.extraDesigns ?? [],
    cardDesignIndexes: spec.cards.map((card) => card.design ?? 0),
    eco: spec.eco === true,
    tracks: spec.cards.map((card) => ({
      trackId: card.trackId,
      artist: card.artist,
      name: card.name,
      year: card.year,
      extraArtistAttribute: card.extraArtistAttribute ?? null,
      extraNameAttribute: card.extraNameAttribute ?? null,
    })),
    requestedTemplate: 'printer',
    subdir: `showcase/${token}`,
    batchNumber: '',
  };
}
