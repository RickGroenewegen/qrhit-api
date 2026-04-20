export const SUPPORTED_CURRENCIES = [
  'EUR',
  'NOK',
  'SEK',
  'DKK',
  'GBP',
  'CHF',
  'PLN',
  'CZK',
  'USD',
  'CAD',
  'AUD',
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

// Country-to-currency auto-detect map. Poland is deliberately omitted:
// Mollie does not accept cards in PLN, so auto-charging Polish IPs in PLN
// would strip out credit card / Apple Pay. Polish customers can still pick
// PLN via the switcher (which then restricts methods to PayPal + Przelewy24).
const COUNTRY_TO_CURRENCY: Record<string, SupportedCurrency> = {
  NO: 'NOK',
  SE: 'SEK',
  DK: 'DKK',
  GB: 'GBP',
  CH: 'CHF',
  CZ: 'CZK',
  US: 'USD',
  CA: 'CAD',
  AU: 'AUD',
};

export function getCurrencyForCountry(
  countryCode: string | null | undefined
): SupportedCurrency {
  if (!countryCode) return 'EUR';
  return COUNTRY_TO_CURRENCY[countryCode.toUpperCase()] ?? 'EUR';
}

export function isSupportedCurrency(
  value: string | null | undefined
): value is SupportedCurrency {
  return !!value && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}
