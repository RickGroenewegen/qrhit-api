import cluster from 'cluster';
import sharp from 'sharp';
import { CronJob } from 'cron';
import { color, white } from 'console-log-colors';
import PrismaInstance from './prisma';
import Logger from './logger';
import Utils from './utils';
import Cache from './cache';
import Mail, { PaymentHelpMailLine } from './mail';
import CardPreviews, { cardPairJpeg } from './cardPreview';
import { loadArtworkSource } from './playlistArtwork';
import { signedRenderQuery } from './renderSignature';

/**
 * The help mail after an abandoned payment.
 *
 * A customer who got as far as Mollie and then canceled, or whose payment
 * failed or expired, gets one friendly mail: their cards (drawn from the
 * stored design, CardPreviews.draftForLine), a link that pays this same order
 * again (Mollie.resumeAbandonedPayment) and above all an invitation to reply,
 * which reaches info@. Only when they did not pay otherwise: a paid order
 * placed since the abandoned one started means they retried and made it.
 *
 * The job runs hourly from 08:20 to 20:20 Amsterdam time, on the main server
 * only (never in development, so a dev database mails no one by itself), and
 * takes a payment that ended at least an hour ago and at most two days ago.
 * The nightly cleanup (Mollie.cleanPayments) keeps canceled and expired
 * orders ABANDONED_KEEP_DAYS for it; it used to delete them the same night.
 */

export const ABANDONED_STATUSES = ['canceled', 'failed', 'expired'];
const OPEN_STATUSES = ['open', 'pending', 'authorized'];
// A customer who tries again right away needs no mail
export const HELP_MAIL_DELAY_MINUTES = 60;
// Failed payments are never cleaned up, so without a limit the job would
// reach back years
const HELP_MAIL_WINDOW_HOURS = 48;
// One help mail per customer in this many days
const HELP_MAIL_QUIET_DAYS = 30;
// How long the mail's link pays the order again (the cleanup keeps it longer)
export const RESUME_LINK_DAYS = 7;
const LOCK = 'abandoned-payment-mails';

export type HelpMailDecision =
  | 'send'
  | 'wait'
  | 'skipped_paid'
  | 'skipped_newer'
  | 'skipped_recent'
  | 'skipped_test'
  | 'skipped_nocards';

export interface HelpMailCandidate {
  id: number;
  createdAt: Date;
  hasCards: boolean;
  // the payment was made from a trusted IP: a test-mode order
  trustedIp: boolean;
}

/** The customer's other payments, any status. */
export interface HelpMailOtherPayment {
  id: number;
  status: string;
  createdAt: Date;
  helpMailStatus: string | null;
  helpMailAt: Date | null;
}

/**
 * Whether an abandoned payment gets the help mail, given the same
 * customer's other payments. `wait` writes nothing: a newer payment is still
 * open (a retry under way), so the next run looks again.
 */
export function helpMailDecision(
  candidate: HelpMailCandidate,
  others: HelpMailOtherPayment[],
  now: Date = new Date()
): HelpMailDecision {
  const since = (other: HelpMailOtherPayment) =>
    other.createdAt.getTime() >= candidate.createdAt.getTime();
  const newer = (other: HelpMailOtherPayment) =>
    other.createdAt.getTime() > candidate.createdAt.getTime() ||
    (other.createdAt.getTime() === candidate.createdAt.getTime() && other.id > candidate.id);

  if (others.some((other) => OPEN_STATUSES.includes(other.status) && since(other))) return 'wait';
  if (others.some((other) => other.status === 'paid' && since(other))) return 'skipped_paid';
  if (others.some((other) => ABANDONED_STATUSES.includes(other.status) && newer(other))) return 'skipped_newer';
  const quietSince = now.getTime() - HELP_MAIL_QUIET_DAYS * 24 * 60 * 60 * 1000;
  if (
    others.some(
      (other) => other.helpMailStatus === 'sent' && other.helpMailAt && other.helpMailAt.getTime() > quietSince
    )
  ) {
    return 'skipped_recent';
  }
  if (candidate.trustedIp) return 'skipped_test';
  if (!candidate.hasCards) return 'skipped_nocards';
  return 'send';
}

