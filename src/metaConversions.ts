import crypto from 'crypto';
import { color, white } from 'console-log-colors';
import Cache from './cache';
import Logger from './logger';
import PrismaInstance from './prisma';

/**
 * Meta Conversions API: the server's copy of the purchase the Meta pixel
 * reports from the browser.
 *
 * The pixel is a tag in the agency's GTM container. It fires on the GA4
 * `purchase` event of the progress page (the frontend's
 * `AnalyticsService.purchase`) and sends the order number, `transaction_id`,
 * as its event id. Once Mollie says the order is paid, this sends a `Purchase`
 * with that same event id, value and currency, so Meta counts the order once,
 * and still counts it when the browser never ran the pixel (a blocker, or the
 * tab closed before the progress page).
 *
 * Only for a buyer who accepted CookieFirst's Advertising category: the
 * checkout sends `meta` (the pixel's `_fbp` and `_fbc` cookies and the
 * browser's user agent) only then, and without it nothing is kept or sent.
 * It waits in Redis under the payment row (a resumed payment keeps its row)
 * for two weeks, never in the database, and is deleted once sent.
 *
 * Does nothing until META_PIXEL_ID and META_CAPI_ACCESS_TOKEN are set. Outside
 * production it only sends with META_CAPI_TEST_EVENT_CODE, so a test never
 * reaches the live numbers.
 */

const GRAPH_VERSION = 'v26.0';
const ATTRIBUTION_TTL_SECONDS = 14 * 24 * 60 * 60;
const SEND_TIMEOUT_MS = 10_000;

export interface MetaAttribution {
  fbp?: string;
  fbc?: string;
  userAgent: string;
}

export interface MetaPurchasePayment {
  orderId: string;
  totalPrice: number;
  email: string;
  fullname: string;
  city: string | null;
  zipcode: string | null;
  countrycode: string | null;
  clientIp: string | null;
  locale: string;
}

const attributionKey = (paymentRowId: number) => `meta_capi:${paymentRowId}`;

/**
 * What the checkout sent as `meta`, or null when the buyer did not consent or
 * the browser sent nothing usable. Meta needs the user agent for a website
 * event, so there is no event without one.
 */
export function sanitizeAttribution(input: unknown): MetaAttribution | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  if (raw['consent'] !== true) return null;
  const text = (value: unknown, max: number) =>
    typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
  const userAgent = text(raw['userAgent'], 512);
  if (!userAgent) return null;
  const cookie = (value: unknown) => {
    const v = text(value, 512);
    return v && /^fb\.\d+\.\d+\.\S+$/.test(v) ? v : undefined;
  };
  return { fbp: cookie(raw['fbp']), fbc: cookie(raw['fbc']), userAgent };
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/** Lowercase letters and digits only, the way Meta wants names and cities. */
const lettersOnly = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The `data` entry for one paid order. Contact details are normalised and
 * hashed the way Meta asks; the IP address, user agent and cookies go as they
 * are.
 */
export function buildPurchaseEvent(
  payment: MetaPurchasePayment,
  attribution: MetaAttribution,
  frontendUri: string,
  eventTime: number
): Record<string, unknown> {
  const userData: Record<string, string> = {
    client_user_agent: attribution.userAgent,
  };
  const hashed = (field: string, value: string) => {
    if (value) userData[field] = sha256(value);
  };

  hashed('em', payment.email.trim().toLowerCase());
  const names = payment.fullname.trim().split(/\s+/).map(lettersOnly).filter(Boolean);
  hashed('fn', names[0] ?? '');
  if (names.length > 1) hashed('ln', names[names.length - 1]);
  hashed('ct', lettersOnly(payment.city ?? ''));
  const country = (payment.countrycode ?? '').trim().toLowerCase();
  const zip = (payment.zipcode ?? '').toLowerCase().replace(/[\s-]/g, '');
  hashed('zp', country === 'us' ? zip.slice(0, 5) : zip);
  if (/^[a-z]{2}$/.test(country)) hashed('country', country);
  if (payment.clientIp) userData['client_ip_address'] = payment.clientIp;
  if (attribution.fbp) userData['fbp'] = attribution.fbp;
  if (attribution.fbc) userData['fbc'] = attribution.fbc;

  return {
    event_name: 'Purchase',
    event_time: eventTime,
    event_id: payment.orderId,
    action_source: 'website',
    event_source_url: `${frontendUri}/${payment.locale}/generate/progress`,
    user_data: userData,
    // The browser's purchase event: the total including VAT, in EUR.
    custom_data: {
      currency: 'EUR',
      value: Math.round(payment.totalPrice * 100) / 100,
      order_id: payment.orderId,
    },
  };
}

