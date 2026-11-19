import crypto from 'crypto';
import { color, white } from 'console-log-colors';
import Cache from './cache';
import Logger from './logger';
import PrismaInstance from './prisma';

/**
 * TikTok Events API: the paid order, told to TikTok from the server.
 *
 * TikTok ads are run from the growl `tiktok` pillar (not by the agency). The
 * TikTok pixel is a tag in the agency's GTM container, like Meta's; it sends
 * `Purchase` from the progress page with the order number as its event id.
 * Once Mollie says the order is paid, this sends the same `Purchase` with that
 * event id, value and currency, so TikTok counts the order once (it drops a
 * second event with the same pixel, name and id within 48 hours), and still
 * counts it when the browser never ran the pixel.
 *
 * Only for a buyer who accepted CookieFirst's Advertising category: the
 * checkout sends `tiktok` (the click id of the ad, the pixel's `_ttp` cookie
 * and the browser's user agent) only then, and without it nothing is kept or
 * sent. It waits in Redis under the payment row for two weeks, never in the
 * database, and is deleted once sent. src/metaConversions.ts is the same
 * thing for Meta.
 *
 * Does nothing until TIKTOK_PIXEL_CODE and TIKTOK_EVENTS_ACCESS_TOKEN are set
 * (Events Manager → the pixel → Settings → Generate Access Token). Outside
 * production it only sends with TIKTOK_EVENTS_TEST_CODE, so a test never
 * reaches the live numbers.
 */

const ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
const ATTRIBUTION_TTL_SECONDS = 14 * 24 * 60 * 60;
const SEND_TIMEOUT_MS = 10_000;

export interface TikTokAttribution {
  ttclid?: string;
  ttp?: string;
  userAgent: string;
}

export interface TikTokPurchasePayment {
  orderId: string;
  totalPrice: number;
  email: string;
  clientIp: string | null;
  locale: string;
}

const attributionKey = (paymentRowId: number) => `tiktok_events:${paymentRowId}`;

/**
 * What the checkout sent as `tiktok`, or null when the buyer did not consent
 * or the browser sent nothing usable. A website event needs the user agent.
 */
export function sanitizeAttribution(input: unknown): TikTokAttribution | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  if (raw['consent'] !== true) return null;
  const text = (value: unknown, max: number) =>
    typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
  const userAgent = text(raw['userAgent'], 512);
  if (!userAgent) return null;
  // both are opaque tokens TikTok made: letters, digits and a few signs
  const token = (value: unknown) => {
    const v = text(value, 512);
    return v && /^[A-Za-z0-9._~-]+$/.test(v) ? v : undefined;
  };
  return { ttclid: token(raw['ttclid']), ttp: token(raw['ttp']), userAgent };
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * The `data` entry for one paid order. The e-mail address goes lowercased
 * and hashed; the IP address, user agent, click id and cookie as they are.
 */
export function buildPurchaseEvent(
  payment: TikTokPurchasePayment,
  attribution: TikTokAttribution,
  frontendUri: string,
  eventTime: number
): Record<string, unknown> {
  const user: Record<string, string> = { user_agent: attribution.userAgent };
  const email = payment.email.trim().toLowerCase();
  if (email) user['email'] = sha256(email);
  if (payment.clientIp) user['ip'] = payment.clientIp;
  if (attribution.ttclid) user['ttclid'] = attribution.ttclid;
  if (attribution.ttp) user['ttp'] = attribution.ttp;

  return {
    event: 'Purchase',
    event_time: eventTime,
    event_id: payment.orderId,
    user,
    // The browser's purchase event: the total including VAT, in EUR.
    properties: {
      currency: 'EUR',
      value: Math.round(payment.totalPrice * 100) / 100,
      order_id: payment.orderId,
      content_type: 'product',
    },
    page: { url: `${frontendUri}/${payment.locale}/generate/progress` },
  };
}

class TikTokEvents {
  private static instance: TikTokEvents;
  private cache = Cache.getInstance();
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();

  private constructor() {}

  public static getInstance(): TikTokEvents {
    if (!TikTokEvents.instance) {
      TikTokEvents.instance = new TikTokEvents();
    }
    return TikTokEvents.instance;
  }

  private config(): { pixelCode: string; token: string; testCode: string } | null {
    const pixelCode = process.env['TIKTOK_PIXEL_CODE'] || '';
    const token = process.env['TIKTOK_EVENTS_ACCESS_TOKEN'] || '';
    const testCode = process.env['TIKTOK_EVENTS_TEST_CODE'] || '';
    if (!pixelCode || !token) return null;
    if (process.env['ENVIRONMENT'] !== 'production' && !testCode) return null;
    return { pixelCode, token, testCode };
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
      console.error('TikTok Events API: could not keep the checkout attribution', e);
    }
  }

  /**
   * Sends the order's `Purchase` once it is paid. Never throws and is not
   * awaited by the webhook. No retry: a purchase TikTok does not get here is
   * a purchase the pixel may still have reported.
   */
  public async sendPurchase(paymentRowId: number): Promise<void> {
    try {
      const config = this.config();
      if (!config) return;
      const stored = await this.cache.get(attributionKey(paymentRowId));
      if (!stored) return;
      const attribution = JSON.parse(stored) as TikTokAttribution;

      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentRowId },
        select: { orderId: true, totalPrice: true, email: true, clientIp: true, locale: true },
      });
      if (!payment?.orderId) return;

      const event = buildPurchaseEvent(
        payment,
        attribution,
        process.env['FRONTEND_URI'] || 'https://www.qrsong.io',
        Math.floor(Date.now() / 1000)
      );
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Access-Token': config.token },
        body: JSON.stringify({
          event_source: 'web',
          event_source_id: config.pixelCode,
          data: [event],
          ...(config.testCode ? { test_event_code: config.testCode } : {}),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const body: any = await response.json().catch(() => null);
      if (!response.ok || body?.code !== 0) {
        throw new Error(
          `HTTP ${response.status}: ${body?.message ?? 'no answer'}` +
            (body?.request_id ? ` (request ${body.request_id})` : '')
        );
      }

      await this.cache.del(attributionKey(paymentRowId));
      this.logger.log(
        color.blue.bold('TikTok Events API: sent the purchase of order ') +
          white.bold(payment.orderId) +
          (config.testCode ? color.blue.bold(' as a test event') : '')
      );
    } catch (e) {
      this.logger.log(
        color.red.bold('TikTok Events API: purchase not sent for payment row ') +
          white.bold(String(paymentRowId)) +
          color.red.bold(': ') +
          white.bold(e instanceof Error ? e.message : String(e))
      );
      console.error('TikTok Events API: purchase not sent', e);
    }
  }
}

export default TikTokEvents;
