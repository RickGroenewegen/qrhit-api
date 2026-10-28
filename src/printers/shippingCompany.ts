/**
 * The company to put on the shipping label of a Print&Bind order: the
 * company name typed at checkout, only when the order is a business order.
 * The checkout keeps a typed company name when the customer switches back to
 * a personal order, so `companyName` alone does not mean the customer wants
 * it on the parcel. A company on the label matters most in Germany, where a
 * parcel for a business address that names only a person may not be
 * delivered.
 */
export function shippingCompany(payment: {
  isBusinessOrder?: boolean | null;
  companyName?: string | null;
}): string | undefined {
  if (!payment.isBusinessOrder) return undefined;
  return payment.companyName?.trim() || undefined;
}
