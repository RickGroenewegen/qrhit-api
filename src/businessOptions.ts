/**
 * The one-off business options as the price-list brochures print them, in EUR
 * excl. VAT. The quotation code in vibe.ts prices the custom app and the
 * voting portal with its own literals; change both together.
 */
export const BUSINESS_OPTION_PRICES = {
  customApp: 350,
  votingPortal: 500,
  /** Our designers making the box and the cards. Most clients design them themselves. */
  designService: 500,
} as const;

/** zakelijk@ answers in Dutch, business@ in every other language (the /business page does the same). */
export function businessContactEmail(locale: string): string {
  return locale === 'nl' ? 'zakelijk@qrsong.io' : 'business@qrsong.io';
}
