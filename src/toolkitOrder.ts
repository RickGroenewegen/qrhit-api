import { existsSync } from 'fs';
import path from 'path';
import { color, white } from 'console-log-colors';
import PrismaInstance from './prisma';
import Logger from './logger';
import Data from './data';
import Order from './order';
import Generator from './generator';
import Utils from './utils';
import MusicServiceRegistry from './services/MusicServiceRegistry';
import { CartItem } from './interfaces/CartItem';
import { PRINTER_TYPE, PRINTER_TYPES, PrinterType } from './config/constants';

/**
 * Business orders made by the qrsong toolkit (admin bearer token), for the
 * printers we send files to ourselves (Schneiders, Tromp).
 *
 * Until now such an order was an ordinary checkout on Rick's own account:
 * a Mollie payment, the invoice and order mails, then by hand printer
 * Schneiders and a printer hold in the dashboard. This writes the order
 * directly, like the reseller API does (resellers.ts createOrder):
 *
 * - no Mollie payment, no invoice, no mail, no Pushover: status `paid`,
 *   totals 0, `marketingEmails` off, generation queued with skipMainMail;
 * - printerHold on from the first moment. The hourly send-to-printer pass
 *   does not look at printerType: without the hold a Schneiders order is
 *   placed at Print&Bind once its 36 hour timer runs out (orders 8194 and
 *   8237 were). The reason stays null, i.e. a hold placed by hand, which
 *   nothing clears automatically;
 * - Print&Bind and the reseller printer type are refused.
 *
 * What still mails: finishing the year check of the last unchecked track
 * finalizes the order with the "finalized" mail to the order's address, as
 * for every order. The toolkit puts the order on an address of ours.
 */

export interface ToolkitOrderInput {
  /** Account the order is booked on (must exist), normally Rick's. */
  email: string;
  /** Spotify playlist id. */
  playlistId: string;
  /** Refuse unless the playlist has exactly this many tracks on Spotify. */
  expectedTracks?: number;
  printerType?: string;
  /** Order template (pdf_<template>.ejs), e.g. a customer layout; null for the printer default. */
  template?: string | null;
  design?: Record<string, any>;
  /** Copies of the deck in this order (the boxes are ordered from the printer, not here). */
  amount?: number;
  /** Shown in the dashboard: who the order is for. */
  fullname?: string;
  companyName?: string;
  doubleSided?: boolean;
}

export interface ToolkitOrderResult {
  paymentId: string;
  orderId: string;
  paymentDbId: number;
  paymentHasPlaylistId: number;
  playlistDbId: number;
  playlistName: string;
  trackCount: number;
}

const PLAYLIST_ID = /^[A-Za-z0-9]{22}$/;
const TEMPLATE = /^[a-z0-9_]+$/;
const ALLOWED_PRINTERS: PrinterType[] = [PRINTER_TYPE.SCHNEIDERS, PRINTER_TYPE.TROMP];

/** Design columns the toolkit may set, with the defaults a checkout would store. */
const DESIGN_DEFAULTS: Record<string, any> = {
  qrColor: '#000000',
  qrBackgroundColor: '#ffffff',
  qrBackgroundType: 'none',
  hideCircle: true,
  qrLogo: null,
  qrLogoScale: 25,
  emoji: '',
  background: '',
  logo: '',
  selectedFont: 'Arial, sans-serif',
  selectedFontSize: '16px',
  backgroundFrontType: 'image',
  backgroundFrontColor: '#ffffff',
  useFrontGradient: false,
  gradientFrontColor: '#ffffff',
  gradientFrontDegrees: 180,
  gradientFrontPosition: 50,
  backgroundBackType: 'image',
  backgroundBack: '',
  backgroundBackColor: '#ffffff',
  fontColor: '#000000',
  useGradient: false,
  gradientBackgroundColor: '#ffffff',
  gradientDegrees: 180,
  gradientPosition: 50,
  frontOpacity: 100,
  backOpacity: 100,
};

