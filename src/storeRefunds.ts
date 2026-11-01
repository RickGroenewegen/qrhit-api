import fs from 'fs';
import cluster from 'cluster';
import { CronJob } from 'cron';
import { color, white } from 'console-log-colors';
import {
  APIException,
  AppStoreServerAPIClient,
  Environment,
  JWSTransactionDecodedPayload,
} from '@apple/app-store-server-library';
import { androidpublisher_v3 } from 'googleapis';
import PrismaInstance from './prisma';
import Logger from './logger';
import Utils from './utils';
import Cache from './cache';
import Data from './data';
import PushoverClient from './pushover';
import StorePurchases, { STORE_BUNDLE_ID, purchaseTokenTransactionId } from './storePurchases';
import { STORE_PAYMENT_METHOD } from './storeProducts';
import { blockedReasonValue } from './data/playlists';

/**
 * Refunds of the scan app's store orders (2.1.0).
 *
 * Neither store's refund notice can reach us without a new route (Apple's
 * server notifications, Google's real-time developer notifications), so a
 * job asks them instead, every six hours on the main server (never in
 * development, whose database holds only test orders):
 *
 * - Google: `purchases.voidedpurchases.list` gives every in-app purchase of
 *   the app refunded, cancelled or charged back in the last 30 days, as far
 *   back as the API goes. A voided purchase is matched to its order by orderId
 *   (`storeTransactionId`); the purchase token itself is not stored, only
 *   its hash on the rare order paid without an orderId, which is matched too.
 * - Apple: the App Store Server API's Get Refund History, asked with a
 *   transaction of each paid order from the last APPLE_LOOKBACK_DAYS (a
 *   buyer can ask Apple for a refund up to 90 days after buying). One answer
 *   lists all of that buyer's refunded purchases in the app, so an order it
 *   already settled is not asked about again. It needs an In-App Purchase key
 *   (APPLE_IAP_KEY_FILE, APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID); without one
 *   only Google is checked.
 *
 * A refunded order gets its lines blocked, so the cards no longer play (with
 * the refund as `blockedReason`, which the dashboard shows), and
 * `refundAmount` (all of it: a deck is refunded whole), `refundedAt` (the
 * store's time) and `refundReason`. Its profit goes to 0: the reports take
 * refundAmount off the turnover but never off the profit, and the store
 * takes back what it paid out. Status stays `paid`, as with a Mollie refund.
 * Rick gets a Pushover for a real refund, the buyer no mail.
 */

// How far back Apple is asked; refunds can be requested for 90 days.
const APPLE_LOOKBACK_DAYS = 100;
const LOCK = 'store-refunds';

// Google's voidedReason, as the Play Developer API documents it.
const GOOGLE_REASONS: Record<number, string> = {
  0: 'other',
  1: 'remorse',
  2: 'not received',
  3: 'defective',
  4: 'accidental purchase',
  5: 'fraud',
  6: 'friendly fraud',
  7: 'chargeback',
  8: 'unacknowledged purchase',
};

// Apple's revocationReason: 1 the buyer had a problem with the purchase.
const APPLE_REASONS: Record<number, string> = {
  0: 'other',
  1: 'issue with the purchase',
};

// Where the refund came from, the first words of its Pushover (as a sale's).
const REFUNDED_BY: Record<string, string> = {
  [STORE_PAYMENT_METHOD.ios]: 'Via de App Store',
  [STORE_PAYMENT_METHOD.android]: 'Via Google Play',
};

export interface StoreOrder {
  id: number;
  paymentId: string;
  orderId: string | null;
  totalPrice: number;
  fullname: string | null;
  countrycode: string | null;
  paymentMethod: string | null;
  storeTransactionId: string | null;
  storeEnvironment: string | null;
}

const ORDER_SELECT = {
  id: true,
  paymentId: true,
  orderId: true,
  totalPrice: true,
  fullname: true,
  countrycode: true,
  paymentMethod: true,
  storeTransactionId: true,
  storeEnvironment: true,
} as const;