class MetaConversions {
  private static instance: MetaConversions;
  private cache = Cache.getInstance();
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();

  private constructor() {}

  public static getInstance(): MetaConversions {
    if (!MetaConversions.instance) {
      MetaConversions.instance = new MetaConversions();
    }
    return MetaConversions.instance;
  }

  private config(): { pixelId: string; token: string; testCode: string } | null {
    const pixelId = process.env['META_PIXEL_ID'] || '';
    const token = process.env['META_CAPI_ACCESS_TOKEN'] || '';
    const testCode = process.env['META_CAPI_TEST_EVENT_CODE'] || '';
    if (!pixelId || !token) return null;
    if (process.env['ENVIRONMENT'] !== 'production' && !testCode) return null;
    return { pixelId, token, testCode };
  }

  /**
   * Keeps what the checkout sent until the webhook. Never throws: this runs
   * inside payment creation, and nothing here may cost the sale.
   */
  public async remember(paymentRowId: number, input: unknown): Promise<void> {
    try {
      if (!this.config()) return;
      const attribution = sanitizeAttribution(input);
      if (!attribution) return;
      await this.cache.set(
        attributionKey(paymentRowId),
        JSON.stringify(attribution),
        ATTRIBUTION_TTL_SECONDS
      );
    } catch (e) {
      console.error('Meta Conversions API: could not keep the checkout attribution', e);
    }
  }

  /**
   * Sends the order's `Purchase` once it is paid. Never throws and is not
   * awaited by the webhook. No retry: a purchase Meta does not get here is a
   * purchase the pixel may still have reported.
   */
  public async sendPurchase(paymentRowId: number): Promise<void> {
    try {
      const config = this.config();
      if (!config) return;
      const stored = await this.cache.get(attributionKey(paymentRowId));
      if (!stored) return;
      const attribution = JSON.parse(stored) as MetaAttribution;

      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentRowId },
        select: {
          orderId: true,
          totalPrice: true,
          email: true,
          fullname: true,
          city: true,
          zipcode: true,
          countrycode: true,
          clientIp: true,
          locale: true,
        },
      });
      if (!payment?.orderId) return;

      const event = buildPurchaseEvent(
        payment,
        attribution,
        process.env['FRONTEND_URI'] || 'https://www.qrsong.io',
        Math.floor(Date.now() / 1000)
      );
      const response = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${config.pixelId}/events`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: [event],
            access_token: config.token,
            ...(config.testCode ? { test_event_code: config.testCode } : {}),
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        }
      );
      const body: any = await response.json().catch(() => null);
      if (!response.ok || body?.error) {
        throw new Error(
          `HTTP ${response.status}: ${body?.error?.message ?? 'no answer'}` +
            (body?.error?.fbtrace_id ? ` (fbtrace_id ${body.error.fbtrace_id})` : '')
        );
      }

      await this.cache.del(attributionKey(paymentRowId));
      this.logger.log(
        color.blue.bold('Meta Conversions API: sent the purchase of order ') +
          white.bold(payment.orderId) +
          (config.testCode ? color.blue.bold(' as a test event') : '')
      );
    } catch (e) {
      this.logger.log(
        color.red.bold('Meta Conversions API: purchase not sent for payment row ') +
          white.bold(String(paymentRowId)) +
          color.red.bold(': ') +
          white.bold(e instanceof Error ? e.message : String(e))
      );
      console.error('Meta Conversions API: purchase not sent', e);
    }
  }
}

export default MetaConversions;
