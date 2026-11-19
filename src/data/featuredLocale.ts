/**
 * `playlists.featuredLocale`: null for a list shown on every language page,
 * else the languages it is for as a comma list ("de", "de,tr"). The first one
 * is the language the site's playlist badge shows. The admin's edit form
 * (dashboard/featured) ticks several since 2026-11-18; before, it set one.
 */

/** The admin's value as stored: trimmed, lower case, no repeats, order kept; null for none. */
export function normalizeFeaturedLocale(value: unknown): string | null {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(',');
  const codes = parts
    .map((code) => String(code).trim().toLowerCase())
    .filter((code) => /^[a-z]{2}$/.test(code));
  const unique = [...new Set(codes)];
  return unique.length ? unique.join(',') : null;
}

/**
 * A Prisma filter for the playlists tagged with `locale`, alone or among
 * others. The admin's language filter compared the whole value, so a list
 * tagged "de,tr" was missing under both German and Turkish. The spaced form
 * ("de, tr") is matched too, for values written by hand.
 */
export function featuredLocaleWhere(locale: string) {
  return {
    OR: [
      { featuredLocale: locale },
      { featuredLocale: { startsWith: `${locale},` } },
      { featuredLocale: { endsWith: `,${locale}` } },
      { featuredLocale: { endsWith: `, ${locale}` } },
      { featuredLocale: { contains: `,${locale},` } },
      { featuredLocale: { contains: `, ${locale},` } },
    ],
  };
}
