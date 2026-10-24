import fs from 'fs/promises';
import path from 'path';
import { randomBytes, randomInt } from 'crypto';
import { Prisma } from '@prisma/client';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import Cache from './cache';
import AppTheme from './apptheme';
import AppDesign, { newCustomerSlug, scopeKeyFor } from './appDesign';
import CardPreviews from './cardPreview';
import PDF from './pdf';
import Mail from './mail';
import Translation from './translation';
import { signedRenderQuery } from './renderSignature';
import { pickCardDesign } from './cardDesigns';
import { qrSvg } from './defaultPlaylists';
import { SITE_LOCALES } from './data/shared/shared-data.generated';

/**
 * Giving a set as a gift. The buyer makes a voucher in My account for one or
 * more sets (order lines) of one paid order; the voucher PDF carries a code,
 * and whoever redeems it at /redeem/<code> gets those sets in their own
 * account: payment_has_playlist.ownerUserId becomes theirs (src/lineOwner.ts
 * makes every check follow it), the app design the cards show goes along and
 * stays on them (app_designs.keepActive), and the order, its invoice and the
 * App Designer upgrade stay with the buyer.
 *
 * Nothing reaches the recipient before they redeem: QRSong! never mails them
 * and the redeem page shows no price, order number or invoice.
 */

// ─── Codes ──────────────────────────────────────────────────────────────

/** No 0/O, 1/I/L: a code is read off paper and typed in. */
export const GIFT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const GIFT_CODE_LENGTH = 12;
const GIFT_PREFIX = 'GIFT';

export function generateGiftCode(): string {
  let code = '';
  for (let i = 0; i < GIFT_CODE_LENGTH; i++) {
    code += GIFT_CODE_ALPHABET[randomInt(GIFT_CODE_ALPHABET.length)];
  }
  return code;
}

/** As printed: GIFT-ABCD-EFGH-JKMN. */
export function formatGiftCode(code: string): string {
  return [GIFT_PREFIX, code.slice(0, 4), code.slice(4, 8), code.slice(8, 12)].join('-');
}

function cleanCode(input: unknown): string {
  return typeof input === 'string' ? input.toUpperCase().replace(/[^0-9A-Z]/g, '') : '';
}

/**
 * The stored code for what someone typed or scanned (with or without the
 * GIFT- prefix, dashes and spaces, any case), or null when it cannot be one.
 */
export function normalizeGiftCode(input: unknown): string | null {
  let code = cleanCode(input);
  if (code.length === GIFT_CODE_LENGTH + GIFT_PREFIX.length && code.startsWith(GIFT_PREFIX)) {
    code = code.slice(GIFT_PREFIX.length);
  }
  if (code.length !== GIFT_CODE_LENGTH) return null;
  for (const char of code) {
    if (!GIFT_CODE_ALPHABET.includes(char)) return null;
  }
  return code;
}

/**
 * True for the shape of a gift card or discount code (XXXX-XXXX-XXXX-XXXX,
 * src/discount.ts), so /redeem can say where that one goes instead.
 */
export function looksLikeGiftCardCode(input: unknown): boolean {
  const code = cleanCode(input);
  return code.length === 16 && normalizeGiftCode(input) === null;
}

// ─── Which sets can be given ────────────────────────────────────────────

export type GiftBlockReason =
  | 'notPaid'
  | 'refunded'
  | 'giftcard'
  | 'company'
  | 'adminTheme'
  | 'blocked'
  | 'changedHands'
  | 'correctionsPending'
  | 'pdfNotReady'
  | 'notPrinted';

export interface GiftEligibilityLine {
  type: string;
  filenameDigital: string | null;
  theme: string | null;
  blocked: boolean;
  suggestionsPending: boolean;
  ownerUserId: number | null;
  playlist: { type: string | null };
  payment: {
    status: string;
    sentToPrinter: boolean;
    refundedAt: Date | null;
    /** The order belongs to a company list (B2B, handled by us) */
    companyList: boolean;
  };
}

/**
 * Whether a set can go on a voucher, and be redeemed, now. Digital cards once
 * their PDF exists; printed cards (and sheets) once the order went to the
 * printer, because until then the print job, corrections and the deadline
 * mails are the whole order's and go to the buyer. Never: gift cards,
 * company orders, a line with an admin-chosen app theme, a refunded or
 * blocked line, one whose corrections are being processed, or a set that
 * changed hands already (no re-gifting: the voucher is the whole history).
 */