export interface StoreRefund {
  refundedAt: Date;
  /** e.g. 'Google Play refund: chargeback' */
  reason: string;
}

export function googleRefundReason(voidedReason: number | null | undefined): string {
  return `Google Play refund: ${GOOGLE_REASONS[voidedReason ?? -1] ?? `reason ${voidedReason}`}`;
}

export function appleRefundReason(revocationReason: number | null | undefined): string {
  return `App Store refund: ${APPLE_REASONS[revocationReason ?? -1] ?? `reason ${revocationReason}`}`;
}

/**
 * Why a refunded order's lines are blocked, as the dashboard shows it: the
 * refund and its day, e.g. 'Google Play refund: chargeback (2026-10-28)'.
 */
export function storeRefundBlockedReason(refund: StoreRefund): string {
  return blockedReasonValue(`${refund.reason} (${refund.refundedAt.toISOString().slice(0, 10)})`)!;
}

export interface StoreRefundCounts {
  google: number;
  apple: number;
}

interface AppleKey {
  signingKey: string;
  keyId: string;
  issuerId: string;
}

class StoreRefunds {
  private static instance: StoreRefunds;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private utils = new Utils();
  private cache = Cache.getInstance();
  private pushover = new PushoverClient();
  private appleClients = new Map<Environment, AppStoreServerAPIClient>();
  private appleKeyMissingLogged = false;

  private constructor() {
    if (cluster.isPrimary && process.env['ENVIRONMENT'] !== 'development') {
      this.utils.isMainServer().then((isMainServer) => {
        if (!isMainServer) return;
        new CronJob(
          '40 */6 * * *',
          async () => {
            await this.run();
          },
          null,
          true,
          'Europe/Amsterdam'
        );
        this.log(`refund check scheduled for ${white.bold('every six hours at :40')}`);
      });
    }
  }

  public static getInstance(): StoreRefunds {
    if (!StoreRefunds.instance) {
      StoreRefunds.instance = new StoreRefunds();
    }
    return StoreRefunds.instance;
  }

  private log(message: string, tone: 'blue' | 'green' | 'yellow' | 'red' = 'blue') {
    const line = `[${white.bold('store-refunds')}] ${message}`;
    this.logger.log(color[tone].bold(line));
  }

  /** One pass over both stores. Each half fails on its own. */
  public async run(): Promise<StoreRefundCounts> {
    const counts: StoreRefundCounts = { google: 0, apple: 0 };
    const locked = await this.cache.acquireLock(LOCK, 1800).catch(() => false);
    if (!locked) return counts;
    try {
      try {
        counts.google = await this.checkGoogle();
      } catch (error) {
        this.log(`Google Play check failed: ${(error as Error).message}`, 'red');
      }
      try {
        counts.apple = await this.checkApple();
      } catch (error) {
        this.log(`App Store check failed: ${(error as Error).message}`, 'red');
      }
      if (counts.google + counts.apple > 0) {
        this.log(
          `${white.bold(counts.google)} Google Play and ${white.bold(counts.apple)} App Store refund(s) handled`,
          'green'
        );
      }
    } finally {
      await this.cache.releaseLock(LOCK).catch(() => {});
    }
    return counts;
  }

