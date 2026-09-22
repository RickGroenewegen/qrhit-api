import { Prisma, PrismaClient } from '@prisma/client';
import Utils from './utils';
import Cache from './cache';
import { randomBytes } from 'crypto';
import PrismaInstance from './prisma';
import {
  DiscountBase,
  buildDiscountBase,
  round2,
} from './services/discount-allocation';
import { DIGITAL_CARDS_BASE_PRICE } from './config/constants';

export type DiscountKind = 'fixed' | 'percent';

/**
 * How long a checkout may keep a voucher balance reserved while its Mollie
 * payment is still open. Longer than iDEAL's 15-minute expiry so a normal
 * checkout never loses its reservation; short enough that an abandoned tab
 * frees the balance again without waiting for Mollie's expiry webhook.
 */
export const RESERVATION_TTL_MS = 60 * 60 * 1000;

export type DiscountErrorKey =
  | 'discountCodeNotFound'
  | 'discountNotActive'
  | 'notApplicableForRealOrders'
  | 'notApplicable'
  | 'discountCodeExhausted'
  | 'insufficientDiscountAmountLeft'
  | 'onlyOnePercentCode'
  | 'discountCodeMaxUsesReached'
  | 'discountCodeAlreadyUsedByCustomer'
  | 'cannotAddDiscountWithGiftcard'
  | 'discountCodeInUse'
  | 'errorRedeemingDiscountCode';

export interface EvaluatedDiscount {
  code: string;
  discountCodeId: number;
  kind: DiscountKind;
  percent: number | null;
  maxDiscountAmount: number | null;
  /** Shown on the invoice and in the checkout: "SUMMER10 (10%)" or the code. */
  label: string;
  /** EUR applied to this order. */
  amount: number;
  /** Fixed codes: the code's total budget. */
  fullAmount: number | null;
  /** Fixed codes: balance before this order. */
  amountLeft: number | null;
  /** Fixed codes: balance after this order. */
  amountLeftAfter: number | null;
}

export interface FailedDiscount {
  code: string;
  message: DiscountErrorKey;
  fullAmount?: number;
  amountLeft?: number;
}

export interface DiscountEvaluation {
  ok: boolean;
  applied: EvaluatedDiscount[];
  failed: FailedDiscount[];
  percentDiscount: number;
  fixedDiscount: number;
  totalDiscount: number;
  remainingTotal: number;
  /** Only populated in 'redeem' mode. */
  discountUseIds: number[];
}

export type DiscountMode = 'check' | 'redeem';

/**
 * Thrown by `calculateDiscounts` when a code in the cart cannot be applied.
 * Payment creation must stop on it: the customer saw a discounted total, so
 * silently charging the full amount is never acceptable.
 */
export class DiscountApplyError extends Error {
  constructor(
    public readonly code: string,
    public readonly messageKey: DiscountErrorKey
  ) {
    super(`Discount ${code}: ${messageKey}`);
    this.name = 'DiscountApplyError';
  }
}

type DbClient = PrismaClient | Prisma.TransactionClient;

interface CartLike {
  items: any[];
  discounts?: { code?: string }[];
  /** App Designer ticked at checkout (see addAppDesignFee in order.ts). */
  appDesign?: boolean;
}

interface ParsedCodeData {
  type: DiscountKind;
  amount: number;
  percent: number | null;
  maxDiscountAmount: number | null;
  maxUses: number | null;
  oncePerCustomer: boolean;
  description: string | null;
  startDate: Date | null;
  endDate: Date | null;
  general: boolean;
  playlistId: string | null;
  digital: boolean;
}

interface CodeParams {
  amount?: number;
  type?: string;
  percent?: number | string | null;
  maxDiscountAmount?: number | string | null;
  maxUses?: number | string | null;
  oncePerCustomer?: boolean | number | string;
  code?: string;
  description?: string;
  startDate?: number | null;
  endDate?: number | null;
  general?: boolean | number | string;
  playlistId?: string;
  digital?: boolean | number | string;
}

/**
 * Use rows that still count against a code: settled ones plus reservations
 * whose checkout window has not run out. Released and expired reservations
 * are ignored, which is what frees a balance after an abandoned checkout.
 */
/**
 * Canonical form of an address for the `oncePerCustomer` limit.
 *
 * Without this, one person claims the same single-use code as often as they
 * like: rick@west14.com, rick+try2@west14.com and rick+try3@west14.com are three
 * distinct strings that all deliver to the same inbox. Sub-addressing after `+`
 * is stripped for every provider, since no mail host treats the tag as part of
 * the mailbox identity.
 *
 * Dots are only stripped for Gmail, which genuinely ignores them
 * (r.ick@gmail.com == rick@gmail.com). Elsewhere a dot can distinguish two real
 * people, so removing it would wrongly merge them and deny a legitimate
 * customer their discount.
 *
 * Only used for the usage limit. The address stored on the Payment, invoiced
 * and mailed to is always the one the customer actually typed.
 */
export function normalizeEmailForLimit(email: string | null | undefined): string | null {
  const trimmed = (email || '').trim().toLowerCase();
  if (!trimmed) return null;

  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) {
    // Not a shape we can split; fall back to the plain lowercased string rather
    // than dropping the limit altogether.
    return trimmed;
  }

  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);

  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);

  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('.').join('');

  // A local part of only a tag ("+foo@x.com") would normalise to empty.
  if (!local) return trimmed;

  return `${local}@${domain}`;
}

