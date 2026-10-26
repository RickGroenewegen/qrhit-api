import crypto from 'crypto';
import webpush from 'web-push';
import { color } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';

/**
 * Broadcasts to browsers, next to the app's Firebase tokens (`push.ts`).
 *
 * The site's web scanner subscribes through the browser's own Push API with
 * our VAPID key; the subscription is the push service's endpoint plus two
 * keys. Sending is a POST to that endpoint, so only the push services of the
 * browsers we know are accepted: anything else would let a caller make this
 * server post to a URL of their choosing.
 *
 * Needs WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY and WEB_PUSH_SUBJECT (a
 * `mailto:`) in .env; `npx web-push generate-vapid-keys` makes a pair. Without
 * them the routes answer that web push is off and broadcasts skip browsers.
 * Changing the pair orphans every stored subscription.
 */

const PUSH_SERVICE_HOSTS = [
  /^fcm\.googleapis\.com$/, // Chrome, Android, Samsung Internet, Opera
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^web\.push\.apple\.com$/, // Safari, and home-screen apps on iOS 16.4+
  /^[a-z0-9-]+\.notify\.windows\.com$/, // Edge
];
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 255;
const SEND_CONCURRENCY = 20;
// A broadcast older than a day is not worth delivering any more
const TTL_SECONDS = 24 * 3600;

export interface WebPushSubscriptionInput {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown } | null;
}

export interface ValidSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function hashEndpoint(endpoint: string): string {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

/** The subscription as the browser sent it, or null when it is not one we accept. */
export function validateSubscription(input: WebPushSubscriptionInput | null | undefined): ValidSubscription | null {
  if (!input || typeof input.endpoint !== 'string') return null;
  const endpoint = input.endpoint;
  if (endpoint.length > MAX_ENDPOINT_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '') return null;
  if (!PUSH_SERVICE_HOSTS.some((host) => host.test(url.hostname))) return null;

  const p256dh = input.keys?.p256dh;
  const auth = input.keys?.auth;
  const base64Url = /^[A-Za-z0-9_-]+={0,2}$/;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  if (p256dh.length > MAX_KEY_LENGTH || auth.length > MAX_KEY_LENGTH) return null;
  if (!base64Url.test(p256dh) || !base64Url.test(auth)) return null;
  return { endpoint, p256dh, auth };
}

class WebPush {
  private static instance: WebPush;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private vapidSet = false;

  public static getInstance(): WebPush {
    if (!WebPush.instance) {
      WebPush.instance = new WebPush();
    }
    return WebPush.instance;
  }

  public publicKey(): string | null {
    return process.env['WEB_PUSH_PUBLIC_KEY'] || null;
  }

  private configure(): boolean {
    if (this.vapidSet) return true;
    const publicKey = process.env['WEB_PUSH_PUBLIC_KEY'];
    const privateKey = process.env['WEB_PUSH_PRIVATE_KEY'];
    const subject = process.env['WEB_PUSH_SUBJECT'] || 'mailto:info@qrsong.io';
    if (!publicKey || !privateKey) return false;
    webpush.setVapidDetails(subject, publicKey, privateKey);
    this.vapidSet = true;
    return true;
  }

  public async subscribe(subscription: ValidSubscription, locale: string | null): Promise<void> {
    const endpointHash = hashEndpoint(subscription.endpoint);
    const cleanLocale = locale && /^[a-z]{2,3}$/.test(locale) ? locale : null;
    await this.prisma.webPushSubscription.upsert({
      where: { endpointHash },
      update: {
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        locale: cleanLocale,
        valid: true,
      },
      create: {
        endpointHash,
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        locale: cleanLocale,
      },
    });
  }

  public async unsubscribe(endpoint: string): Promise<void> {
    await this.prisma.webPushSubscription.deleteMany({
      where: { endpointHash: hashEndpoint(endpoint) },
    });
  }

  /** Marks a browser as a test device, like `test` on push_tokens. Admin only. */
  public async setTest(endpoint: string, test: boolean): Promise<boolean> {
    const result = await this.prisma.webPushSubscription.updateMany({
      where: { endpointHash: hashEndpoint(endpoint) },
      data: { test },
    });
    return result.count > 0;
  }

  /** Whether a browser is subscribed, and as a test device. Admin only. */
  public async device(endpoint: string): Promise<{ found: boolean; test: boolean }> {
    const row = await this.prisma.webPushSubscription.findUnique({
      where: { endpointHash: hashEndpoint(endpoint) },
      select: { test: true, valid: true },
    });
    return { found: !!row && row.valid, test: !!row?.test };
  }

  public async countTargets(test: boolean): Promise<number> {
    return this.prisma.webPushSubscription.count({
      where: test ? { test: true, valid: true } : { valid: true },
    });
  }

  /**
   * Sends one broadcast to every valid browser (or only the test ones).
   * Returns how many were targeted; a dry run sends nothing.
   */
  public async broadcast(title: string, message: string, test: boolean, dry: boolean): Promise<number> {
    if (!this.configure()) {
      this.logger.log(color.yellow.bold('Web push not configured (WEB_PUSH_* missing), skipping browsers'));
      return 0;
    }
    const subscriptions = await this.prisma.webPushSubscription.findMany({
      where: test ? { test: true, valid: true } : { valid: true },
    });
    if (dry || subscriptions.length === 0) return subscriptions.length;

    // No URL: a click opens the scanner the browser subscribed on, in its
    // language (the service worker's own scope)
    const payload = JSON.stringify({ title, body: message });

    let sent = 0;
    let failed = 0;
    for (let i = 0; i < subscriptions.length; i += SEND_CONCURRENCY) {
      const batch = subscriptions.slice(i, i + SEND_CONCURRENCY);
      await Promise.all(
        batch.map(async (subscription) => {
          const ok = await this.send(subscription, payload);
          if (ok) sent++;
          else failed++;
        })
      );
    }
    this.logger.log(
      color.blue.bold(
        `Web push broadcast sent to ${color.white.bold(sent)} browser(s), ${color.white.bold(failed)} failed`
      )
    );
    return subscriptions.length;
  }

  private async send(
    subscription: { id: number; endpoint: string; p256dh: string; auth: string },
    payload: string
  ): Promise<boolean> {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        payload,
        { TTL: TTL_SECONDS }
      );
      return true;
    } catch (error: any) {
      const status = error?.statusCode;
      // 404 and 410: the browser unsubscribed or the subscription expired
      if (status === 404 || status === 410) {
        await this.prisma.webPushSubscription
          .update({ where: { id: subscription.id }, data: { valid: false } })
          .catch(() => undefined);
      } else {
        this.logger.log(
          color.red.bold(
            `Web push to subscription ${color.white.bold(subscription.id)} failed: ${color.white.bold(status || error?.message)}`
          )
        );
      }
      return false;
    }
  }
}

export default WebPush;
