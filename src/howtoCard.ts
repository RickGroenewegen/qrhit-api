import type Translation from './translation';
import { qrSvg } from './qrSvg';

/**
 * Our standard how-to card (views/partials/howto_card.ejs), printed as the
 * first card of a deck when the order line has `addHowToCard`. Its front
 * carries a QR code to the how-to page, where the app is downloaded: a
 * business client (MeetingLinq, 2026-10-27) did not see that the app comes
 * first, so the back's first step says to scan it too.
 */

/** Where the QR code leads. Never with a language in it (Rick): the page picks the visitor's. */
export const HOWTO_APP_URL = 'https://www.qrsong.io/how-to';

let howtoSvg: string | null = null;

/**
 * The QR code on the front: black modules at level Q on white, with a quiet
 * zone of four modules, as inline SVG (vector in the PDF, no request, nothing
 * for the stored-template CSP to block). 29 modules, so a module is about
 * 0.5 mm at the card's 18 mm.
 */
export function howtoQrSvg(): string {
  // Sized by the partial's plate: the SVG fills it.
  howtoSvg ??= qrSvg(HOWTO_APP_URL, { color: '#000000', errorCorrectionLevel: 'Q' }).replace(
    '<svg ',
    '<svg width="100%" height="100%" style="display: block;" '
  );
  return howtoSvg;
}

/**
 * What the how-to partial reads next to php, for every view that includes
 * it: the `howto.*` copy in the line's how-to language, English for any key
 * that language lacks, and the QR code. Nulls when the line has no how-to card.
 */
export async function howtoCardView(
  translation: Pick<Translation, 'getTranslationsByPrefix'>,
  php: { addHowToCard?: unknown; addHowToCardLocale?: string | null }
): Promise<{ howtoTranslations: Record<string, string> | null; howtoQrSvg: string | null }> {
  if (!php.addHowToCard) return { howtoTranslations: null, howtoQrSvg: null };
  const locale = php.addHowToCardLocale || 'en';
  const english = (await translation.getTranslationsByPrefix('en', 'howto')) ?? {};
  const own = locale === 'en' ? english : ((await translation.getTranslationsByPrefix(locale, 'howto')) ?? {});
  return { howtoTranslations: { ...english, ...own }, howtoQrSvg: howtoQrSvg() };
}
