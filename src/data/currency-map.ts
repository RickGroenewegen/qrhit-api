import {
  CURRENCIES,
  MARKETS,
  type CurrencyCode,
} from './shared/shared-data.generated';

// Currencies, their order and the countries that get one automatically come
// from src/data/shared/currencies.json and markets.json.
export const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = CURRENCIES.map((c) => c.code);

export type SupportedCurrency = CurrencyCode;

// Country-to-currency auto-detect map. Poland deliberately has no currency in
// markets.json: Mollie does not accept cards in PLN, so auto-charging Polish
// IPs in PLN would strip out credit card / Apple Pay. Polish customers can
// still pick PLN via the switcher (which then restricts methods to PayPal +
// Przelewy24).
const COUNTRY_TO_CURRENCY: Record<string, SupportedCurrency> = Object.fromEntries(
  MARKETS.filter((m) => m.currency).map((m) => [m.code, m.currency!])
);

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
