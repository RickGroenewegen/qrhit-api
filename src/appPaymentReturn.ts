import { FastifyInstance } from 'fastify';
import PrismaInstance from './prisma';
import Translation from './translation';
import Utils from './utils';
import Logger from './logger';

/**
 * Where Mollie sends a buyer back to the scan app after paying a printed
 * order (`returnTo: 'app'` on POST /mollie/payment), the way the camera app
 * does it (camera-api `/payment-complete`):
 * - an https link of ours, which the API's /.well-known/ files hand to the
 *   app (universal link, App Link). After iDEAL the banking app leaves the
 *   buyer in Safari or Chrome, not in the app's checkout sheet; from there
 *   the link opens the app at once. The app's URL scheme as the redirect
 *   asked "Open in QRSong!?" in Safari, and Chrome often did nothing at all.
 * - where the link stays in the browser (the app's own checkout sheet, an
 *   older build), this page: the payment's status and a button back to the
 *   app (its URL scheme). While the payment is open it asks again every 3
 *   seconds, until the webhook has written the verdict. In the checkout
 *   sheet the app closes the sheet itself once the order is paid.
 *
 * No links to the website: Google Play's payments policy (the app's
 * CLAUDE.md).
 */
export const APP_PAYMENT_RETURN_PATH = '/payment-complete';

/** The app's URL scheme: the page's button back to the app. */
export const APP_PAYMENT_RETURN_URL = 'nl.rickgroenewegen.qrsong://payment';

export type PaymentReturnStatus = 'paid' | 'open' | 'failed' | 'canceled' | 'unknown';

/** What the page says for a payment row's status (Mollie's statuses). */
export function paymentReturnStatus(status: string | null | undefined): PaymentReturnStatus {
  switch (status) {
    case 'paid':
      return 'paid';
    case 'canceled':
      return 'canceled';
    case 'failed':
    case 'expired':
      return 'failed';
    case null:
    case undefined:
      return 'unknown';
    default:
      // open, pending, authorized: the webhook has not written the verdict yet
      return 'open';
  }
}

/** The app's URL scheme, with the payment when there is one. */
export function appPaymentReturnLink(paymentId: string): string {
  return paymentId ? `${APP_PAYMENT_RETURN_URL}?paymentId=${encodeURIComponent(paymentId)}` : APP_PAYMENT_RETURN_URL;
}

export function registerAppPaymentReturn(fastify: FastifyInstance): void {
  const translation = new Translation();
  const utils = new Utils();
  const logger = new Logger();

  fastify.get(APP_PAYMENT_RETURN_PATH, async (request: any, reply: any) => {
    const query = request.query ?? {};
    // A Mollie payment id; anything else shows the page without a status
    const paymentId = typeof query.paymentId === 'string' && /^tr_\w+$/.test(query.paymentId) ? query.paymentId : '';
    let payment: { status: string; locale: string } | null = null;
    if (paymentId) {
      try {
        payment = await PrismaInstance.getInstance().payment.findUnique({
          where: { paymentId },
          select: { status: true, locale: true },
        });
      } catch (error) {
        logger.log(`Payment return page: ${(error as Error).message}`);
      }
    }
    const locale =
      payment?.locale && translation.isValidLocale(payment.locale)
        ? payment.locale
        : utils.parseAcceptLanguage(request.headers['accept-language'] ?? '');
    const t =
      (await translation.getTranslationsByPrefix(locale, 'paymentComplete')) ??
      (await translation.getTranslationsByPrefix('en', 'paymentComplete')) ??
      {};

    reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex');
    return reply.view('payment_complete.ejs', {
      status: paymentReturnStatus(payment?.status),
      t,
      locale,
      back: appPaymentReturnLink(paymentId),
    });
  });
}