export function giftEligibility(
  line: GiftEligibilityLine
): { ok: true } | { ok: false; reason: GiftBlockReason } {
  const no = (reason: GiftBlockReason) => ({ ok: false as const, reason });
  if (line.payment.status !== 'paid') return no('notPaid');
  if (line.payment.refundedAt) return no('refunded');
  if (line.playlist.type === 'giftcard') return no('giftcard');
  if (line.payment.companyList) return no('company');
  if (line.theme) return no('adminTheme');
  if (line.blocked) return no('blocked');
  if (line.ownerUserId !== null) return no('changedHands');
  if (line.suggestionsPending) return no('correctionsPending');
  if (line.type === 'digital') {
    return line.filenameDigital ? { ok: true } : no('pdfNotReady');
  }
  return line.payment.sentToPrinter ? { ok: true } : no('notPrinted');
}

// ─── What happens to the app design ─────────────────────────────────────

/** What the redeem did with a line's app design (gift_voucher_lines.appDesignCarried). */
export type AppDesignCarry = 'none' | 'moved' | 'copied' | 'draft';

export interface AppDesignTransferInput {
  /** The line's own app_designs row (scope p<id>), if any */
  override: { mode: string; hasTheme: boolean } | null;
  /** The giver's account default has a design */
  giverDefaultHasTheme: boolean;
  /** The giver owns App Designer (AppDesign.isEntitled) */
  giverEntitled: boolean;
}

export interface AppDesignTransferPlan {
  carry: AppDesignCarry;
  /** Served to the recipient whatever they own (app_designs.keepActive) */
  keepActive: boolean;
  /** Mode the line's row gets; null keeps it */
  mode: 'custom' | 'default' | null;
}

/**
 * What the recipient's cards show after the redeem: exactly what they showed
 * for the giver (src/apptheme.ts resolveLineTheme), because the cards were
 * printed for it. App Designer itself stays with the giver.
 *  - The line's own design (custom): that row moves to the recipient. Same
 *    slug, so nothing changes in the app.
 *  - The giver's default: copied into a row of the line's own with a new
 *    slug, so the giver's later edits never reach the recipient's cards.
 *  - The plain look: a draft row moves along unserved; one the giver made
 *    without ever owning App Designer falls back to `default`, so a
 *    recipient with App Designer sees their own design instead of an unpaid
 *    draft.
 * A design is never carried when the giver did not own App Designer: the
 * cards never showed it, and gifting must not unlock it.
 */
export function planAppDesignTransfer(input: AppDesignTransferInput): AppDesignTransferPlan {
  const { override, giverEntitled } = input;
  if (giverEntitled && override?.mode === 'custom' && override.hasTheme) {
    return { carry: 'moved', keepActive: true, mode: null };
  }
  if (giverEntitled && (!override || override.mode === 'default') && input.giverDefaultHasTheme) {
    return { carry: 'copied', keepActive: true, mode: 'custom' };
  }
  if (override) {
    return {
      carry: 'draft',
      keepActive: false,
      mode: !giverEntitled && override.mode === 'custom' ? 'default' : null,
    };
  }
  return { carry: 'none', keepActive: false, mode: null };
}

// ─── Input ──────────────────────────────────────────────────────────────

export const GIFT_NAME_MAX = 60;
// what fits on the A5 voucher above the redeem block (src/views/gift_voucher.ejs)
export const GIFT_MESSAGE_MAX = 280;

export class GiftError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export interface VoucherTextInput {
  recipientName: string;
  fromName: string;
  message: string | null;
  locale: string;
}

/** The voucher's texts from a request body; throws a GiftError (400). */
export function parseVoucherText(body: any): VoucherTextInput {
  const text = (value: unknown, max: number) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  const recipientName = text(body?.recipientName, GIFT_NAME_MAX);
  const fromName = text(body?.fromName, GIFT_NAME_MAX);
  if (!recipientName) throw new GiftError(400, 'recipientNameRequired');
  if (!fromName) throw new GiftError(400, 'fromNameRequired');
  const message =
    typeof body?.message === 'string'
      ? body.message.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, GIFT_MESSAGE_MAX)
      : '';
  const locales = SITE_LOCALES.map((l) => l.code as string);
  const locale = locales.includes(body?.locale) ? body.locale : 'en';
  return { recipientName, fromName, message: message || null, locale };
}

// ─── The service ────────────────────────────────────────────────────────

export interface VoucherSummary {
  id: number;
  code: string;
  status: string;
  recipientName: string;
  fromName: string;
  message: string | null;
  locale: string;
  createdAt: Date;
  claimedAt: Date | null;
  paymentHasPlaylistIds: number[];
}