export class ToolkitOrderError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** Only known design columns, with the checkout defaults for what is not given. Exported for the tests. */
export function designColumns(design: Record<string, any> = {}): Record<string, any> {
  const unknown = Object.keys(design).filter((k) => !(k in DESIGN_DEFAULTS));
  if (unknown.length) throw new ToolkitOrderError(`unknown design fields: ${unknown.join(', ')}`);
  const out: Record<string, any> = { ...DESIGN_DEFAULTS };
  for (const [k, v] of Object.entries(design)) if (v !== undefined) out[k] = v;
  for (const k of ['background', 'backgroundBack', 'logo']) {
    // Stored as a bare file name under public/background (or public/logo).
    if (out[k] && !/^[A-Za-z0-9_-]+\.(png|jpe?g|webp)$/.test(out[k])) {
      throw new ToolkitOrderError(`${k} must be an uploaded file name (POST /designer/upload/...), got "${out[k]}"`);
    }
  }
  for (const k of ['frontOpacity', 'backOpacity']) {
    if (!(Number.isInteger(out[k]) && out[k] >= 0 && out[k] <= 100)) throw new ToolkitOrderError(`${k} must be 0..100`);
  }
  if (!['none', 'square', 'circle'].includes(out.qrBackgroundType)) {
    throw new ToolkitOrderError('qrBackgroundType must be none, square or circle');
  }
  return out;
}

export function checkPrinter(printerType: string | undefined): PrinterType {
  const p = (printerType ?? PRINTER_TYPE.SCHNEIDERS) as PrinterType;
  if (!PRINTER_TYPES.includes(p)) throw new ToolkitOrderError(`unknown printerType "${printerType}"`);
  if (!ALLOWED_PRINTERS.includes(p)) {
    throw new ToolkitOrderError(`printerType must be one of ${ALLOWED_PRINTERS.join(', ')}: the toolkit only makes orders we send to the printer ourselves`);
  }
  return p;
}

export function checkTemplate(template: string | null | undefined, viewsDir: string): string | null {
  if (template === undefined || template === null || template === '') return null;
  if (!TEMPLATE.test(template) || !existsSync(path.join(viewsDir, `pdf_${template}.ejs`))) {
    throw new ToolkitOrderError(`no card template pdf_${template}.ejs`);
  }
  return template;
}

class ToolkitOrder {
  private static instance: ToolkitOrder;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private data = Data.getInstance();
  private order = Order.getInstance();
  private generator = Generator.getInstance();
  private utils = new Utils();
  private registry = MusicServiceRegistry.getInstance();

  public static getInstance(): ToolkitOrder {
    if (!ToolkitOrder.instance) ToolkitOrder.instance = new ToolkitOrder();
    return ToolkitOrder.instance;
  }

  private viewsDir(): string {
    return path.join(__dirname, 'views');
  }

