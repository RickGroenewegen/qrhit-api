import PrismaInstance from './prisma';

/**
 * The personal how-to page, www.qrsong.io/how-to/<list slug> (built
 * 2026-11-11, Medienwerft): the site's game explanation in the look of a
 * business deck's app theme. The slug is the company list's own (the one the
 * voting page uses, /v/<slug>), and the theme is the one an admin put on the
 * list's order line (`payment_has_playlist.theme`, `qrsong theme set`), so
 * the page follows every `theme push` the same way the scanned cards do.
 *
 * A list reaches its order through `company_lists.paymentId`, which the
 * toolkit sets (`qquote list update --link-order`, the `orderId` field of
 * PUT /business/companies/:id/lists/:listId/info). Toolkit orders are booked
 * on Rick's account, so nothing else ties a list to its cards.
 *
 * Only the admin-assigned theme counts, never an App Designer design: the
 * order is on Rick's account, and his own designs must not show up on a
 * company's page.
 */

const LIST_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidListSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && LIST_SLUG.test(slug);
}

export interface HowtoLine {
  id: number;
  theme: string | null;
  themeName: string | null;
}

/**
 * The theme of a list's order: the first line (lowest id) that has one.
 * A business order has one line; a second line without a theme (a sample
 * set, a reprint) must not hide the first one's.
 */
export function pickLineTheme(lines: readonly HowtoLine[]): { slug: string; name: string } | null {
  const line = [...lines]
    .sort((a, b) => a.id - b.id)
    .find((l) => typeof l.theme === 'string' && l.theme.trim() !== '');
  if (!line) return null;
  const slug = line.theme!.trim();
  return { slug, name: (line.themeName || '').trim() || slug };
}

/**
 * The `orderId` field of the list info route: our order number (100009357),
 * as a string or a number, or null / '' to clear the link.
 */
export function parseOrderNumber(value: unknown): { orderId: string | null } | { error: string } {
  if (value === null || value === '') return { orderId: null };
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : null;
  if (text === null || !/^\d{6,12}$/.test(text)) {
    return { error: 'orderId must be our order number (digits, e.g. 100009357) or null' };
  }
  return { orderId: text };
}

/** The payments.id behind an order number for the list info route, or why not. */
export async function linkedPaymentId(
  value: unknown
): Promise<{ paymentId: number | null } | { error: string; status: number }> {
  const parsed = parseOrderNumber(value);
  if ('error' in parsed) return { error: parsed.error, status: 400 };
  if (parsed.orderId === null) return { paymentId: null };
  const payment = await PrismaInstance.getInstance().payment.findFirst({
    where: { orderId: parsed.orderId },
    select: { id: true },
  });
  if (!payment) return { error: `No order ${parsed.orderId}`, status: 404 };
  return { paymentId: payment.id };
}

/** The theme slug for a list slug, or null when the list, its order or a theme is missing. */
export async function resolveListTheme(listSlug: string): Promise<{ slug: string; name: string } | null> {
  if (!isValidListSlug(listSlug)) return null;
  const prisma = PrismaInstance.getInstance();
  const list = await prisma.companyList.findFirst({
    where: { slug: listSlug },
    select: { paymentId: true },
  });
  if (!list?.paymentId) return null;
  const lines = await prisma.paymentHasPlaylist.findMany({
    where: { paymentId: list.paymentId },
    select: { id: true, theme: true, themeName: true },
  });
  return pickLineTheme(lines);
}