/** One set as the redeem page shows it: what it is, never what it cost. */
export interface GiftSetView {
  playlistName: string;
  image: string | null;
  numberOfTracks: number;
  type: 'digital' | 'physical' | 'sheets';
  gamesEnabled: boolean;
  appDesign: boolean;
  design: Record<string, unknown>;
  eco: boolean;
  doubleSided: boolean;
}

export type RedeemInfo =
  | { status: 'open'; recipientName: string; fromName: string; message: string | null; locale: string; sets: GiftSetView[] }
  | { status: 'redeemed' | 'cancelled' | 'unknown' | 'giftCardCode' };

const LINE_SELECT = {
  id: true,
  type: true,
  subType: true,
  filenameDigital: true,
  theme: true,
  blocked: true,
  suggestionsPending: true,
  ownerUserId: true,
  numberOfTracks: true,
  gamesEnabled: true,
  eco: true,
  doubleSided: true,
  playlistId: true,
  playlist: { select: { name: true, image: true, type: true } },
  payment: {
    select: {
      id: true,
      paymentId: true,
      userId: true,
      status: true,
      sentToPrinter: true,
      refundedAt: true,
      locale: true,
      _count: { select: { CompanyList: true } },
    },
  },
} satisfies Prisma.PaymentHasPlaylistSelect;

type GiftLine = Prisma.PaymentHasPlaylistGetPayload<{ select: typeof LINE_SELECT }>;

function eligibilityOf(line: GiftLine) {
  return giftEligibility({
    ...line,
    payment: { ...line.payment, companyList: line.payment._count.CompanyList > 0 },
  });
}

function lineType(line: { type: string; subType: string | null }): 'digital' | 'physical' | 'sheets' {
  if (line.type === 'digital') return 'digital';
  return line.subType === 'sheets' ? 'sheets' : 'physical';
}

function summary(voucher: any): VoucherSummary {
  return {
    id: voucher.id,
    code: formatGiftCode(voucher.code),
    status: voucher.status,
    recipientName: voucher.recipientName,
    fromName: voucher.giverName,
    message: voucher.message,
    locale: voucher.locale,
    createdAt: voucher.createdAt,
    claimedAt: voucher.claimedAt,
    paymentHasPlaylistIds: (voucher.lines || []).map((l: any) => l.paymentHasPlaylistId),
  };
}

const VOUCHER_DIR = 'gift-vouchers';
// a redeem-page lookup per IP: generous for a family typing a code, useless
// for guessing one (31^12 codes)
const LOOKUPS_PER_HOUR = 30;
// how long the voucher PDF waits for a printed line's card picture
const CARD_PICTURE_WAIT_MS = 20_000;

class GiftVouchers {
  private static instance: GiftVouchers;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private cache = Cache.getInstance();
  private translation = new Translation();

  public static getInstance(): GiftVouchers {
    if (!GiftVouchers.instance) GiftVouchers.instance = new GiftVouchers();
    return GiftVouchers.instance;
  }

  private apiUri(): string {
    return process.env['API_URI'] || 'http://localhost:3004';
  }

  private voucherDir(): string {
    return path.join(process.env['PRIVATE_DIR'] as string, VOUCHER_DIR);
  }

  // ── The giver's side ──