const liveUseWhere = (now: Date) => ({
  OR: [
    { status: 'paid' },
    { status: 'reserved', expiresAt: { gt: now } },
  ],
});

class Discount {
  private cache = Cache.getInstance();
  private prisma = PrismaInstance.getInstance();
  private utils = new Utils();

  // ---------------------------------------------------------------------
  // Admin CRUD
  // ---------------------------------------------------------------------

  /**
   * Normalise and validate the admin form. Returns the Prisma data for the
   * code or an error string.
   */
  private parseCodeParams(
    params: CodeParams
  ): { data: ParsedCodeData } | { error: string } {
    const kind: DiscountKind = params.type === 'percent' ? 'percent' : 'fixed';
    const toBool = (v: any) => v === true || v === 1 || v === '1' || v === 'true';

    let amount = 0;
    let percent: number | null = null;
    let maxDiscountAmount: number | null = null;

    if (kind === 'percent') {
      const p = Number(params.percent);
      if (params.percent === undefined || params.percent === null || isNaN(p) || p <= 0 || p > 100) {
        return { error: 'Invalid percentage' };
      }
      percent = round2(p);
      if (
        params.maxDiscountAmount !== undefined &&
        params.maxDiscountAmount !== null &&
        String(params.maxDiscountAmount) !== ''
      ) {
        const cap = Number(params.maxDiscountAmount);
        if (isNaN(cap) || cap <= 0) {
          return { error: 'Invalid maximum discount' };
        }
        maxDiscountAmount = round2(cap);
      }
    } else {
      if (
        typeof params.amount !== 'number' ||
        isNaN(params.amount) ||
        params.amount <= 0
      ) {
        return { error: 'Invalid amount' };
      }
      amount = params.amount;
    }

    let maxUses: number | null = null;
    if (
      params.maxUses !== undefined &&
      params.maxUses !== null &&
      String(params.maxUses) !== ''
    ) {
      const n = Number(params.maxUses);
      if (!Number.isInteger(n) || n < 1) {
        return { error: 'Invalid maximum uses' };
      }
      maxUses = n;
    }

    return {
      data: {
        type: kind,
        amount,
        percent,
        maxDiscountAmount,
        maxUses,
        oncePerCustomer: toBool(params.oncePerCustomer),
        description: params.description || null,
        startDate: params.startDate
          ? new Date(Number(params.startDate) * 1000)
          : null,
        endDate: params.endDate ? new Date(Number(params.endDate) * 1000) : null,
        general: toBool(params.general),
        playlistId: params.playlistId || null,
        digital: toBool(params.digital),
      },
    };
  }

  private generateCode(): string {
    const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const generatePart = () => {
      const bytes = randomBytes(4);
      let result = '';
      for (let i = 0; i < 4; i++) {
        result += CHARS[bytes[i] % CHARS.length];
      }
      return result;
    };
    return Array.from({ length: 4 }, generatePart).join('-');
  }

  /**
   * Create a discount code with all business logic.
   * @returns {Promise<{ success: boolean, code?: string, error?: string }>}
   */
  public async createAdminDiscountCode(
    params: CodeParams
  ): Promise<{ success: boolean; code?: string; error?: string }> {
    try {
      const parsed = this.parseCodeParams(params);
      if ('error' in parsed) {
        return { success: false, error: parsed.error };
      }

      let code: string;
      if (params.code) {
        code = params.code.trim().toUpperCase();
        const existingCode = await this.prisma.discountCode.findUnique({
          where: { code },
        });
        if (existingCode) {
          return { success: false, error: 'Discount code already exists' };
        }
      } else {
        code = this.generateCode();
      }

      const discount = await this.prisma.discountCode.create({
        data: { code, ...parsed.data },
      });

      return { success: true, code: discount.code };
    } catch (error) {
      return { success: false, error: 'Failed to create discount code' };
    }
  }

  /**
   * Update a discount code by id. Same params as create.
   */
  public async updateDiscountCode(
    id: number,
    params: CodeParams
  ): Promise<{ success: boolean; code?: string; error?: string }> {
    try {
      const parsed = this.parseCodeParams(params);
      if ('error' in parsed) {
        return { success: false, error: parsed.error };
      }

      const updateData: any = { ...parsed.data };
      if (params.description === undefined) {
        delete updateData.description;
      }

      if (params.code) {
        const trimmedCode = params.code.trim().toUpperCase();
        const existingCode = await this.prisma.discountCode.findUnique({
          where: { code: trimmedCode },
        });
        if (existingCode && existingCode.id !== id) {
          return { success: false, error: 'Discount code already exists' };
        }
        updateData.code = trimmedCode;
      }

      const updated = await this.prisma.discountCode.update({
        where: { id },
        data: updateData,
      });

      return { success: true, code: updated.code };
    } catch (error) {
      return { success: false, error: 'Failed to update discount code' };
    }
  }

