import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import jsonwebtoken from 'jsonwebtoken';
import { google, androidpublisher_v3 } from 'googleapis';
import {
  Environment,
  JWSTransactionDecodedPayload,
  SignedDataVerifier,
} from '@apple/app-store-server-library';
import { color } from 'console-log-colors';
import Logger from './logger';
import { StorePlatform, parseStorePlatform } from './storeProducts';

/**
 * Checks a purchase the scan app made in the App Store or Google Play, for
 * POST /mollie/check (see storeProducts.ts for what is sold).
 *
 * Apple: the app sends the transaction's JWS (StoreKit 2
 * `jwsRepresentation`). It is verified here, offline, against Apple's root
 * certificates in src/_data/apple (Apple Root CA - G3 signs StoreKit 2
 * transactions; SHA-256 63:34:3A:BF…:91:79, checked 2026-10-30). No App
 * Store Server API key is needed for that.
 *
 * Google: the app sends the purchase token, which is looked up with the Play
 * Developer API (`purchases.products.get`) under the service account in
 * GOOGLE_PLAY_SERVICE_ACCOUNT_FILE, and consumed once the order is paid
 * (`purchases.products.consume`). An unconsumed purchase is refunded by
 * Google after three days, and the same product cannot be bought again.
 *
 * Test purchases are accepted and flagged `sandbox`: App Review buys in
 * Apple's sandbox against the production API, TestFlight and Play's license
 * testers do too, and none of them are charged. Xcode's local StoreKit
 * testing signs with its own key, so those are accepted in development only.
 */

export const STORE_BUNDLE_ID = 'nl.rickgroenewegen.qrsong';
// The app's Apple ID (App Store Connect → App Information); the verifier
// needs it for production transactions.
const APP_APPLE_ID = 6727011939;

export interface StoreProof {
  platform: StorePlatform | 'web';
  productId: string;
  /** iOS: the transaction's jwsRepresentation. */
  jws?: string;
  /** Android: the purchase token. */
  purchaseToken?: string;
  /** Web (development only): the token the order was created with. */
  appAccountToken?: string;
}

export interface VerifiedPurchase {
  platform: StorePlatform | 'web';
  /** Apple's transactionId, Google's orderId. Unique per purchase. */
  transactionId: string;
  productId: string;
  /** The order's uuid the app passed to the store. */
  appAccountToken: string | null;
  sandbox: boolean;
  /** What the buyer paid, when the store says so (Apple only). */
  price: number | null;
  currency: string | null;
  purchaseToken?: string;
}