  public async create(input: ToolkitOrderInput): Promise<ToolkitOrderResult> {
    const email = String(input.email ?? '').trim().toLowerCase();
    if (!email) throw new ToolkitOrderError('email is required');
    if (!PLAYLIST_ID.test(String(input.playlistId ?? ''))) throw new ToolkitOrderError('playlistId must be a Spotify playlist id');
    const printerType = checkPrinter(input.printerType);
    const template = checkTemplate(input.template, this.viewsDir());
    const design = designColumns(input.design);
    const amount = input.amount ?? 1;
    if (!(Number.isInteger(amount) && amount >= 1 && amount <= 50)) throw new ToolkitOrderError('amount must be 1..50');

    const user = await this.prisma.user.findFirst({ where: { email }, select: { id: true, email: true, displayName: true } });
    if (!user) throw new ToolkitOrderError(`no account with email ${email}`, 404);

    const url = `https://open.spotify.com/playlist/${input.playlistId}`;
    const playlistResult = (await this.registry.getPlaylistFromUrl(url)) as any;
    if (!playlistResult?.success || !playlistResult.data) {
      throw new ToolkitOrderError(playlistResult?.error || 'could not read the playlist', 502);
    }
    const playlistData = playlistResult.data;
    const trackCount: number = playlistData.trackCount;
    if (input.expectedTracks !== undefined && trackCount !== input.expectedTracks) {
      throw new ToolkitOrderError(`the playlist has ${trackCount} tracks, expected ${input.expectedTracks}`, 409);
    }

    const cartItem: CartItem = {
      type: 'physical',
      subType: 'none',
      playlistId: input.playlistId,
      playlistName: playlistData.name,
      numberOfTracks: trackCount,
      amount,
      price: 0,
      image: playlistData.imageUrl || '',
      productType: 'cards',
      serviceType: 'spotify',
    };
    const [playlistDbId] = await this.data.storePlaylists(user.id, [cartItem]);
    const orderType = await this.order.getOrderType(trackCount, false, 'cards', input.playlistId, 'none');

    const paymentId = `toolkit_${this.utils.generateRandomString(16)}`;
    const created = await this.prisma.payment.create({
      data: {
        paymentId,
        vibe: false,
        user: { connect: { id: user.id } },
        totalPrice: 0,
        totalPriceWithoutTax: 0,
        status: 'paid',
        locale: 'nl',
        taxRate: 0,
        taxRateShipping: 0,
        productPriceWithoutTax: 0,
        shippingPriceWithoutTax: 0,
        productVATPrice: 0,
        shippingVATPrice: 0,
        totalVATPrice: 0,
        clientIp: '127.0.0.1',
        test: false,
        profit: 0,
        printApiPrice: 0,
        discount: 0,
        fullname: input.fullname?.trim() || user.displayName || email,
        email: user.email,
        companyName: input.companyName?.trim() || '',
        isBusinessOrder: !!input.companyName,
        marketingEmails: false,
        printerHold: true,
        PaymentHasPlaylist: {
          create: [
            {
              playlistId: playlistDbId,
              orderTypeId: orderType.id,
              amount,
              numberOfTracks: trackCount,
              type: 'physical',
              subType: 'none',
              doubleSided: input.doubleSided ?? true,
              eco: false,
              price: 0,
              priceWithoutVAT: 0,
              priceVAT: 0,
              printApiPrice: 0,
              printerType,
              template,
              gamesEnabled: false,
              gamesPrice: 0,
              ...design,
            },
          ],
        },
      },
      include: { PaymentHasPlaylist: { select: { id: true } } },
    });

    const orderId = (100000000 + created.id).toString();
    await this.prisma.payment.update({ where: { id: created.id }, data: { orderId } });

    // skipMainMail: no invoice, no order mail, no Pushover. Finalizes (PDFs)
    // only when every track is year-checked.
    this.generator.queueGenerate(paymentId, '127.0.0.1', input.playlistId, false, true, false);

    this.logger.log(
      color.green.bold(
        `[${white.bold('Toolkit')}] Order ${white.bold(orderId)} (${white.bold(paymentId)}): ${white.bold(
          playlistData.name
        )}, ${white.bold(trackCount)} tracks, printer ${white.bold(printerType)}, on printer hold`
      )
    );

    return {
      paymentId,
      orderId,
      paymentDbId: created.id,
      paymentHasPlaylistId: created.PaymentHasPlaylist[0].id,
      playlistDbId,
      playlistName: playlistData.name,
      trackCount,
    };
  }

