/**
 * Delivery address of a business order (Rick, 2026-10-05).
 *
 * A company has a default delivery address (separate from its own address:
 * a reseller like By Acte is invoiced in Mierlo but delivers to its client).
 * A list uses that default unless `useCompanyDeliveryAddress` is switched off
 * in the list settings; then the list's own delivery fields apply. The printer
 * order e-mail ships the client's boxes to this address.
 */

export const DELIVERY_FIELDS = [
  'deliveryName',
  'deliveryAddress',
  'deliveryHousenumber',
  'deliveryZipcode',
  'deliveryCity',
  'deliveryCountrycode',
  'deliveryPhone',
] as const;

export type DeliveryField = (typeof DELIVERY_FIELDS)[number];
export type DeliveryFields = Partial<Record<DeliveryField, string | null>>;

export interface EffectiveDeliveryAddress {
  source: 'company' | 'list';
  /** "t.a.v." line: person or department to deliver to. */
  name: string | null;
  /** Street + number, postcode + city, country (when not NL): ready for a label or a mail. */
  lines: string[];
  phone: string | null;
}

const clean = (v: string | null | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** True when the fields hold at least a street and a city (enough to deliver to). */
export function hasDeliveryAddress(f: DeliveryFields | null | undefined): boolean {
  return !!(f && clean(f.deliveryAddress) && clean(f.deliveryCity));
}

/** The address lines of one set of delivery fields; the country only when it is not NL. */
export function deliveryLines(f: DeliveryFields): string[] {
  const street = [clean(f.deliveryAddress), clean(f.deliveryHousenumber)].filter(Boolean).join(' ');
  const place = [clean(f.deliveryZipcode), clean(f.deliveryCity)].filter(Boolean).join(' ');
  const country = clean(f.deliveryCountrycode)?.toUpperCase();
  return [street, place, country && country !== 'NL' ? country : null].filter((l): l is string => !!l);
}

/**
 * Where a list's boxes go: the company's default, or the list's own address
 * when the list has `useCompanyDeliveryAddress` off. Null when that address is
 * still empty.
 */
export function effectiveDeliveryAddress(
  company: DeliveryFields | null | undefined,
  list: (DeliveryFields & { useCompanyDeliveryAddress?: boolean | null }) | null | undefined
): EffectiveDeliveryAddress | null {
  const useCompany = list?.useCompanyDeliveryAddress !== false;
  const source: 'company' | 'list' = useCompany ? 'company' : 'list';
  const f = useCompany ? company : list;
  if (!f || !hasDeliveryAddress(f)) return null;
  return { source, name: clean(f.deliveryName), lines: deliveryLines(f), phone: clean(f.deliveryPhone) };
}

/** Only the delivery fields of a request body, trimmed; '' becomes null. Non-strings are ignored. */
export function pickDeliveryFields(body: Record<string, unknown>): DeliveryFields {
  const out: DeliveryFields = {};
  for (const key of DELIVERY_FIELDS) {
    const v = body[key];
    if (v === null) out[key] = null;
    else if (typeof v === 'string') out[key] = v.trim() || null;
  }
  if (typeof out.deliveryCountrycode === 'string') out.deliveryCountrycode = out.deliveryCountrycode.toUpperCase();
  return out;
}