export class StorePurchaseError extends Error {
  constructor(public code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export function parseStoreProof(value: any): StoreProof | null {
  if (!value || typeof value !== 'object') return null;
  const productId = typeof value.productId === 'string' ? value.productId : '';
  if (!productId) return null;
  const platform =
    parseStorePlatform(value.platform) ?? (value.platform === 'web' ? 'web' : null);
  if (platform === 'ios' && typeof value.jws === 'string' && value.jws) {
    return { platform, productId, jws: value.jws };
  }
  if (platform === 'android' && typeof value.purchaseToken === 'string' && value.purchaseToken) {
    return { platform, productId, purchaseToken: value.purchaseToken };
  }
  if (platform === 'web' && typeof value.appAccountToken === 'string') {
    return { platform, productId, appAccountToken: value.appAccountToken };
  }
  return null;
}

class StorePurchases {
  private static instance: StorePurchases;
  private logger = new Logger();
  private appleVerifiers = new Map<Environment, SignedDataVerifier>();
  private publisher: androidpublisher_v3.Androidpublisher | null = null;

  private constructor() {}

  public static getInstance(): StorePurchases {
    if (!StorePurchases.instance) {
      StorePurchases.instance = new StorePurchases();
    }
    return StorePurchases.instance;
  }

  private isDevelopment(): boolean {
    return process.env['ENVIRONMENT'] === 'development';
  }

  public async verify(proof: StoreProof): Promise<VerifiedPurchase> {
    if (proof.platform === 'ios') return this.verifyApple(proof);
    if (proof.platform === 'android') return this.verifyGoogle(proof);
    return this.verifyWeb(proof);
  }

  /**
   * After the order is paid: Google's purchase is consumed (which also
   * acknowledges it). Apple's transaction is finished by the app. A failure
   * is logged, not thrown: the app consumes it too when the check answers
   * paid, and the order stands either way.
   */
  public async finish(purchase: VerifiedPurchase): Promise<void> {
    if (purchase.platform !== 'android' || !purchase.purchaseToken) return;
    try {
      const publisher = this.androidPublisher();
      await publisher.purchases.products.consume({
        packageName: STORE_BUNDLE_ID,
        productId: purchase.productId,
        token: purchase.purchaseToken,
      });
    } catch (e: any) {
      this.logger.log(
        color.yellow.bold('Could not consume Play purchase ') +
          color.white.bold(purchase.transactionId) +
          color.yellow.bold(`: ${e?.message ?? e}`)
      );
    }
  }

  private appleVerifier(environment: Environment): SignedDataVerifier {
    let verifier = this.appleVerifiers.get(environment);
    if (!verifier) {
      const dir = path.join(process.cwd(), 'src', '_data', 'apple');
      const roots = fs
        .readdirSync(dir)
        .filter((file) => file.endsWith('.cer'))
        .map((file) => fs.readFileSync(path.join(dir, file)));
      verifier = new SignedDataVerifier(
        roots,
        true,
        environment,
        STORE_BUNDLE_ID,
        environment === Environment.PRODUCTION ? APP_APPLE_ID : undefined
      );
      this.appleVerifiers.set(environment, verifier);
    }
    return verifier;
  }

  private async verifyApple(proof: StoreProof): Promise<VerifiedPurchase> {
    // The environment the transaction claims picks the verifier; the
    // signature check then proves the claim (only Xcode's is unsigned).
    const claimed = (jsonwebtoken.decode(proof.jws!) as any)?.environment;
    const environment =
      claimed === Environment.PRODUCTION
        ? Environment.PRODUCTION
        : claimed === Environment.SANDBOX
          ? Environment.SANDBOX
          : claimed === Environment.XCODE && this.isDevelopment()
            ? Environment.XCODE
            : null;
    if (!environment) throw new StorePurchaseError('store_proof', `environment ${claimed}`);

    let tx: JWSTransactionDecodedPayload;
    try {
      tx = await this.appleVerifier(environment).verifyAndDecodeTransaction(proof.jws!);
    } catch (e: any) {
      throw new StorePurchaseError('store_proof', `apple status ${e?.status ?? e?.message}`);
    }
    if (tx.revocationDate) throw new StorePurchaseError('store_refunded');
    if (!tx.transactionId || !tx.productId) throw new StorePurchaseError('store_proof');
    return {
      platform: 'ios',
      transactionId: tx.transactionId,
      productId: tx.productId,
      appAccountToken: tx.appAccountToken ?? null,
      sandbox: environment !== Environment.PRODUCTION,
      price: typeof tx.price === 'number' ? tx.price / 1000 : null,
      currency: tx.currency ?? null,
    };
  }

  private androidPublisher(): androidpublisher_v3.Androidpublisher {
    if (!this.publisher) {
      const keyFile = process.env['GOOGLE_PLAY_SERVICE_ACCOUNT_FILE'];
      if (!keyFile) throw new StorePurchaseError('store_unavailable', 'GOOGLE_PLAY_SERVICE_ACCOUNT_FILE');
      const auth = new google.auth.GoogleAuth({
        keyFile,
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
      });
      this.publisher = google.androidpublisher({ version: 'v3', auth });
    }
    return this.publisher;
  }

  private async verifyGoogle(proof: StoreProof): Promise<VerifiedPurchase> {
    let purchase: androidpublisher_v3.Schema$ProductPurchase;
    try {
      const { data } = await this.androidPublisher().purchases.products.get({
        packageName: STORE_BUNDLE_ID,
        productId: proof.productId,
        token: proof.purchaseToken!,
      });
      purchase = data;
    } catch (e: any) {
      if (e instanceof StorePurchaseError) throw e;
      // 400/404: not a purchase of this product. Anything else is Google
      // being unreachable, which the app retries.
      const status = Number(e?.code ?? e?.response?.status);
      throw new StorePurchaseError(
        status === 400 || status === 404 ? 'store_proof' : 'store_unavailable',
        `play ${status}: ${e?.message}`
      );
    }
    // 0 purchased, 1 cancelled, 2 pending (paid in cash at a shop, say).
    if (purchase.purchaseState === 2) throw new StorePurchaseError('store_pending');
    if (purchase.purchaseState !== 0) throw new StorePurchaseError('store_refunded');
    // License testers' purchases have an orderId as well; the token's hash
    // stands in should one ever come without.
    const transactionId =
      purchase.orderId ||
      `token_${crypto.createHash('sha256').update(proof.purchaseToken!).digest('hex').slice(0, 40)}`;
    return {
      platform: 'android',
      transactionId,
      productId: proof.productId,
      appAccountToken: purchase.obfuscatedExternalAccountId ?? null,
      // purchaseType: 0 test (license tester), 1 promo code, 2 rewarded; absent for a real sale.
      sandbox: purchase.purchaseType === 0,
      price: null,
      currency: null,
      purchaseToken: proof.purchaseToken,
    };
  }

  // `ng serve` has no store: the plugin's web build fakes the purchase, and
  // development takes the app's word for it so the flow runs in a browser.
  private async verifyWeb(proof: StoreProof): Promise<VerifiedPurchase> {
    if (!this.isDevelopment()) throw new StorePurchaseError('store_proof', 'web');
    return {
      platform: 'web',
      transactionId: `dev_${proof.appAccountToken}`,
      productId: proof.productId,
      appAccountToken: proof.appAccountToken ?? null,
      sandbox: true,
      price: null,
      currency: null,
    };
  }
}

export default StorePurchases;