  /** The order line of a toolkit order (or any order), by payments.paymentId. */
  private async line(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { paymentId },
      include: { PaymentHasPlaylist: { include: { playlist: true } } },
    });
    if (!payment) throw new ToolkitOrderError('order not found', 404);
    if (payment.PaymentHasPlaylist.length !== 1) {
      throw new ToolkitOrderError(`order has ${payment.PaymentHasPlaylist.length} lines; the toolkit handles one`, 409);
    }
    return { payment, php: payment.PaymentHasPlaylist[0] };
  }

  /** Changes the design / template of an order line. The caller regenerates. */
  public async updateDesign(
    paymentId: string,
    input: { design?: Record<string, any>; template?: string | null; printerType?: string }
  ): Promise<void> {
    const { payment, php } = await this.line(paymentId);
    if (payment.sentToPrinter) throw new ToolkitOrderError('order was already sent to a printer', 409);
    const data: Record<string, any> = {};
    if (input.design) {
      const unknown = Object.keys(input.design).filter((k) => !(k in DESIGN_DEFAULTS));
      if (unknown.length) throw new ToolkitOrderError(`unknown design fields: ${unknown.join(', ')}`);
      // Validate the merged result, store only what was sent.
      designColumns({ ...this.pickDesign(php), ...input.design });
      Object.assign(data, input.design);
    }
    if (input.template !== undefined) data.template = checkTemplate(input.template, this.viewsDir());
    if (input.printerType !== undefined) data.printerType = checkPrinter(input.printerType);
    if (Object.keys(data).length === 0) throw new ToolkitOrderError('nothing to change');
    await this.prisma.paymentHasPlaylist.update({ where: { id: php.id }, data });
  }

  private pickDesign(php: any): Record<string, any> {
    return Object.fromEntries(Object.keys(DESIGN_DEFAULTS).map((k) => [k, php[k]]));
  }

  /** Everything the toolkit checks before a print file goes out. */
  public async status(paymentId: string) {
    const { payment, php } = await this.line(paymentId);
    const tracks: any[] = await this.data.getTracks(php.playlistId, payment.userId, php.id);
    const ids = tracks.map((t) => t.id);
    const checks = ids.length
      ? await this.prisma.track.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            manuallyChecked: true,
            spotifyYear: true,
            discogsYear: true,
            musicBrainzYear: true,
            aiYear: true,
            openPerplexYear: true,
            yearSource: true,
            certainty: true,
            isrc: true,
          },
        })
      : [];
    const byId = new Map(checks.map((c) => [c.id, c]));
    const apiUri = process.env['API_URI'];
    return {
      paymentId: payment.paymentId,
      orderId: payment.orderId,
      status: payment.status,
      email: payment.email,
      fullname: payment.fullname,
      companyName: payment.companyName,
      printerHold: payment.printerHold,
      sentToPrinter: payment.sentToPrinter,
      finalized: payment.finalized,
      finalizedAt: payment.finalizedAt,
      processed: payment.processedFirstTime,
      line: {
        id: php.id,
        playlistId: php.playlist.playlistId,
        playlistDbId: php.playlistId,
        playlistName: php.playlist.name,
        numberOfTracks: php.numberOfTracks,
        amount: php.amount,
        printerType: php.printerType,
        template: php.template,
        doubleSided: php.doubleSided,
        design: this.pickDesign(php),
        backgroundUrl: php.background ? `${apiUri}/public/background/${php.background}` : null,
        backgroundBackUrl: php.backgroundBack ? `${apiUri}/public/background/${php.backgroundBack}` : null,
        printerPdf: php.filename ? { file: php.filename, url: `${apiUri}/public/pdf/${php.filename}` } : null,
        digitalPdf: php.filenameDigital ? { file: php.filenameDigital, url: `${apiUri}/public/pdf/${php.filenameDigital}` } : null,
      },
      tracks: tracks.map((t, index) => {
        const c = byId.get(t.id);
        return {
          card: index + 1,
          id: t.id,
          trackId: t.trackId,
          artist: t.artist,
          name: t.name,
          year: t.year,
          checked: !!c?.manuallyChecked,
          years: c
            ? {
                spotify: c.spotifyYear,
                discogs: c.discogsYear,
                musicBrainz: c.musicBrainzYear,
                ai: c.aiYear,
                perplexity: c.openPerplexYear,
                source: c.yearSource,
                certainty: c.certainty,
              }
            : null,
          isrc: c?.isrc ?? null,
          extraArtist: t.extraArtistAttribute ?? null,
          extraName: t.extraNameAttribute ?? null,
        };
      }),
    };
  }
}

export default ToolkitOrder;
