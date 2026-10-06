import type { SupportedCurrency } from '../data/currency-map';
import { CURRENCIES } from '../data/shared/shared-data.generated';

// Every converted amount rounds to a multiple of the currency's `snap` in
// src/data/shared/currencies.json (0: to the cent). HUF snaps to 100 Ft: ~420
// Ft to the euro and nobody prices in fillér, the step CZK and PLN have.
const SNAP_INCREMENTS: Record<string, number> = Object.fromEntries(
  CURRENCIES.map((c) => [c.code, c.snap])
);

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
