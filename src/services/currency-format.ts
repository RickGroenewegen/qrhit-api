import type { SupportedCurrency } from '../data/currency-map';

const SNAP_INCREMENTS: Record<SupportedCurrency, number> = {
  EUR: 0,
  NOK: 5,
  SEK: 5,
  DKK: 5,
  CZK: 5,
  PLN: 1,
  GBP: 0.5,
  CHF: 0.5,
  USD: 0.5,
  CAD: 0.5,
  AUD: 0.5,
};

export function roundTotal(
  amount: number,
  currency: SupportedCurrency
): number {
  const increment = SNAP_INCREMENTS[currency];
  if (!increment) {
    return Number(amount.toFixed(2));
  }
  const rounded = Math.round(amount / increment) * increment;
  return Number(rounded.toFixed(2));
}

export function formatMollieAmount(
  amount: number,
  currency: SupportedCurrency
): string {
  if (currency === 'CZK' || currency === 'PLN' || currency === 'NOK' || currency === 'SEK' || currency === 'DKK') {
    return amount.toFixed(2);
  }
  return amount.toFixed(2);
}
