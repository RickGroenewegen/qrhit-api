import { PrismaClient } from '@prisma/client';
import PrismaInstance from './prisma';
import Data from './data';
import PrintEnBind from './printers/printenbind';
import {
  BOX_PRICE,
  BOX_MAX_CARDS,
  boxTierPrice,
  EXTRA_TRACK_TIERS,
  EXTRA_TRACK_MARKUP_MULT,
} from './config/constants';

export interface VerifiedUpgradeContext {
  php: any;
  payment: any;
  playlist: any;
  user: any;
}

export interface BoxUpgradePrice {
  boxQuantity: number;
  boxMaxCards: number;
  boxUnitPriceEur: number;
  boxBasePriceEur: number;
  boxDiscountPct: number;
  boxSubtotalEur: number;
  vatEur: number;
  totalEur: number;
  taxRate: number;
}

/**
 * One physical gift box holds up to BOX_MAX_CARDS cards. A playlist that
 * exceeds that count needs additional boxes to fit everything. Clients
 * never supply box quantity directly — the server derives it.
 */
export function deriveBoxQuantity(numberOfTracks: number): number {
  if (!numberOfTracks || numberOfTracks < 1) return 1;
  return Math.max(1, Math.ceil(numberOfTracks / BOX_MAX_CARDS));
}

export interface TracksUpgradePrice {
  extraTracks: number;
  perCardEur: number;
  extraTracksCostEur: number;
  handlingFeeEur: number;
  vatEur: number;
  totalEur: number;
  taxRate: number;
}

// Flat handling fee added to every tracks upgrade regardless of tier size.
export const TRACKS_UPGRADE_HANDLING_FEE_EUR = 0.5;

/**
 * The complete set of box-design fields stored on PaymentHasPlaylist. Used
 * by both the GET endpoint (project from php → response) and the POST
 * endpoint (project from request body → Prisma update). Centralized so
 * adding a new design field touches one list, not 4+ scattered handlers.
 *
 * Keep in sync with the BoxDesignState interface in
 * /Users/rick/Sites/qrhit/src/app/shared/box-design-editor/box-design-editor.component.ts
 */
export const BOX_DESIGN_FIELDS = [
  'boxFrontBackgroundType',
  'boxFrontBackground',
  'boxFrontBackgroundColor',
  'boxFrontUseFrontGradient',
  'boxFrontGradientColor',
  'boxFrontGradientDegrees',
  'boxFrontGradientPosition',
  'boxFrontOpacity',
  'boxFrontLogo',
  'boxFrontLogoScale',
  'boxFrontLogoPositionX',
  'boxFrontLogoPositionY',
  'boxFrontEmoji',
  'boxFrontTitleType',
  'boxFrontTitleText',
  'boxFrontTitleFont',
  'boxFrontTitleFontSize',
  'boxFrontTitleColor',
  'boxFrontTitlePositionX',
  'boxFrontTitlePositionY',
  'boxFrontTitleStrokeWidth',
  'boxFrontTitleStrokeColor',
  'boxFrontTitleShadowEnabled',
  'boxFrontTitleShadowColor',
  'boxFrontTitleShadowBlur',
  'boxFrontTitleShadowOffsetX',
  'boxFrontTitleShadowOffsetY',
  'boxBackBackgroundType',
  'boxBackBackground',
  'boxBackBackgroundColor',
  'boxBackFontColor',
  'boxBackUseGradient',
  'boxBackGradientColor',
  'boxBackGradientDegrees',
  'boxBackGradientPosition',
  'boxBackOpacity',
  'boxBackText',
  'boxBackSelectedFont',
  'boxBackSelectedFontSize',
] as const;

export type BoxDesignField = (typeof BOX_DESIGN_FIELDS)[number];

/**
 * Pick only the box-design fields from any object (PaymentHasPlaylist row
 * or an incoming JSON body). Anything outside the whitelist is dropped, so
 * untrusted bodies can't write arbitrary columns and stale extra fields on
 * a row don't leak into responses.
 */
export function pickBoxDesignFields(src: any): Record<BoxDesignField, any> {
  const out: any = {};
  if (src) {
    for (const k of BOX_DESIGN_FIELDS) out[k] = src[k];
  }
  return out;
}

class Upgrade {
  private static instance: Upgrade;
  private prisma: PrismaClient = PrismaInstance.getInstance();
  private data = Data.getInstance();
  private printEnBind = PrintEnBind.getInstance();

  private constructor() {}

  public static getInstance(): Upgrade {
    if (!Upgrade.instance) {
      Upgrade.instance = new Upgrade();
    }
    return Upgrade.instance;
  }

