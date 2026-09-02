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

export type VatRegion = 'nl' | 'eu' | 'world';

export interface QuotationVatContext {
  region: VatRegion;
  rate: number; // percent
  reverseCharge: boolean;
}

// Free-text fallback for legacy Company.countrycode values typed before the
// field became a dropdown of ISO codes. Only covers names admins actually
// typed (Dutch/English/German); anything unrecognized resolves to 'nl' so we
// over-collect rather than under-collect — same bias as resolveTaxContext.
const COUNTRY_NAME_TO_ISO: Record<string, string> = {
  nederland: 'NL',
  netherlands: 'NL',
  'the netherlands': 'NL',
  holland: 'NL',
  niederlande: 'NL',
  belgie: 'BE',
  'belgië': 'BE',
  belgium: 'BE',
  belgien: 'BE',
  duitsland: 'DE',
  germany: 'DE',
  deutschland: 'DE',
  frankrijk: 'FR',
  france: 'FR',
  frankreich: 'FR',
  luxemburg: 'LU',
  luxembourg: 'LU',
  oostenrijk: 'AT',
  austria: 'AT',
  'österreich': 'AT',
  osterreich: 'AT',
  spanje: 'ES',
  spain: 'ES',
  spanien: 'ES',
  italie: 'IT',
  'italië': 'IT',
  italy: 'IT',
  italien: 'IT',
  ierland: 'IE',
  ireland: 'IE',
  irland: 'IE',
  denemarken: 'DK',
  denmark: 'DK',
  'dänemark': 'DK',
  danemark: 'DK',
  zweden: 'SE',
  sweden: 'SE',
  schweden: 'SE',
  polen: 'PL',
  poland: 'PL',
  portugal: 'PT',
  finland: 'FI',
  finnland: 'FI',
  tsjechie: 'CZ',
  'tsjechië': 'CZ',
  'czech republic': 'CZ',
  czechia: 'CZ',
  tschechien: 'CZ',
  hongarije: 'HU',
  hungary: 'HU',
  ungarn: 'HU',
  roemenie: 'RO',
  'roemenië': 'RO',
  romania: 'RO',
  'rumänien': 'RO',
  griekenland: 'GR',
  greece: 'GR',
  griechenland: 'GR',
  zwitserland: 'CH',
  switzerland: 'CH',
  schweiz: 'CH',
  suisse: 'CH',
  'verenigd koninkrijk': 'GB',
  'united kingdom': 'GB',
  uk: 'GB',
  engeland: 'GB',
  england: 'GB',
  'great britain': 'GB',
  'verenigde staten': 'US',
  'united states': 'US',
  usa: 'US',
  amerika: 'US',
  noorwegen: 'NO',
  norway: 'NO',
  norwegen: 'NO',
  canada: 'CA',
  australie: 'AU',
  'australië': 'AU',
  australia: 'AU',
  australien: 'AU',
};

// Recognized non-EU ISO codes. A 2-letter code outside the EU list that is
// not in here is treated as unrecognized (→ 'nl'): charging 21% to a typo is
// recoverable, granting a 0% quote to one is not.
const KNOWN_NON_EU_ISO = [
  'CH', 'GB', 'US', 'NO', 'CA', 'AU', 'NZ', 'JP', 'AE', 'IS', 'LI', 'TR',
  'RS', 'UA', 'MA', 'ZA', 'SG', 'HK', 'KR', 'CN', 'IN', 'BR', 'MX', 'IL',
];

/**
 * Bucket a Company.countrycode into the three VAT treatments a quotation
 * can carry: domestic (21%), intra-EU B2B (reverse charge, 0%) or outside
 * the EU (0%). Quotations have no VIES-checked VAT ID, so unlike
 * resolveTaxContext the EU bucket assumes the B2B customer will supply one.
 */
export function resolveVatRegion(
  countrycode: string | null | undefined
): VatRegion {
  const raw = (countrycode || '').trim();
  if (!raw) {
    return 'nl';
  }

  let iso = COUNTRY_NAME_TO_ISO[raw.toLowerCase()] || '';
  if (!iso && /^[A-Za-z]{2}$/.test(raw)) {
    iso = raw.toUpperCase();
  }

  if (!iso) {
    return 'nl';
  }
  if (iso === sellerCountry()) {
    return 'nl';
  }
  if (euCountryCodes.includes(iso)) {
    return 'eu';
  }
  if (KNOWN_NON_EU_ISO.includes(iso)) {
    return 'world';
  }
  return 'nl';
}

export function quotationVatContext(
  countrycode: string | null | undefined
): QuotationVatContext {
  const region = resolveVatRegion(countrycode);
  if (region === 'eu') {
    return { region, rate: 0, reverseCharge: true };
  }
  if (region === 'world') {
    return { region, rate: 0, reverseCharge: false };
  }
  return { region, rate: 21, reverseCharge: false };
}