  /**
   * Delete a discount code by id.
   */
  public async deleteDiscountCode(
    id: number
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.prisma.discountCode.delete({ where: { id } });
      return { success: true };
    } catch (error) {
      return { success: false, error: 'Failed to delete discount code' };
    }
  }

  private async withUsage(discount: any): Promise<any> {
    const usage = await this.getLiveUsage(discount.id);
    const totalSpent = usage.amountUsed;
    return {
      ...discount,
      totalSpent,
      amountLeft: round2((discount.amount || 0) - totalSpent),
      usesCount: usage.useCount,
    };
  }

  /** 0-100 "how used up is this code" for the admin balance filter. */
  private usagePercentage(d: any): number {
    if (d.type === 'percent') {
      return d.maxUses ? Math.min(100, (d.usesCount / d.maxUses) * 100) : 0;
    }
    return d.amount === 0 ? 0 : Math.min(100, (d.totalSpent / d.amount) * 100);
  }

  /**
   * Get all discount codes from the database.
   */
  public async getAllDiscounts(): Promise<{
    success: boolean;
    discounts?: any[];
    error?: string;
  }> {
    try {
      const discounts = await this.prisma.discountCode.findMany({
        orderBy: { createdAt: 'desc' },
      });
      const discountsWithBalance = await Promise.all(
        discounts.map((d) => this.withUsage(d))
      );
      return { success: true, discounts: discountsWithBalance };
    } catch (error) {
      return { success: false, error: 'Failed to fetch discounts' };
    }
  }

  /**
   * Search discounts with pagination and filtering.
   */
  public async searchDiscounts(params: {
    searchTerm?: string;
    filter?: string;
    balanceFilter?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    success: boolean;
    discounts?: any[];
    total?: number;
    page?: number;
    totalPages?: number;
    error?: string;
  }> {
    try {
      const {
        searchTerm = '',
        filter = '',
        balanceFilter = '',
        page = 1,
        limit = 12,
      } = params;
      const offset = (page - 1) * limit;

      const where: any = {};

      if (searchTerm && searchTerm.trim().length > 0) {
        const term = searchTerm.trim();
        where.OR = [
          { code: { contains: term } },
          { description: { contains: term } },
        ];
      }

      if (filter === 'promotional') {
        where.promotional = true;
      } else if (filter === 'non-promotional') {
        where.promotional = false;
      } else if (filter === 'general') {
        where.general = true;
      } else if (filter === 'digital') {
        where.digital = true;
      } else if (filter === 'percent') {
        where.type = 'percent';
      } else if (filter === 'fixed') {
        where.type = 'fixed';
      }

      // Balance filtering depends on aggregated data, so it needs the full
      // result set before paginating.
      if (balanceFilter) {
        const allDiscounts = await this.prisma.discountCode.findMany({
          where,
          orderBy: { createdAt: 'desc' },
        });
        const allWithBalance = await Promise.all(
          allDiscounts.map((d) => this.withUsage(d))
        );
        const filtered = allWithBalance.filter((d) => {
          const pct = this.usagePercentage(d);
          if (balanceFilter === 'unused') return pct === 0;
          if (balanceFilter === 'partial') return pct > 0 && pct < 100;
          if (balanceFilter === 'empty') return pct >= 100;
          return true;
        });
        const filteredTotal = filtered.length;
        return {
          success: true,
          discounts: filtered.slice(offset, offset + limit),
          total: filteredTotal,
          page,
          totalPages: Math.ceil(filteredTotal / limit),
        };
      }

      const [discounts, total] = await Promise.all([
        this.prisma.discountCode.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
        }),
        this.prisma.discountCode.count({ where }),
      ]);
      const discountsWithBalance = await Promise.all(
        discounts.map((d) => this.withUsage(d))
      );

      return {
        success: true,
        discounts: discountsWithBalance,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      };
    } catch (error) {
      return { success: false, error: 'Failed to search discounts' };
    }
  }

  /** Mint a fixed voucher (gift cards, vibe free orders, Excel imports). */
  public async createDiscountCode(
    amount: number,
    from: string,
    message: string
  ): Promise<{ id: number; code: string }> {
    try {
      const code = this.generateCode();
      const discount = await this.prisma.discountCode.create({
        data: { code, amount, from, message },
      });
      return { id: discount.id, code };
    } catch (error) {
      throw new Error(`Failed to create discount code: ${error}`);
    }
  }

  public async getDiscountDetails(code: string): Promise<any> {
    try {
      const discount = await this.prisma.discountCode.findUnique({
        where: { code },
        select: {
          id: true,
          code: true,
          amount: true,
          description: true,
          from: true,
          message: true,
        },
      });
      if (!discount) {
        return { success: false, message: 'discountCodeNotFound' };
      }
      return { success: true, ...discount };
    } catch (error) {
      return { success: false, message: 'errorRetrievingDiscountCode', error };
    }
  }

  /**
   * The standing offer the mobile app shows when someone scans a card that is
   * not ours: a friend's deck from another service, or a competitor's card.
   *
   * Deliberately read-only. Every app-facing endpoint is unauthenticated, so an
   * endpoint that *minted* a code would be an open faucet. Instead one evergreen
   * percent code is handed to everyone and `oncePerCustomer` limits it to a
   * single redemption per e-mail address, which `evaluateWith` already enforces
   * against DiscountCodedUses.email at checkout.
   *
   * Returning `{ success: false }` (expired, deleted, or switched to a fixed
   * voucher) is a normal answer, not an error: the app simply hides the offer,
   * so the code can be retired from the database without an app release.
   */
  public async getAppOffer(): Promise<{
    success: boolean;
    code?: string;
    percent?: number;
    endDate?: string | null;
  }> {
    const wanted = (process.env['APP_OFFER_CODE'] || 'JUMPSHIP')
      .trim()
      .toUpperCase();
    const cacheKey = `app_offer:${wanted}`;

    try {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      // A cache miss must never cost us the offer; fall through to the database.
    }

    let result: {
      success: boolean;
      code?: string;
      percent?: number;
      endDate?: string | null;
    } = { success: false };

    try {
      const offer = await this.prisma.discountCode.findUnique({
        where: { code: wanted },
        select: {
          code: true,
          type: true,
          percent: true,
          startDate: true,
          endDate: true,
        },
      });

      const now = new Date();
      const isLive =
        !!offer &&
        offer.type === 'percent' &&
        !!offer.percent &&
        (!offer.startDate || offer.startDate <= now) &&
        (!offer.endDate || offer.endDate >= now);

      if (isLive && offer) {
        result = {
          success: true,
          code: offer.code,
          percent: offer.percent as number,
          endDate: offer.endDate ? offer.endDate.toISOString() : null,
        };
      }
    } catch (error) {
      // Same contract as getDiscountDetails: a lookup failure is reported as
      // "no offer", never thrown at the app mid-scan.
      return { success: false };
    }

    try {
      // Short TTL: long enough to absorb a launch spike, short enough that
      // pausing the code in the database takes effect within the hour.
      await this.cache.set(cacheKey, JSON.stringify(result), 900);
    } catch (error) {
      // Not being able to cache is not a reason to withhold the offer.
    }

    return result;
  }

  // ---------------------------------------------------------------------
  // Usage queries
  // ---------------------------------------------------------------------

  /**
   * Live usage of a code: EUR consumed and number of redemptions, counting
   * paid rows and unexpired reservations only.
   */
  public async getLiveUsage(
    discountCodeId: number,
    db: DbClient = this.prisma,
    now: Date = new Date()
  ): Promise<{ amountUsed: number; useCount: number }> {
    const used: any = await db.discountCodedUses.aggregate({
      where: { discountCodeId, ...liveUseWhere(now) },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return {
      amountUsed: used?._sum?.amount || 0,
      useCount: used?._count?._all || 0,
    };
  }

  private async countLiveUsesForEmail(
    db: DbClient,
    discountCodeId: number,
    email: string,
    now: Date
  ): Promise<number> {
    return db.discountCodedUses.count({
      where: { discountCodeId, email, ...liveUseWhere(now) },
    });
  }

  public async calculateTotalDiscountForPayment(
    paymentId: number
  ): Promise<number> {
    const totalDiscount = await this.prisma.discountCodedUses.aggregate({
      where: { paymentId, status: { not: 'released' } },
      _sum: { amount: true },
    });
    return totalDiscount?._sum?.amount || 0;
  }

  // ---------------------------------------------------------------------
  // Reservation lifecycle
  // ---------------------------------------------------------------------

  /** Mollie path: bind fresh reservations to the payment row. */
  public async attachPaymentToDiscountUses(
    ids: number[],
    paymentId: number
  ): Promise<void> {
    if (!ids || ids.length === 0) return;
    await this.prisma.discountCodedUses.updateMany({
      where: { id: { in: ids } },
      data: { paymentId },
    });
  }

  /** Free-order path: there is no webhook, so settle the rows right away. */
  public async confirmDiscountUsesByIds(
    ids: number[],
    paymentId: number
  ): Promise<void> {
    if (!ids || ids.length === 0) return;
    await this.prisma.discountCodedUses.updateMany({
      where: { id: { in: ids } },
      data: { paymentId, status: 'paid', expiresAt: null },
    });
  }

  /**
   * Paid webhook. Idempotent: also re-settles rows that were released by a
   * supersede or TTL sweep before the customer eventually paid. Returns the
   * codes whose live usage now exceeds their budget so the caller can log it.
   */
  public async confirmDiscountUsesByPaymentId(
    paymentId: number
  ): Promise<{ count: number; shortfalls: { code: string; over: number }[] }> {
    const rows = await this.prisma.discountCodedUses.findMany({
      where: { paymentId },
      select: { id: true, discountCodeId: true },
    });
    if (rows.length === 0) return { count: 0, shortfalls: [] };

    const result = await this.prisma.discountCodedUses.updateMany({
      where: { paymentId, status: { not: 'paid' } },
      data: { status: 'paid', expiresAt: null },
    });

    const shortfalls: { code: string; over: number }[] = [];
    const codeIds = Array.from(new Set(rows.map((r) => r.discountCodeId)));
    for (const discountCodeId of codeIds) {
      const code = await this.prisma.discountCode.findUnique({
        where: { id: discountCodeId },
        select: { code: true, type: true, general: true, amount: true },
      });
      if (!code || code.type === 'percent' || code.general) continue;
      const usage = await this.getLiveUsage(discountCodeId);
      if (usage.amountUsed > code.amount + 0.005) {
        shortfalls.push({
          code: code.code,
          over: round2(usage.amountUsed - code.amount),
        });
      }
    }
    return { count: result.count, shortfalls };
  }

  /** Failed / canceled / expired webhook. Idempotent. */
  public async releaseDiscountUsesByPaymentId(
    paymentId: number
  ): Promise<{ success: boolean; count: number; message: string }> {
    try {
      const result = await this.prisma.discountCodedUses.updateMany({
        where: { paymentId, status: { not: 'released' } },
        data: { status: 'released' },
      });
      return {
        success: true,
        count: result.count,
        message: 'discountUsesReleasedSuccessfully',
      };
    } catch (error) {
      return { success: false, count: 0, message: 'errorReleasingDiscountUses' };
    }
  }

  /**
   * Kept for callers that still hard-delete (none in the payment flow).
   */
  public async removeDiscountUsesByPaymentId(paymentId: number): Promise<any> {
    try {
      await this.prisma.discountCodedUses.deleteMany({ where: { paymentId } });
      return { success: true, message: 'discountUsesRemovedSuccessfully' };
    } catch (error) {
      return { success: false, message: 'errorRemovingDiscountUses', error };
    }
  }

  /**
   * Release reservations for a payment that never came into existence
   * (payment creation threw). Those rows have no paymentId yet, so the
   * webhook could never clean them up.
   */
  public async removeDiscountUsesByIds(ids: number[]): Promise<any> {
    if (!ids || ids.length === 0) {
      return { success: true, message: 'noDiscountUsesToRemove' };
    }
    try {
      await this.prisma.discountCodedUses.deleteMany({
        where: { id: { in: ids } },
      });
      return { success: true, message: 'discountUsesRemovedSuccessfully' };
    } catch (error) {
      return { success: false, message: 'errorRemovingDiscountUses', error };
    }
  }

  /**
   * A customer who clicks "Pay" again (or comes back from the Mollie page
   * and retries) must not be blocked by the reservation their own earlier,
   * still-open payment is holding. Release those rows and report the Mollie
   * payment ids so the caller can try to cancel them.
   */
  public async supersedeOpenReservations(
    email: string,
    codes: string[]
  ): Promise<{ paymentIds: string[] }> {
    if (!email || !codes || codes.length === 0) return { paymentIds: [] };
    try {
      const stale = await this.prisma.payment.findMany({
        where: {
          email,
          status: { in: ['open', 'pending', 'authorized'] },
          paymentId: { startsWith: 'tr_' },
          DiscountCodedUses: {
            some: { status: 'reserved', discountCode: { code: { in: codes } } },
          },
        },
        select: { id: true, paymentId: true },
      });
      if (stale.length === 0) return { paymentIds: [] };
      await this.prisma.discountCodedUses.updateMany({
        where: { paymentId: { in: stale.map((p) => p.id) }, status: 'reserved' },
        data: { status: 'released' },
      });
      return { paymentIds: stale.map((p) => p.paymentId) };
    } catch (error) {
      return { paymentIds: [] };
    }
  }

  /**
   * Housekeeping: flip expired reservations to released. The balance query
   * already ignores them, so this is only for readable admin data and for
   * rows orphaned without a paymentId by a crash mid-checkout.
   */
  public async sweepExpiredReservations(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.discountCodedUses.updateMany({
      where: { status: 'reserved', expiresAt: { lt: now } },
      data: { status: 'released' },
    });
    return result.count;
  }

  // ---------------------------------------------------------------------
  // Evaluation (single source of truth for check + redeem)
  // ---------------------------------------------------------------------

  public static normalizeCodes(discounts?: { code?: string }[] | null): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const d of discounts || []) {
      const code = String(d?.code || '').trim().toUpperCase();
      if (code && !seen.has(code)) {
        seen.add(code);
        out.push(code);
      }
    }
    return out;
  }

  public buildBase(calc: any): DiscountBase {
    return buildDiscountBase(calc);
  }

  private labelFor(d: any): string {
    return d.type === 'percent' ? `${d.code} (${d.percent}%)` : d.code;
  }

  private emptyEvaluation(total: number): DiscountEvaluation {
    return {
      ok: true,
      applied: [],
      failed: [],
      percentDiscount: 0,
      fixedDiscount: 0,
      totalDiscount: 0,
      remainingTotal: total,
      discountUseIds: [],
    };
  }

  /**
   * Evaluate every code in the cart against the order. In 'check' mode this
   * is read-only; in 'redeem' mode it also writes the reservation rows, but
   * only when every code applies. The applicability rules are the same in
   * both modes, so the checkout never shows a discount the payment will not
   * honour.
   */
  public async evaluateDiscounts(
    cart: CartLike,
    base: DiscountBase,
    ctx: { email?: string | null; now?: Date },
    mode: DiscountMode
  ): Promise<DiscountEvaluation> {
    const codes = Discount.normalizeCodes(cart?.discounts);
    if (codes.length === 0) return this.emptyEvaluation(base.total);

    if (mode !== 'redeem') {
      return this.evaluateWith(this.prisma, cart, codes, base, ctx, mode);
    }

    const acquired: string[] = [];
    try {
      for (const code of [...codes].sort()) {
        const lockKey = `lock:discount:${code}`;
        const ok = await this.cache.executeCommand(
          'set',
          lockKey,
          'locked',
          'NX',
          'PX',
          5000
        );
        if (!ok) {
          return {
            ...this.emptyEvaluation(base.total),
            ok: false,
            failed: [{ code, message: 'discountCodeInUse' }],
          };
        }
        acquired.push(lockKey);
      }

      return await this.prisma.$transaction(async (tx) =>
        this.evaluateWith(tx, cart, codes, base, ctx, mode)
      );
    } catch (error) {
      console.log(error);
      return {
        ...this.emptyEvaluation(base.total),
        ok: false,
        failed: [{ code: codes[0], message: 'errorRedeemingDiscountCode' }],
      };
    } finally {
      for (const lockKey of acquired) {
        try {
          await this.cache.executeCommand('del', lockKey);
        } catch (e) {
          // Lock expires on its own after 5 s.
        }
      }
    }
  }

  private async evaluateWith(
    db: DbClient,
    cart: CartLike,
    codes: string[],
    base: DiscountBase,
    ctx: { email?: string | null; now?: Date },
    mode: DiscountMode
  ): Promise<DiscountEvaluation> {
    const now = ctx.now || new Date();
    // Normalised once here, which covers both the oncePerCustomer lookup below
    // and the email written onto the use row - so what we store is what we
    // later match against. Rows written before this existed hold the raw
    // address and simply will not match a tagged variant.
    const email = normalizeEmailForLimit(ctx.email);
    const items: any[] = cart?.items || [];
    const applied: EvaluatedDiscount[] = [];
    const failed: FailedDiscount[] = [];

    const hasGiftcard = items.some((i) => i?.productType === 'giftcard');
    if (hasGiftcard) {
      return {
        ...this.emptyEvaluation(base.total),
        ok: false,
        failed: codes.map((code) => ({
          code,
          message: 'cannotAddDiscountWithGiftcard' as DiscountErrorKey,
        })),
      };
    }

    const rows = await db.discountCode.findMany({
      where: { code: { in: codes } },
    });
    const byCode = new Map<string, any>(rows.map((r) => [r.code, r]));

    // Step 1: existence, window, scope. Identical for every kind of code.
    const candidates: any[] = [];
    for (const code of codes) {
      const d = byCode.get(code);
      if (!d) {
        failed.push({ code, message: 'discountCodeNotFound' });
        continue;
      }
      if (
        (d.startDate && d.startDate > now) ||
        (d.endDate && d.endDate < now)
      ) {
        failed.push({ code, message: 'discountNotActive' });
        continue;
      }
      const single = items.length === 1 ? items[0] : null;
      const singleDigital = !!single && single.type === 'digital';
      if (d.digital && !singleDigital) {
        failed.push({ code, message: 'notApplicableForRealOrders' });
        continue;
      }
      if (d.playlistId) {
        if (!single) {
          failed.push({ code, message: 'notApplicable' });
          continue;
        }
        let usePlaylistId = single.playlistId;
        const dbPlaylist = await db.playlist.findFirst({
          where: { slug: single.playlistId },
        });
        if (dbPlaylist) {
          usePlaylistId = dbPlaylist.playlistId;
        }
        const typeOk = d.digital ? singleDigital : !singleDigital;
        if (usePlaylistId !== d.playlistId || !typeOk) {
          failed.push({ code, message: 'notApplicable' });
          continue;
        }
      }
      candidates.push(d);
    }

    // Step 2: at most one percent code; it is applied before the vouchers.
    const percentCodes = candidates.filter((d) => d.type === 'percent');
    const fixedCodes = candidates.filter((d) => d.type !== 'percent');
    for (const extra of percentCodes.slice(1)) {
      failed.push({ code: extra.code, message: 'onlyOnePercentCode' });
    }
    const ordered = [...percentCodes.slice(0, 1), ...fixedCodes];

    let remaining = round2(base.total);
    let percentDiscount = 0;
    let fixedDiscount = 0;
    const percentBase = round2(base.productsGross + base.addonsGross);

    for (const d of ordered) {
      const usage = await this.getLiveUsage(d.id, db, now);
      if (d.maxUses !== null && d.maxUses !== undefined && usage.useCount >= d.maxUses) {
        failed.push({ code: d.code, message: 'discountCodeMaxUsesReached' });
        continue;
      }
      if (d.oncePerCustomer && email) {
        const mine = await this.countLiveUsesForEmail(db, d.id, email, now);
        if (mine > 0) {
          failed.push({
            code: d.code,
            message: 'discountCodeAlreadyUsedByCustomer',
          });
          continue;
        }
      }

      if (d.type === 'percent') {
        let amount = round2((percentBase * (d.percent || 0)) / 100);
        if (d.maxDiscountAmount) {
          amount = Math.min(amount, d.maxDiscountAmount);
        }
        amount = round2(Math.min(amount, remaining));
        applied.push({
          code: d.code,
          discountCodeId: d.id,
          kind: 'percent',
          percent: d.percent,
          maxDiscountAmount: d.maxDiscountAmount ?? null,
          label: this.labelFor(d),
          amount,
          fullAmount: null,
          amountLeft: null,
          amountLeftAfter: null,
        });
        percentDiscount = round2(percentDiscount + amount);
        remaining = round2(remaining - amount);
        continue;
      }

      const amountLeft = round2(d.amount - usage.amountUsed);
      if (!d.general && amountLeft <= 0) {
        failed.push({
          code: d.code,
          message: 'discountCodeExhausted',
          fullAmount: d.amount,
          amountLeft,
        });
        continue;
      }
      const usable = round2(
        d.general ? remaining : Math.max(0, Math.min(amountLeft, remaining))
      );
      applied.push({
        code: d.code,
        discountCodeId: d.id,
        kind: 'fixed',
        percent: null,
        maxDiscountAmount: null,
        label: this.labelFor(d),
        amount: usable,
        fullAmount: d.amount,
        amountLeft: d.general ? null : amountLeft,
        amountLeftAfter: d.general ? null : round2(amountLeft - usable),
      });
      fixedDiscount = round2(fixedDiscount + usable);
      remaining = round2(remaining - usable);
    }

    const totalDiscount = round2(
      Math.min(percentDiscount + fixedDiscount, base.total)
    );
    const ok = failed.length === 0;
    const discountUseIds: number[] = [];

    if (ok && mode === 'redeem') {
      const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS);
      for (const a of applied) {
        if (a.amount <= 0) continue;
        const row = await db.discountCodedUses.create({
          data: {
            amount: a.amount,
            discountCodeId: a.discountCodeId,
            email,
            status: 'reserved',
            expiresAt,
          },
        });
        discountUseIds.push(row.id);
      }
    }

    return {
      ok,
      applied,
      failed,
      percentDiscount,
      fixedDiscount,
      totalDiscount,
      remainingTotal: round2(base.total - totalDiscount),
      discountUseIds,
    };
  }

  /**
   * Price the cart the way payment creation will, so the check answers with
   * the amount the customer will actually get. Falls back to the plain item
   * total when the order cannot be calculated (e.g. no shipping rate yet).
   */
  private async baseForCart(
    cart: CartLike,
    opts: { countrycode?: string; fast?: boolean; email?: string | null }
  ): Promise<DiscountBase> {
    try {
      const Order = (await import('./order')).default;
      const calc = await Order.getInstance().calculateOrder({
        cart: { items: cart.items, appDesign: cart.appDesign === true },
        countrycode: opts.countrycode || 'NL',
        fast: !!opts.fast,
        isBusinessOrder: false,
        vatId: null,
        // An account that has App Designer is not charged for it again.
        email: opts.email || undefined,
      });
      if (calc?.success && calc.data) {
        return buildDiscountBase(calc.data);
      }
    } catch (e) {
      // fall through
    }
    const total = round2(
      (cart.items || []).reduce(
        (sum: number, i: any) => sum + (Number(i.price) || 0) * (Number(i.amount) || 1),
        0
      )
    );
    return {
      productsGross: total,
      addonsGross: 0,
      volumeDiscount: 0,
      shippingGross: 0,
      total,
      taxRate: 0,
      taxRateShipping: 0,
    };
  }

  private describeApplied(a: EvaluatedDiscount) {
    return {
      code: a.code,
      kind: a.kind,
      percent: a.percent,
      maxDiscountAmount: a.maxDiscountAmount,
      label: a.label,
      amount: a.amount,
      fullAmount: a.fullAmount ?? 0,
      amountLeft: a.amountLeft ?? 0,
    };
  }

  /**
   * Public check used by the checkout. With a cart the full evaluator runs;
   * without one (gift-card page, older clients) the legacy single-code
   * check answers the same way it always did.
   */
  public async checkDiscount(
    code: string,
    token: string,
    digital: boolean,
    opts: {
      cart?: CartLike;
      email?: string | null;
      countrycode?: string;
      fast?: boolean;
    } = {}
  ): Promise<any> {
    try {
      // verifyRecaptcha fails closed, so an unreachable Google or a missing
      // secret would otherwise turn every coupon attempt into a raw 500.
      const { isHuman } = await this.utils.verifyRecaptcha(token);
      if (!isHuman) {
        return { success: false, message: 'recaptchaFailed' };
      }

      const normalized = String(code || '').trim().toUpperCase();

      if (opts.cart && Array.isArray(opts.cart.items)) {
        const cart: CartLike = {
          items: opts.cart.items,
          discounts: [...(opts.cart.discounts || []), { code: normalized }],
        };
        const base = await this.baseForCart(cart, opts);
        const ev = await this.evaluateDiscounts(
          cart,
          base,
          { email: opts.email },
          'check'
        );
        const hit = ev.applied.find((a) => a.code === normalized);
        if (hit) {
          return { success: true, ...this.describeApplied(hit) };
        }
        const miss = ev.failed.find((f) => f.code === normalized);
        return {
          success: false,
          message: miss?.message || 'notApplicable',
          ...(miss?.fullAmount !== undefined ? { fullAmount: miss.fullAmount } : {}),
          ...(miss?.amountLeft !== undefined ? { amountLeft: miss.amountLeft } : {}),
        };
      }

      const discount = await this.prisma.discountCode.findUnique({
        where: { code: normalized },
      });
      if (!discount) {
        return { success: false, message: 'discountCodeNotFound' };
      }
      if (!digital && discount.digital) {
        return { success: false, message: 'notApplicableForRealOrders' };
      }
      const now = new Date();
      if (
        (discount.startDate && discount.startDate > now) ||
        (discount.endDate && discount.endDate < now)
      ) {
        return { success: false, message: 'discountNotActive' };
      }

      const usage = await this.getLiveUsage(discount.id);
      if (discount.type === 'percent') {
        if (discount.maxUses !== null && usage.useCount >= discount.maxUses) {
          return { success: false, message: 'discountCodeMaxUsesReached' };
        }
        return {
          success: true,
          kind: 'percent',
          percent: discount.percent,
          maxDiscountAmount: discount.maxDiscountAmount,
          label: this.labelFor(discount),
          amount: 0,
          fullAmount: 0,
          amountLeft: 0,
        };
      }

      const amountLeft = round2(discount.amount - usage.amountUsed);
      if (!discount.general && amountLeft <= 0) {
        return {
          success: false,
          message: 'discountCodeExhausted',
          fullAmount: discount.amount,
          amountLeft,
        };
      }
      return {
        success: true,
        kind: 'fixed',
        percent: null,
        label: discount.code,
        fullAmount: discount.amount,
        amountLeft,
      };
    } catch (error: any) {
      return { success: false, message: 'errorCheckingDiscountCode', error };
    }
  }

  /**
   * Re-validate every code already in the cart (checkout load, back
   * navigation, before "Pay"). Never writes anything.
   */
  public async validateCart(
    cart: CartLike,
    token: string,
    opts: { email?: string | null; countrycode?: string; fast?: boolean } = {}
  ): Promise<any> {
    try {
      const { isHuman } = await this.utils.verifyRecaptcha(token);
      if (!isHuman) {
        return { success: false, message: 'recaptchaFailed' };
      }
      const base = await this.baseForCart(cart, opts);
      const ev = await this.evaluateDiscounts(
        cart,
        base,
        { email: opts.email },
        'check'
      );
      const discounts = [
        ...ev.applied.map((a) => ({ ok: true, ...this.describeApplied(a) })),
        ...ev.failed.map((f) => ({
          ok: false,
          code: f.code,
          message: f.message,
          fullAmount: f.fullAmount ?? 0,
          amountLeft: f.amountLeft ?? 0,
        })),
      ];
      return {
        success: true,
        ok: ev.ok,
        discounts,
        totalDiscount: ev.totalDiscount,
        percentDiscount: ev.percentDiscount,
      };
    } catch (error: any) {
      return { success: false, message: 'errorCheckingDiscountCode', error };
    }
  }

  /**
   * Payment creation. Reserves the balance for every code in the cart or
   * throws `DiscountApplyError` for the first code that cannot be applied.
   */
  public async calculateDiscounts(
    cart: CartLike,
    calc: any,
    email?: string | null
  ): Promise<{
    discountAmount: number;
    discountUseIds: number[];
    discountUsed: boolean;
    percentAmount: number;
    percent: number | null;
    label: string;
  }> {
    const base = buildDiscountBase(calc);
    const ev = await this.evaluateDiscounts(cart, base, { email }, 'redeem');
    if (!ev.ok) {
      const first = ev.failed[0];
      throw new DiscountApplyError(first.code, first.message);
    }
    const percentCode = ev.applied.find((a) => a.kind === 'percent');
    return {
      discountAmount: ev.totalDiscount,
      discountUseIds: ev.discountUseIds,
      discountUsed: ev.applied.length > 0,
      percentAmount: ev.percentDiscount,
      percent: percentCode?.percent ?? null,
      label: ev.applied.map((a) => a.label).join(', '),
    };
  }

  /**
   * Calculate volume discount for digital cards without creating a discount code
   * @param cart Cart object containing items
   * @returns Volume discount amount (0 if no discount applicable)
   */
  public async calculateVolumeDiscount(cart: any): Promise<number> {
    // Import Order class to access calculateDigitalCardPrice
    const Order = (await import('./order')).default;
    const order = Order.getInstance();

    // Filter digital card items only
    const digitalCardItems = cart.items.filter(
      (item: any) => item.type === 'digital' && item.productType === 'cards'
    );

    // Need at least 2 digital playlists for volume discount
    if (digitalCardItems.length < 2) {
      return 0;
    }

    // Calculate total cards across all digital playlists
    const totalCards = digitalCardItems.reduce(
      (sum: number, item: any) => sum + parseInt(item.numberOfTracks || 0),
      0
    );

    // Calculate ideal volume price for total cards
    const volumePricing = await order.calculateDigitalCardPrice(
      DIGITAL_CARDS_BASE_PRICE,
      totalCards
    );

    // Calculate current price (each playlist priced individually at base €13)
    const currentPrice = digitalCardItems.reduce(
      (sum: number, item: any) => sum + item.price * item.amount,
      0
    );

    // Calculate discount amount
    const discountAmount = currentPrice - volumePricing.totalPrice;

    // Return discount only if positive
    return discountAmount > 0 ? parseFloat(discountAmount.toFixed(2)) : 0;
  }
}

export default Discount;
