/**
 * The VAT rate an order was charged at, for backing its ex-VAT turnover out of
 * `totalPrice` (setPaymentInfo in both Print&Bind integrations). That is the
 * rate checkout stored on the payment, not the standard rate of its country:
 * reverse charge (an EU business with a VAT ID that VIES confirmed) and export
 * are charged 0%. Taking the country rate booked a German B2B order of €42.02
 * as €35.31 ex VAT (order 100009253, October 2026), so the tax report and the
 * MoneyBird invoice it feeds missed the difference. Payments without a stored
 * rate fall back to the country's rate, as before.
 */
export async function paymentTaxRate(
  payment: { taxRate?: number | null; countrycode?: string | null },
  data: { getTaxRate(countryCode: string): Promise<number | null> }
): Promise<number> {
  if (typeof payment.taxRate === 'number' && Number.isFinite(payment.taxRate)) {
    return payment.taxRate;
  }
  return (await data.getTaxRate(payment.countrycode || 'NL')) ?? 0;
}