/** The link in the mail that pays the order again (GET /order/resume/:orderId). */
export function resumeLink(orderId: string, locale: string, now: Date = new Date()): { url: string; validUntil: Date } {
  const seconds = RESUME_LINK_DAYS * 24 * 60 * 60;
  const query = signedRenderQuery('payment-resume', { orderId }, { l: locale }, seconds);
  return {
    url: `${process.env['API_URI']}/order/resume/${orderId}?${query}`,
    validUntil: new Date(now.getTime() + seconds * 1000),
  };
}

class AbandonedPayments {
  private static instance: AbandonedPayments;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private utils = new Utils();
  private cache = Cache.getInstance();

  private constructor() {
    if (cluster.isPrimary && process.env['ENVIRONMENT'] !== 'development') {
      this.utils.isMainServer().then((isMainServer) => {
        if (!isMainServer) return;
        new CronJob(
          '20 8-20 * * *',
          async () => {
            await this.run();
          },
          null,
          true,
          'Europe/Amsterdam'
        );
        this.log(`help mail cron scheduled for ${white.bold('hourly at :20, 08:20 to 20:20 Amsterdam time')}`);
      });
    }
  }

  public static getInstance(): AbandonedPayments {
    if (!AbandonedPayments.instance) {
      AbandonedPayments.instance = new AbandonedPayments();
    }
    return AbandonedPayments.instance;
  }

  private log(message: string, tone: 'blue' | 'green' | 'yellow' | 'red' = 'blue') {
    const line = `[${white.bold('abandoned-payment')}] ${message}`;
    this.logger.log(color[tone].bold(line));
  }