  private async checkGoogle(): Promise<number> {
    const publisher = StorePurchases.getInstance().androidPublisher();

    // startTime is left out: Google's default is the most it allows, 30 days.
    const voided: androidpublisher_v3.Schema$VoidedPurchase[] = [];
    let token: string | undefined;
    do {
      const { data } = await publisher.purchases.voidedpurchases.list({
        packageName: STORE_BUNDLE_ID,
        maxResults: 1000,
        ...(token ? { token } : {}),
      });
      voided.push(...(data.voidedPurchases ?? []));
      token = data.tokenPagination?.nextPageToken || undefined;
    } while (token);
    if (voided.length === 0) return 0;

    const keysOf = (purchase: androidpublisher_v3.Schema$VoidedPurchase): string[] =>
      [
        purchase.orderId,
        purchase.purchaseToken ? purchaseTokenTransactionId(purchase.purchaseToken) : null,
      ].filter((key): key is string => !!key);

    const orders: StoreOrder[] = await this.prisma.payment.findMany({
      where: {
        paymentMethod: STORE_PAYMENT_METHOD.android,
        status: 'paid',
        refundedAt: null,
        storeTransactionId: { in: voided.flatMap(keysOf) },
      },
      select: ORDER_SELECT,
    });
    const byTransaction = new Map(orders.map((order) => [order.storeTransactionId!, order]));

    let handled = 0;
    for (const purchase of voided) {
      // Not ours to handle: an order already refunded, one never paid
      // (Google refunds a purchase nobody consumed), or another product.
      const order = keysOf(purchase)
        .map((key) => byTransaction.get(key))
        .find((match) => match);
      if (!order) continue;
      byTransaction.delete(order.storeTransactionId!);
      const refundedAt = purchase.voidedTimeMillis
        ? new Date(Number(purchase.voidedTimeMillis))
        : new Date();
      if (await this.refundOrder(order, { refundedAt, reason: googleRefundReason(purchase.voidedReason) })) {
        handled++;
      }
    }
    return handled;
  }

  /** The key's three settings, or null (logged once) while there is none. */
  private appleKey(): AppleKey | null {
    const file = process.env['APPLE_IAP_KEY_FILE'];
    const keyId = process.env['APPLE_IAP_KEY_ID'];
    const issuerId = process.env['APPLE_IAP_ISSUER_ID'];
    let signingKey = '';
    if (file && keyId && issuerId) {
      try {
        signingKey = fs.readFileSync(file, 'utf8');
      } catch {
        // reported below, as a missing key
      }
    }
    if (!signingKey || !keyId || !issuerId) {
      if (!this.appleKeyMissingLogged) {
        this.appleKeyMissingLogged = true;
        this.log(
          'no App Store In-App Purchase key (APPLE_IAP_KEY_FILE, APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID): App Store refunds are not checked',
          'yellow'
        );
      }
      return null;
    }
    return { signingKey, keyId, issuerId };
  }

  private appleClient(environment: Environment, key: AppleKey): AppStoreServerAPIClient {
    let client = this.appleClients.get(environment);
    if (!client) {
      client = new AppStoreServerAPIClient(key.signingKey, key.keyId, key.issuerId, STORE_BUNDLE_ID, environment);
      this.appleClients.set(environment, client);
    }
    return client;
  }

