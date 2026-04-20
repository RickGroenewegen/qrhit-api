import { euCountryCodes, getTaxRate } from '../data/users';
import { DataDeps } from '../data/types';
import Vies from './vies';

export interface TaxContextParams {
  buyerCountry: string;
  isBusinessOrder?: boolean;
  vatId?: string | null;
}

export interface TaxContextResult {
  taxRate: number;
  reverseCharge: boolean;
  // The normalized VAT ID that reverse charge was applied against. Stored
  // on the Payment row as `vatIdChecked`. Only present when reverse charge
  // actually applied (i.e. VIES returned valid).
  vatIdChecked?: string;
  // 'valid'       → VIES confirmed, reverse charge applied
  // 'invalid'     → VIES says the ID is not registered / format wrong →
  //                 local VAT charged, surface a fix-your-VAT-ID message
  // 'unreachable' → VIES down or timed out → local VAT charged (safe
  //                 fallback), customer can request a corrected invoice
  // 'not-checked' → preconditions not met (not business, no ID, domestic,
  //                 or non-EU buyer) → no VIES call was made
  vatIdStatus: 'valid' | 'invalid' | 'unreachable' | 'not-checked';
}

function sellerCountry(): string {
  const raw = process.env['PRODUCT_COUNTRY'];
  return (raw || 'NL').replace(/["']/g, '').toUpperCase();
}

/**
 * Resolve the VAT rate and reverse-charge flag for an order. Encapsulates
 * the EU B2B reverse-charge rule (Article 196, Directive 2006/112/EC):
 * when a seller in one EU member state supplies a business in a different
 * member state *and* that business has a valid VAT ID registered in VIES,
 * VAT is charged at 0% on the invoice and the buyer self-accounts.
 *
 * Non-eligible cases (all fall through to the normal country rate):
 *   - non-EU buyer (already 0% export, not reverse charge)
 *   - domestic sale (NL → NL): still charge NL VAT
 *   - B2C consumer: no reverse charge, ever
 *   - B2B without a VAT ID: no reverse charge (we can't verify)
 *   - B2B with VAT ID but VIES says invalid / unreachable: fall back to VAT
 *
 * The "fall back to VAT on VIES outage" bias is intentional — we'd rather
 * over-collect and refund the difference than under-collect and owe the
 * tax authority.
 */
export async function resolveTaxContext(
  deps: DataDeps,
  params: TaxContextParams
): Promise<TaxContextResult> {
  const buyer = (params.buyerCountry || '').toUpperCase();
  const baseTaxRate = (await getTaxRate(deps, buyer)) ?? 0;

  const isEuBuyer = euCountryCodes.includes(buyer);
  const isCrossBorder = isEuBuyer && buyer !== sellerCountry();

  // Only try VIES when all preconditions line up — avoids pointless calls.
  if (!params.isBusinessOrder || !params.vatId || !isCrossBorder) {
    return {
      taxRate: baseTaxRate,
      reverseCharge: false,
      vatIdStatus: 'not-checked',
    };
  }

  const check = await Vies.getInstance().validate(params.vatId, buyer);
  if (!check) {
    // Normalization failed (bad format, wrong country prefix, etc.) — no
    // VIES call was made. Treat the same as an invalid result so the user
    // sees a "fix your VAT ID" message.
    return {
      taxRate: baseTaxRate,
      reverseCharge: false,
      vatIdStatus: 'invalid',
    };
  }

  if (!check.valid) {
    return {
      taxRate: baseTaxRate,
      reverseCharge: false,
      vatIdStatus: check.unreachable ? 'unreachable' : 'invalid',
    };
  }

  return {
    taxRate: 0,
    reverseCharge: true,
    vatIdChecked: check.normalized,
    vatIdStatus: 'valid',
  };
}