  /**
   * One pass: every abandoned payment that ended between the delay and the
   * window ago and was not looked at yet gets its decision, and the mail
   * when it is `send`. `delayMinutes` is for trying it out by hand.
   */
  public async run(opts: { delayMinutes?: number } = {}): Promise<{ sent: number; skipped: number; waiting: number; failed: number }> {
    const counts = { sent: 0, skipped: 0, waiting: 0, failed: 0 };
    const locked = await this.cache.acquireLock(LOCK, 900).catch(() => false);
    if (!locked) return counts;
    try {
      const now = new Date();
      const delayMinutes = opts.delayMinutes ?? HELP_MAIL_DELAY_MINUTES;
      const candidates = await this.prisma.payment.findMany({
        where: {
          status: { in: ABANDONED_STATUSES },
          paymentId: { startsWith: 'tr_' },
          helpMailStatus: null,
          updatedAt: {
            lte: new Date(now.getTime() - delayMinutes * 60 * 1000),
            gte: new Date(now.getTime() - HELP_MAIL_WINDOW_HOURS * 60 * 60 * 1000),
          },
        },
        select: { id: true, orderId: true, userId: true, email: true, clientIp: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });

      for (const candidate of candidates) {
        const others = await this.prisma.payment.findMany({
          where: {
            id: { not: candidate.id },
            ...(candidate.userId ? { userId: candidate.userId } : { email: candidate.email }),
          },
          select: { id: true, status: true, createdAt: true, helpMailStatus: true, helpMailAt: true },
        });
        const cardLines = await this.prisma.paymentHasPlaylist.count({
          where: { paymentId: candidate.id, playlist: { type: { not: 'giftcard' } } },
        });
        const decision = helpMailDecision(
          {
            id: candidate.id,
            createdAt: candidate.createdAt,
            hasCards: cardLines > 0,
            trustedIp: !!candidate.clientIp && this.utils.isTrustedIp(candidate.clientIp),
          },
          others,
          now
        );

        if (decision === 'wait') {
          counts.waiting++;
          continue;
        }
        if (decision !== 'send') {
          await this.prisma.payment.update({
            where: { id: candidate.id },
            data: { helpMailStatus: decision, helpMailAt: now },
          });
          this.log(`order ${white.bold(candidate.orderId)}: ${white.bold(decision)}`, 'yellow');
          counts.skipped++;
          continue;
        }

        // Claimed before sending, so a crash mid-send can never mail twice
        const claimed = await this.prisma.payment.updateMany({
          where: { id: candidate.id, helpMailStatus: null },
          data: { helpMailStatus: 'sending', helpMailAt: now },
        });
        if (claimed.count === 0) continue;
        const sent = await this.send(candidate.id);
        await this.prisma.payment.update({
          where: { id: candidate.id },
          data: { helpMailStatus: sent ? 'sent' : 'error', helpMailAt: new Date() },
        });
        if (sent) counts.sent++;
        else counts.failed++;
      }

      if (candidates.length > 0) {
        this.log(
          `${white.bold(counts.sent)} sent, ${white.bold(counts.skipped)} skipped, ` +
            `${white.bold(counts.waiting)} waiting, ${white.bold(counts.failed)} failed`,
          counts.failed > 0 ? 'red' : 'green'
        );
      }
    } catch (error) {
      this.log(`run failed: ${(error as Error).message}`, 'red');
    } finally {
      await this.cache.releaseLock(LOCK).catch(() => {});
    }
    return counts;
  }

  /**
   * Builds and sends the help mail for one payment, whatever its state;
   * `sendTo` replaces the recipient (an example). True once it went out.
   */
  public async send(paymentDbId: number, sendTo?: string): Promise<boolean> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentDbId },
      select: {
        orderId: true,
        email: true,
        fullname: true,
        locale: true,
        PaymentHasPlaylist: {
          select: {
            id: true,
            type: true,
            subType: true,
            numberOfTracks: true,
            amount: true,
            playlist: { select: { name: true, image: true, customImage: true, type: true } },
          },
          orderBy: { id: 'asc' },
        },
      },
    });
    if (!payment) return false;

    const lines: PaymentHelpMailLine[] = [];
    for (const line of payment.PaymentHasPlaylist) {
      if (line.playlist.type === 'giftcard') continue;
      lines.push({
        name: line.playlist.name,
        numberOfTracks: line.numberOfTracks,
        type: line.type === 'digital' ? 'digital' : line.subType === 'sheets' ? 'sheets' : 'physical',
        amount: line.amount,
        picture: await this.picture(line.id, line.playlist),
      });
    }
    if (!lines.length) return false;

    const locale = payment.locale || 'en';
    const { url, validUntil } = resumeLink(payment.orderId, locale);
    return Mail.getInstance().sendPaymentHelpMail(
      { email: payment.email, name: payment.fullname, locale },
      { orderId: payment.orderId, lines, resumeUrl: url, validUntil },
      sendTo
    );
  }

  /** The card's front and back side by side, else the playlist cover; null when neither is there. */
  private async picture(
    paymentHasPlaylistId: number,
    playlist: { image: string | null; customImage: string | null }
  ): Promise<PaymentHelpMailLine['picture']> {
    const card = await CardPreviews.getInstance().draftForLine(paymentHasPlaylistId);
    if (card) {
      return { data: await cardPairJpeg(card), contentType: 'image/jpeg', card: true };
    }
    const cover = await loadArtworkSource(playlist, process.env['PUBLIC_DIR'] as string);
    if (!cover) return null;
    try {
      const data = await sharp(cover).resize(360, 360, { fit: 'cover' }).jpeg({ quality: 85 }).toBuffer();
      return { data, contentType: 'image/jpeg', card: false };
    } catch {
      return null;
    }
  }
}

export default AbandonedPayments;
