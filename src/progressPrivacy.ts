/**
 * What GET /progress may still say about the buyer.
 *
 * The route is keyed on the payment id alone, because the checkout's
 * progress page and the scan app's done screen open it right after paying,
 * with nothing else in hand. That id travels (the return URL, mail links,
 * logs, analytics), so the answer must not stay a way to a customer's name
 * and address for good:
 *
 * - name, e-mail and addresses: the first 24 hours after the order was made,
 *   which is when the progress page shows them;
 * - the account hash (it opens the download and the corrections pages): until
 *   24 hours after the order was finalized, because the app's done screen
 *   builds its PDF link from it and a year check can take a while; a week at
 *   most for an order that never gets finalized.
 *
 * After that the answer keeps the order's state, lines and totals.
 */
const HOUR_MS = 60 * 60 * 1000;
const PERSONAL_WINDOW_MS = 24 * HOUR_MS;
const HASH_AFTER_FINALIZED_MS = 24 * HOUR_MS;
const HASH_UNFINALIZED_MS = 7 * 24 * HOUR_MS;

const PERSONAL_FIELDS = [
  'fullname',
  'email',
  'address',
  'housenumber',
  'city',
  'zipcode',
  'invoiceAddress',
  'invoiceHousenumber',
  'invoiceCity',
  'invoiceZipcode',
  'invoiceCountrycode',
  'differentInvoiceAddress',
];

function time(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const ms = new Date(value as any).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function limitProgressData<T extends { payment: Record<string, any>; userHash?: string | null }>(
  data: T,
  now: number = Date.now()
): T {
  const created = time(data.payment['createdAt']);
  const finalized = time(data.payment['finalizedAt']);

  // No creation date means no window can be shown to be open
  const personalOpen = created !== null && now - created < PERSONAL_WINDOW_MS;
  const hashOpen =
    personalOpen ||
    (finalized !== null
      ? now - finalized < HASH_AFTER_FINALIZED_MS
      : created !== null && now - created < HASH_UNFINALIZED_MS);

  const payment: Record<string, any> = { ...data.payment };
  delete payment['finalizedAt'];
  if (!personalOpen) {
    for (const field of PERSONAL_FIELDS) delete payment[field];
  }
  if (!hashOpen) delete payment['userHash'];

  return { ...data, payment, userHash: hashOpen ? data.userHash ?? null : null };
}