  /**
   * Per line of these orders: whether it can be given (and why not), the
   * open voucher it is on and, once redeemed, to whom. For My account.
   */
  public async giverState(paymentDbIds: number[]): Promise<
    Map<
      number,
      {
        giftable: boolean;
        giftBlockedReason: GiftBlockReason | null;
        voucher: VoucherSummary | null;
        given: { recipientName: string; claimedAt: Date | null } | null;
      }
    >
  > {
    const state = new Map();
    if (paymentDbIds.length === 0) return state;
    const [lines, vouchers] = await Promise.all([
      this.prisma.paymentHasPlaylist.findMany({
        where: { paymentId: { in: paymentDbIds } },
        select: LINE_SELECT,
      }),
      this.prisma.giftVoucher.findMany({
        where: { paymentId: { in: paymentDbIds }, status: { in: ['open', 'claimed'] } },
        include: { lines: { select: { paymentHasPlaylistId: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    for (const line of lines) {
      const eligibility = eligibilityOf(line);
      const open = vouchers.find(
        (v) => v.status === 'open' && v.lines.some((l) => l.paymentHasPlaylistId === line.id)
      );
      const claimed =
        line.ownerUserId !== null
          ? vouchers.find(
              (v) =>
                v.status === 'claimed' &&
                v.recipientUserId === line.ownerUserId &&
                v.lines.some((l) => l.paymentHasPlaylistId === line.id)
            )
          : undefined;
      state.set(line.id, {
        giftable: eligibility.ok && !open,
        giftBlockedReason: eligibility.ok ? null : eligibility.reason,
        voucher: open ? summary(open) : null,
        given:
          line.ownerUserId !== null
            ? { recipientName: claimed?.recipientName ?? '', claimedAt: claimed?.claimedAt ?? null }
            : null,
      });
    }
    return state;
  }

  /** Make a voucher for `paymentHasPlaylistIds` of the giver's order `paymentId` (Mollie id). */
  public async createVoucher(
    giverUserId: number,
    paymentId: string,
    paymentHasPlaylistIds: unknown,
    text: VoucherTextInput
  ): Promise<VoucherSummary> {
    const ids = Array.isArray(paymentHasPlaylistIds)
      ? [...new Set(paymentHasPlaylistIds.map((id) => Number(id)).filter((id) => Number.isInteger(id)))]
      : [];
    if (ids.length === 0) throw new GiftError(400, 'noSets');

    const lines = await this.prisma.paymentHasPlaylist.findMany({
      where: { id: { in: ids } },
      select: LINE_SELECT,
    });
    if (
      lines.length !== ids.length ||
      lines.some((line) => line.payment.paymentId !== paymentId || line.payment.userId !== giverUserId)
    ) {
      throw new GiftError(404, 'orderNotFound');
    }
    for (const line of lines) {
      const eligibility = eligibilityOf(line);
      if (!eligibility.ok) throw new GiftError(409, eligibility.reason);
    }

    let voucher: any = null;
    for (let attempt = 0; !voucher; attempt++) {
      try {
        voucher = await this.prisma.giftVoucher.create({
          data: {
            code: generateGiftCode(),
            paymentId: lines[0].payment.id,
            giverUserId,
            giverName: text.fromName,
            recipientName: text.recipientName,
            message: text.message,
            locale: text.locale,
            lines: {
              create: lines.map((line) => ({ paymentHasPlaylistId: line.id, openLineId: line.id })),
            },
          },
          include: { lines: { select: { paymentHasPlaylistId: true } } },
        });
      } catch (error: any) {
        const target = String(error?.meta?.target || '');
        if (error?.code === 'P2002' && target.includes('openLineId')) {
          throw new GiftError(409, 'alreadyOnVoucher');
        }
        if (error?.code !== 'P2002' || attempt >= 3) throw error;
      }
    }

    this.logger.log(
      color.blue.bold(
        `Gift voucher ${white.bold(String(voucher.id))} made by user ${white.bold(
          String(giverUserId)
        )} for ${white.bold(String(ids.length))} set(s)`
      )
    );
    await this.renderPdf(voucher.id).catch((error) =>
      this.logger.log(color.yellow.bold(`Gift voucher PDF postponed: ${white.bold(error.message)}`))
    );
    return summary(voucher);
  }

  /** Change the texts of an open voucher; its PDF is made again. */
  public async updateVoucher(
    giverUserId: number,
    voucherId: number,
    text: VoucherTextInput
  ): Promise<VoucherSummary> {
    const voucher = await this.prisma.giftVoucher.findFirst({
      where: { id: voucherId, giverUserId },
    });
    if (!voucher) throw new GiftError(404, 'voucherNotFound');
    if (voucher.status !== 'open') throw new GiftError(409, 'voucherNotOpen');
    const updated = await this.prisma.giftVoucher.update({
      where: { id: voucherId },
      data: {
        giverName: text.fromName,
        recipientName: text.recipientName,
        message: text.message,
        locale: text.locale,
      },
      include: { lines: { select: { paymentHasPlaylistId: true } } },
    });
    await this.renderPdf(voucherId).catch((error) =>
      this.logger.log(color.yellow.bold(`Gift voucher PDF postponed: ${white.bold(error.message)}`))
    );
    return summary(updated);
  }

  /**
   * Cancel an open voucher: the code stops working and the sets stay. Under
   * the same row lock as the redeem, so the two never both happen. `giverUserId`
   * null is an admin.
   */
  public async cancelVoucher(voucherId: number, giverUserId: number | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows: any[] = await tx.$queryRaw`
        SELECT id, status, giverUserId FROM gift_vouchers WHERE id = ${voucherId} FOR UPDATE`;
      const voucher = rows[0];
      if (!voucher || (giverUserId !== null && Number(voucher.giverUserId) !== giverUserId)) {
        throw new GiftError(404, 'voucherNotFound');
      }
      if (voucher.status === 'cancelled') return;
      if (voucher.status !== 'open') throw new GiftError(409, 'alreadyRedeemed');
      await tx.giftVoucherLine.updateMany({
        where: { giftVoucherId: voucherId },
        data: { openLineId: null },
      });
      await tx.giftVoucher.update({
        where: { id: voucherId },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
    });
    this.logger.log(color.blue.bold(`Gift voucher ${white.bold(String(voucherId))} cancelled`));
  }

  /** The voucher PDF for its giver, made now when it is missing. */
  public async voucherPdf(giverUserId: number, voucherId: number): Promise<{ file: string; filename: string }> {
    const voucher = await this.prisma.giftVoucher.findFirst({
      where: { id: voucherId, giverUserId },
    });
    if (!voucher) throw new GiftError(404, 'voucherNotFound');
    if (voucher.status !== 'open') throw new GiftError(409, 'voucherNotOpen');
    let stored = voucher.pdfFilename;
    const exists = stored
      ? await fs.stat(path.join(this.voucherDir(), stored)).then(() => true, () => false)
      : false;
    if (!exists) stored = await this.renderPdf(voucherId);
    const safeName = voucher.recipientName.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 40) || 'gift';
    return {
      file: path.join(this.voucherDir(), stored!),
      filename: `QRSong gift voucher - ${safeName}.pdf`,
    };
  }

  /**
   * Render the voucher through the PDF Lambda (A5, one page) into
   * PRIVATE_DIR/gift-vouchers under a random name, and remember it.
   */
  public async renderPdf(voucherId: number): Promise<string> {
    const voucher = await this.prisma.giftVoucher.findUnique({
      where: { id: voucherId },
      include: { lines: { select: { paymentHasPlaylistId: true } } },
    });
    if (!voucher) throw new GiftError(404, 'voucherNotFound');

    // A printed line's first card is drawn in the background; give it a
    // moment so the voucher shows the real card instead of the cover
    await this.warmCardPictures(voucher.lines.map((l) => l.paymentHasPlaylistId));

    const url = `${this.apiUri()}/gift/voucher/view/${voucherId}?${signedRenderQuery(
      'gift-voucher',
      { id: String(voucherId) },
      {}
    )}`;
    const pdf = await new PDF().renderUrlToPdfBuffer(url, {
      format: 'a5',
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
      pageRanges: '1',
    });

    await fs.mkdir(this.voucherDir(), { recursive: true });
    const filename = `${voucherId}-${randomBytes(8).toString('hex')}.pdf`;
    const target = path.join(this.voucherDir(), filename);
    await fs.writeFile(`${target}.tmp`, pdf);
    await fs.rename(`${target}.tmp`, target);
    await this.prisma.giftVoucher.update({ where: { id: voucherId }, data: { pdfFilename: filename } });
    if (voucher.pdfFilename && voucher.pdfFilename !== filename) {
      await fs.rm(path.join(this.voucherDir(), voucher.pdfFilename), { force: true });
    }
    return filename;
  }

  private async warmCardPictures(lineIds: number[]): Promise<void> {
    const printed = await this.prisma.paymentHasPlaylist.findMany({
      where: { id: { in: lineIds }, type: 'physical', NOT: { subType: 'sheets' } },
      select: { id: true },
    });
    const deadline = Date.now() + CARD_PICTURE_WAIT_MS;
    for (const line of printed) {
      while (Date.now() < deadline) {
        const state = await CardPreviews.getInstance().forLine(line.id).catch(() => null);
        if (!state || state.status !== 'generating') break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  /** What the voucher view (src/views/gift_voucher.ejs) renders. */
  public async voucherView(voucherId: number) {
    const voucher = await this.prisma.giftVoucher.findUnique({
      where: { id: voucherId },
      include: {
        lines: {
          include: {
            paymentHasPlaylist: {
              select: {
                id: true,
                type: true,
                subType: true,
                numberOfTracks: true,
                playlist: { select: { name: true, image: true } },
              },
            },
          },
        },
      },
    });
    if (!voucher) return null;
    const pictures = await Promise.all(
      voucher.lines.map(async ({ paymentHasPlaylist: line }) => {
        if (lineType(line) === 'physical') {
          const state = await CardPreviews.getInstance().forLine(line.id).catch(() => null);
          if (state?.status === 'ready') return { src: `${this.apiUri()}${state.front}`, card: true };
        }
        return { src: line.playlist.image || null, card: false };
      })
    );
    // The QR opens the redeem page in the voucher's language: the giver chose
    // it for the recipient, which a phone's own language may not match
    const redeemUrl = `${process.env['FRONTEND_URI'] || 'https://www.qrsong.io'}/${voucher.locale}/redeem/${voucher.code}`;
    return {
      voucher,
      code: formatGiftCode(voucher.code),
      sets: voucher.lines.map(({ paymentHasPlaylist: line }, index) => ({
        name: line.playlist.name,
        numberOfTracks: line.numberOfTracks,
        type: lineType(line),
        picture: pictures[index],
      })),
      hasPrinted: voucher.lines.some(({ paymentHasPlaylist: line }) => line.type === 'physical'),
      qr: qrSvg(redeemUrl),
      redeemHost: 'qrsong.io/redeem',
      translations: await this.translation.getTranslationsByPrefix(voucher.locale, 'giftVoucher'),
      t: (key: string, params: Record<string, unknown> = {}) =>
        this.translation.translate(`giftVoucher.${key}`, voucher.locale, params),
    };
  }

  // ── The recipient's side ──

  /**
   * Counts a redeem-page lookup for this IP; false once it is over the
   * hourly limit (development and trusted IPs are never limited by the
   * caller).
   */
  public async allowLookup(ip: string): Promise<boolean> {
    const count = await this.cache.increment(`gift-lookup:${ip}`, 3600).catch(() => 0);
    return count <= LOOKUPS_PER_HOUR;
  }

  /** What /redeem/<code> shows: the gift, or why it cannot be redeemed. */
  public async redeemInfo(input: unknown): Promise<RedeemInfo> {
    const code = normalizeGiftCode(input);
    if (!code) return { status: looksLikeGiftCardCode(input) ? 'giftCardCode' : 'unknown' };
    const voucher = await this.prisma.giftVoucher.findUnique({
      where: { code },
      include: {
        lines: {
          include: {
            paymentHasPlaylist: {
              include: {
                playlist: { select: { name: true, image: true } },
                appDesign: { select: { mode: true, theme: true } },
              },
            },
          },
        },
      },
    });
    if (!voucher) return { status: 'unknown' };
    if (voucher.status === 'claimed') return { status: 'redeemed' };
    if (voucher.status !== 'open') return { status: 'cancelled' };

    const appDesign = AppDesign.getInstance();
    const [giverEntitled, giverDefault] = await Promise.all([
      appDesign.isEntitled(voucher.giverUserId),
      this.prisma.appDesign.findFirst({
        where: { userId: voucher.giverUserId, paymentHasPlaylistId: null },
        select: { theme: true },
      }),
    ]);
    return {
      status: 'open',
      recipientName: voucher.recipientName,
      fromName: voucher.giverName,
      message: voucher.message,
      locale: voucher.locale,
      sets: voucher.lines.map(({ paymentHasPlaylist: line }) => {
        const plan = planAppDesignTransfer({
          override: line.appDesign
            ? { mode: line.appDesign.mode, hasTheme: line.appDesign.theme !== null }
            : null,
          giverDefaultHasTheme: !!giverDefault?.theme,
          giverEntitled,
        });
        return {
          playlistName: line.playlist.name,
          image: line.playlist.image,
          numberOfTracks: line.numberOfTracks,
          type: lineType(line),
          gamesEnabled: line.gamesEnabled,
          appDesign: plan.keepActive,
          design: pickCardDesign(line) as unknown as Record<string, unknown>,
          eco: line.eco,
          doubleSided: line.doubleSided,
        };
      }),
    };
  }

  /**
   * Redeem: the voucher's sets move to `recipientUserId`, all of them or
   * none, in one transaction under a lock on the voucher row. Asking again
   * as the same recipient (a double click, a reload) succeeds; mails and the
   * theme reload follow the commit and never undo it.
   */
  public async claim(input: unknown, recipientUserId: number): Promise<{ replay: boolean; voucherId: number }> {
    const code = normalizeGiftCode(input);
    if (!code) throw new GiftError(404, 'unknownCode');
    const appDesign = AppDesign.getInstance();

    const result = await this.prisma.$transaction(
      async (tx) => {
        const rows: any[] = await tx.$queryRaw`
          SELECT id, status, giverUserId, recipientUserId, paymentId
          FROM gift_vouchers WHERE code = ${code} FOR UPDATE`;
        const voucher = rows[0];
        if (!voucher) throw new GiftError(404, 'unknownCode');
        const voucherId = Number(voucher.id);
        const giverId = Number(voucher.giverUserId);
        if (voucher.status === 'claimed') {
          if (Number(voucher.recipientUserId) === recipientUserId) return { replay: true, voucherId };
          throw new GiftError(409, 'alreadyRedeemed');
        }
        if (voucher.status !== 'open') throw new GiftError(410, 'noLongerValid');
        if (giverId === recipientUserId) throw new GiftError(400, 'ownVoucher');

        const voucherLines = await tx.giftVoucherLine.findMany({
          where: { giftVoucherId: voucherId },
          select: { id: true, paymentHasPlaylistId: true },
        });
        const ids = voucherLines.map((l) => l.paymentHasPlaylistId);
        await tx.$queryRaw`SELECT id FROM payment_has_playlist WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`;
        const lines = await tx.paymentHasPlaylist.findMany({
          where: { id: { in: ids } },
          select: LINE_SELECT,
        });
        if (lines.length !== ids.length) throw new GiftError(409, 'setsChanged');
        for (const line of lines) {
          if (line.payment.userId !== giverId || line.payment.id !== Number(voucher.paymentId)) {
            throw new GiftError(409, 'setsChanged');
          }
          const eligibility = eligibilityOf(line);
          if (!eligibility.ok) {
            throw new GiftError(409, eligibility.reason === 'correctionsPending' ? 'notReadyYet' : 'setsChanged');
          }
        }

        const moved = await tx.paymentHasPlaylist.updateMany({
          where: { id: { in: ids }, ownerUserId: null },
          data: { ownerUserId: recipientUserId },
        });
        if (moved.count !== ids.length) throw new GiftError(409, 'setsChanged');

        // The app design each line shows goes along (planAppDesignTransfer)
        const [giverEntitled, giverDefault] = await Promise.all([
          appDesign.isEntitled(giverId),
          tx.appDesign.findFirst({ where: { userId: giverId, paymentHasPlaylistId: null } }),
        ]);
        for (const voucherLine of voucherLines) {
          const phpId = voucherLine.paymentHasPlaylistId;
          const override = await tx.appDesign.findUnique({ where: { paymentHasPlaylistId: phpId } });
          const plan = planAppDesignTransfer({
            override: override ? { mode: override.mode, hasTheme: override.theme !== null } : null,
            giverDefaultHasTheme: !!giverDefault?.theme,
            giverEntitled,
          });
          if (plan.carry === 'moved' || plan.carry === 'draft') {
            await tx.appDesign.update({
              where: { id: override!.id },
              data: {
                userId: recipientUserId,
                keepActive: plan.keepActive,
                ...(plan.mode ? { mode: plan.mode } : {}),
              },
            });
          } else if (plan.carry === 'copied' && giverDefault) {
            const copy = {
              userId: recipientUserId,
              mode: 'custom',
              keepActive: true,
              name: giverDefault.name,
              design: giverDefault.design ?? Prisma.DbNull,
              theme: giverDefault.theme ?? Prisma.DbNull,
              logo: giverDefault.logo,
              background: giverDefault.background,
              helpText: giverDefault.helpText,
              slug: newCustomerSlug(),
              version: 1,
            };
            const row = override
              ? await tx.appDesign.update({ where: { id: override.id }, data: copy })
              : await tx.appDesign.create({
                  data: {
                    ...copy,
                    paymentHasPlaylistId: phpId,
                    scopeKey: scopeKeyFor({ userId: recipientUserId, paymentHasPlaylistId: phpId }),
                  },
                });
            await appDesign.publishThemeFiles(row);
          }
          await tx.giftVoucherLine.update({
            where: { id: voucherLine.id },
            data: { openLineId: null, appDesignCarried: plan.carry },
          });
        }

        // Corrections the giver typed for a digital set but never sent: the
        // recipient finds them in the correction form. A copy, because the
        // giver may hold the same playlist on another set.
        const digitalPlaylists = lines.filter((l) => l.type === 'digital').map((l) => l.playlistId);
        if (digitalPlaylists.length > 0) {
          await tx.$executeRaw`
            INSERT IGNORE INTO usersuggestions
              (name, artist, year, extraNameAttribute, extraArtistAttribute, comment,
               createdAt, updatedAt, trackId, playlistId, userId)
            SELECT name, artist, year, extraNameAttribute, extraArtistAttribute, comment,
               NOW(), NOW(), trackId, playlistId, ${recipientUserId}
            FROM usersuggestions
            WHERE userId = ${giverId} AND playlistId IN (${Prisma.join(digitalPlaylists)})`;
        }

        await tx.giftVoucher.update({
          where: { id: voucherId },
          data: { status: 'claimed', recipientUserId, claimedAt: new Date() },
        });
        return { replay: false, voucherId };
      },
      { timeout: 30_000 }
    );

    if (!result.replay) {
      this.logger.log(
        color.green.bold(
          `Gift voucher ${white.bold(String(result.voucherId))} redeemed by user ${white.bold(
            String(recipientUserId)
          )}`
        )
      );
      await this.afterClaim(result.voucherId).catch((error) =>
        this.logger.log(color.red.bold(`After a gift redeem: ${white.bold(error.message)}`))
      );
    }
    return result;
  }

  /** Best effort, after the commit: the served themes and both mails. */
  private async afterClaim(voucherId: number): Promise<void> {
    await AppTheme.getInstance().reload();
    const voucher = await this.prisma.giftVoucher.findUnique({
      where: { id: voucherId },
      include: {
        giver: { select: { email: true, displayName: true, locale: true } },
        recipient: { select: { email: true, displayName: true, locale: true } },
        payment: { select: { locale: true } },
        lines: {
          include: {
            paymentHasPlaylist: {
              select: { type: true, subType: true, numberOfTracks: true, gamesEnabled: true, playlist: { select: { name: true } } },
            },
          },
        },
      },
    });
    if (!voucher || !voucher.recipient) return;
    const sets = voucher.lines.map(({ paymentHasPlaylist: line, appDesignCarried }) => ({
      name: line.playlist.name,
      numberOfTracks: line.numberOfTracks,
      type: lineType(line),
      gamesEnabled: line.gamesEnabled,
      appDesign: appDesignCarried === 'moved' || appDesignCarried === 'copied',
    }));
    const mail = Mail.getInstance();
    await mail
      .sendGiftReceivedMail(
        {
          email: voucher.recipient.email,
          name: voucher.recipientName || voucher.recipient.displayName,
          locale: voucher.recipient.locale || voucher.locale,
        },
        { fromName: voucher.giverName, sets }
      )
      .catch((error: any) => this.logger.log(color.red.bold(`Gift received mail: ${white.bold(error.message)}`)));
    await mail
      .sendGiftRedeemedMail(
        {
          email: voucher.giver.email,
          name: voucher.giverName || voucher.giver.displayName,
          locale: voucher.giver.locale || voucher.payment.locale || 'en',
        },
        { recipientName: voucher.recipientName, sets }
      )
      .catch((error: any) => this.logger.log(color.red.bold(`Gift redeemed mail: ${white.bold(error.message)}`)));
  }

  /** The gifts a user received, per line: from whom, the message and when. */
  public async receivedState(
    userId: number
  ): Promise<Map<number, { fromName: string; message: string | null; claimedAt: Date | null }>> {
    const vouchers = await this.prisma.giftVoucher.findMany({
      where: { recipientUserId: userId, status: 'claimed' },
      include: { lines: { select: { paymentHasPlaylistId: true } } },
    });
    const state = new Map();
    for (const voucher of vouchers) {
      for (const line of voucher.lines) {
        state.set(line.paymentHasPlaylistId, {
          fromName: voucher.giverName,
          message: voucher.message,
          claimedAt: voucher.claimedAt,
        });
      }
    }
    return state;
  }

  // ── Admin ──

  /**
   * Give a redeemed set back to the buyer (a mistake, a dispute). Its app
   * design row goes back with it and keeps showing on the cards; the
   * voucher stays as history, marked `returned` once none of its sets is
   * given any more.
   */
  public async returnToBuyer(paymentHasPlaylistId: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const line = await tx.paymentHasPlaylist.findUnique({
        where: { id: paymentHasPlaylistId },
        select: { id: true, ownerUserId: true, payment: { select: { userId: true } } },
      });
      if (!line) throw new GiftError(404, 'orderNotFound');
      if (line.ownerUserId === null) return;
      await tx.paymentHasPlaylist.update({ where: { id: line.id }, data: { ownerUserId: null } });
      await tx.appDesign.updateMany({
        where: { paymentHasPlaylistId: line.id },
        data: { userId: line.payment.userId },
      });
      const voucherLines = await tx.giftVoucherLine.findMany({
        where: { paymentHasPlaylistId: line.id, voucher: { status: 'claimed' } },
        select: { giftVoucherId: true },
      });
      for (const { giftVoucherId } of voucherLines) {
        const stillGiven = await tx.giftVoucherLine.count({
          where: { giftVoucherId, paymentHasPlaylist: { ownerUserId: { not: null } } },
        });
        if (stillGiven === 0) {
          await tx.giftVoucher.update({ where: { id: giftVoucherId }, data: { status: 'returned' } });
        }
      }
    });
    await AppTheme.getInstance().reload();
    this.logger.log(
      color.yellow.bold(`Gifted set ${white.bold(String(paymentHasPlaylistId))} returned to its buyer`)
    );
  }
}

export default GiftVouchers;