  private async checkApple(): Promise<number> {
    const key = this.appleKey();
    if (!key) return 0;

    const since = new Date(Date.now() - APPLE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const orders: StoreOrder[] = await this.prisma.payment.findMany({
      where: {
        paymentMethod: STORE_PAYMENT_METHOD.ios,
        status: 'paid',
        refundedAt: null,
        storeTransactionId: { not: null },
        createdAt: { gte: since },
      },
      select: ORDER_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    // A web proof in development (`dev_`) was no store purchase at all.
    const open = new Map(
      orders
        .filter((order) => !order.storeTransactionId!.startsWith('dev_'))
        .map((order) => [order.storeTransactionId!, order])
    );

    let handled = 0;
    for (const order of orders) {
      if (!open.has(order.storeTransactionId!)) continue;
      open.delete(order.storeTransactionId!);
      // TestFlight and App Review buy in the sandbox, which has its own API.
      const environment =
        order.storeEnvironment === 'sandbox' ? Environment.SANDBOX : Environment.PRODUCTION;

      let refunded: JWSTransactionDecodedPayload[];
      try {
        refunded = await this.appleRefunds(this.appleClient(environment, key), order.storeTransactionId!, environment);
      } catch (error) {
        if (error instanceof APIException && error.httpStatusCode === 404) {
          // Unknown to Apple in this environment (an Xcode test purchase)
          continue;
        }
        // A wrong key, the rate limit or Apple being down: the next run
        // asks again, rather than every order failing in turn now.
        const detail =
          error instanceof APIException
            ? `status ${error.httpStatusCode}, error ${error.apiError}`
            : (error as Error).message;
        this.log(`App Store refund history failed (${detail}); trying again next run`, 'red');
        return handled;
      }

      for (const tx of refunded) {
        if (!tx.transactionId || !tx.revocationDate) continue;
        const match =
          tx.transactionId === order.storeTransactionId ? order : open.get(tx.transactionId);
        if (!match) continue;
        open.delete(tx.transactionId);
        const refund = { refundedAt: new Date(tx.revocationDate), reason: appleRefundReason(tx.revocationReason) };
        if (await this.refundOrder(match, refund)) handled++;
      }
    }
    return handled;
  }

  /** Every refunded purchase of the buyer behind this transaction, verified. */
  private async appleRefunds(
    client: AppStoreServerAPIClient,
    transactionId: string,
    environment: Environment
  ): Promise<JWSTransactionDecodedPayload[]> {
    const signed: string[] = [];
    let revision: string | null = null;
    do {
      const response = await client.getRefundHistory(transactionId, revision);
      signed.push(...(response.signedTransactions ?? []));
      revision = response.hasMore && response.revision ? response.revision : null;
    } while (revision);

    const verifier = StorePurchases.getInstance().appleVerifier(environment);
    const transactions: JWSTransactionDecodedPayload[] = [];
    for (const jws of signed) {
      try {
        transactions.push(await verifier.verifyAndDecodeTransaction(jws));
      } catch (e: any) {
        this.log(`skipped a refunded transaction that did not verify (status ${e?.status ?? e?.message})`, 'yellow');
      }
    }
    return transactions;
  }

  /**
   * Blocks the order's cards, then marks it refunded. In that order: should
   * blocking or its publish fail, the order is not marked and the next run
   * tries again. True when this run handled it.
   */
  private async refundOrder(order: StoreOrder, refund: StoreRefund): Promise<boolean> {
    // The dashboard shows why a line is blocked. A line an admin blocked
    // already keeps the admin's reason.
    const lines = await this.prisma.paymentHasPlaylist.updateMany({
      where: { paymentId: order.id, OR: [{ blocked: false }, { blockedReason: null }] },
      data: { blocked: true, blockedReason: storeRefundBlockedReason(refund) },
    });
    if (!(await Data.getInstance().republishBlocked())) {
      this.log(
        `order ${white.bold(order.orderId)} (${order.paymentId}): lines blocked, but publishing the blocked list failed; trying again next run`,
        'red'
      );
      return false;
    }

    const claimed = await this.prisma.payment.updateMany({
      where: { id: order.id, refundedAt: null },
      data: {
        refundAmount: order.totalPrice,
        refundedAt: refund.refundedAt,
        refundReason: refund.reason,
        profit: 0,
      },
    });
    if (claimed.count === 0) return false;

    const sandbox = order.storeEnvironment === 'sandbox';
    const amount = `€ ${order.totalPrice.toFixed(2).replace('.', ',')}`;
    this.log(
      `${refund.reason}: order ${white.bold(order.orderId)} (${order.paymentId}, ${order.storeTransactionId}), ` +
        `${amount}, ${white.bold(lines.count)} line(s) blocked${sandbox ? ', sandbox' : ''}`,
      'yellow'
    );

    // A test purchase (App Review, TestFlight, license testers) was paid by
    // nobody and refunded to nobody.
    if (!sandbox) {
      const orderName = `${order.fullname} (${order.countrycode})`;
      await this.pushover.sendMessage(
        {
          title: `📱 APP-REFUND: ${amount} terugbetaald`,
          message:
            `${REFUNDED_BY[order.paymentMethod ?? ''] ?? 'Via de store'}: ${orderName} kreeg ${amount} terug ` +
            `voor order ${order.orderId} (${refund.reason}). De kaarten zijn geblokkeerd.`,
          sound: 'falling',
        },
        ''
      );
    }
    return true;
  }
}

export default StoreRefunds;