  /**
   * Verify a (paymentId, userHash, playlistId) triple resolves to an actual
   * physical, finalized order belonging to a real user. Returns the joined
   * records on success; null otherwise.
   */
  public async verifyUserHash(
    paymentId: string,
    userHash: string,
    playlistId: string
  ): Promise<VerifiedUpgradeContext | null> {
    const user = await this.prisma.user.findFirst({
      where: { hash: userHash },
    });
    if (!user) return null;

    const payment = await this.prisma.payment.findFirst({
      where: { paymentId, userId: user.id },
    });
    if (!payment) return null;
    if (!payment.finalized) return null;

    const playlist = await this.prisma.playlist.findFirst({
      where: { playlistId },
    });
    if (!playlist) return null;

    const php = await this.prisma.paymentHasPlaylist.findFirst({
      where: { paymentId: payment.id, playlistId: playlist.id },
    });
    if (!php) return null;

    return { php, payment, playlist, user };
  }

  /**
   * Box upgrade price in EUR. Quantity is derived from the playlist's track
   * count (one box per BOX_MAX_CARDS cards). Uses the same tiered per-box
   * price (`boxTierPrice`) as the regular order flow. No shipping because
   * on the user-suggestions screen the order has not yet been sent to the
   * printer — the boxes ride along with the cards.
   */
  public async calculateBoxUpgradePrice(
    php: any,
    payment: any
  ): Promise<BoxUpgradePrice> {
    const numberOfTracks = php?.numberOfTracks || 0;
    const qty = deriveBoxQuantity(numberOfTracks);
    const countryCode = payment.countrycode || 'NL';
    const taxRate = (await this.data.getTaxRate(countryCode)) || 0;

    // boxTierPrice(qty) is VAT-INCLUSIVE — same convention as the regular
    // order flow's calculateOrder (it adds `boxFee` directly to totalPrice,
    // which itself is VAT-inclusive). So total = unit * qty, and VAT is
    // derived back-out from the inclusive amount for display only.
    const boxUnitPriceEur = boxTierPrice(qty);
    const boxBasePriceEur = BOX_PRICE;
    const boxDiscountPct = parseFloat(
      ((1 - boxUnitPriceEur / boxBasePriceEur) * 100).toFixed(2)
    );
    const totalEur = parseFloat((boxUnitPriceEur * qty).toFixed(2));
    const subtotalExclVatEur = parseFloat(
      (totalEur / (1 + taxRate / 100)).toFixed(2)
    );
    const vatEur = parseFloat((totalEur - subtotalExclVatEur).toFixed(2));

    return {
      boxQuantity: qty,
      boxMaxCards: BOX_MAX_CARDS,
      boxUnitPriceEur,
      boxBasePriceEur,
      boxDiscountPct,
      boxSubtotalEur: subtotalExclVatEur,
      vatEur,
      totalEur,
      taxRate,
    };
  }

  /**
   * Extra-tracks upgrade price in EUR. Uses the raw printenbind per-card
   * cost (paper + ink) plus a flat per-card markup, plus a flat handling
   * fee. Independent of the full margin model used at initial checkout
   * because the upgrade is a small marginal add-on rather than a fresh
   * order. No extra shipping: the extra cards ride along with the unprinted
   * order.
   */
  public async calculateExtraTracksPrice(
    _php: any,
    payment: any,
    extraTracks: number
  ): Promise<TracksUpgradePrice> {
    if (!(EXTRA_TRACK_TIERS as readonly number[]).includes(extraTracks)) {
      throw new Error(`Invalid extraTracks tier: ${extraTracks}`);
    }

    const countryCode = payment.countrycode || 'NL';
    const taxRate = (await this.data.getTaxRate(countryCode)) || 0;

    // Use the printenbind RAW per-card cost (paper + ink, no margin / no
    // handling / no VAT) and apply a multiplier markup. Keeps the upgrade
    // price simple and independent of the full margin model that the
    // initial checkout applies.
    const rawPerCardExclVat = this.printEnBind.getRawCardCostEur();
    const markedUpPerCardExclVat = rawPerCardExclVat * EXTRA_TRACK_MARKUP_MULT;
    const extraTracksCostExclVat = parseFloat(
      (markedUpPerCardExclVat * extraTracks).toFixed(2)
    );
    // Flat handling fee — applied once per upgrade regardless of tier.
    const handlingFeeEur = TRACKS_UPGRADE_HANDLING_FEE_EUR;
    const subtotalExclVat = parseFloat(
      (extraTracksCostExclVat + handlingFeeEur).toFixed(2)
    );
    const vatEur = parseFloat(
      (subtotalExclVat * (taxRate / 100)).toFixed(2)
    );
    const totalEur = parseFloat(
      (subtotalExclVat + vatEur).toFixed(2)
    );

    return {
      extraTracks,
      perCardEur: parseFloat(markedUpPerCardExclVat.toFixed(2)),
      extraTracksCostEur: extraTracksCostExclVat,
      handlingFeeEur,
      vatEur,
      totalEur,
      taxRate,
    };
  }
}

export default Upgrade;
