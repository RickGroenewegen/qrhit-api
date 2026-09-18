/**
 * Which locales a featured playlist's product page is INDEXABLE in.
 *
 * `featuredLocale` is null for an international list, one code ("de") or a
 * comma-separated list ("de,nl") for a list aimed at those markets. The
 * product page still renders in every locale, because a German visitor
 * browsing the English site has to be able to open a German list without the
 * site switching language on them. What the locale decides is where search
 * engines are pointed:
 *
 * - international list: every locale (returns null, "no restriction");
 * - locale-specific list: its own locales plus always `en`, the version any
 *   visitor can fall back on. Those are the locales that get the sitemap
 *   entry and the hreflang cluster; the SSR server marks the other locales
 *   `noindex, follow`.
 *
 * In its own module because both data/misc.ts (sitemap) and
 * data/featuredPlaylists.ts (the gate the SSR server asks) need it, and the
 * latter already imports the former.
 */
export const ALWAYS_INDEXABLE_LOCALE = 'en';

export function productPageLocales(
  featuredLocale: string | null | undefined,
  validLocales: string[]
): string[] | null {
  const pinned = (featuredLocale ?? '')
    .split(',')
    .map((code) => code.trim().toLowerCase())
    .filter((code) => code && validLocales.includes(code));

  // Nothing usable in the column reads as "international" rather than as
  // "indexable nowhere": a typo must not take a product out of the sitemap.
  if (pinned.length === 0) return null;

  return [...new Set([...pinned, ALWAYS_INDEXABLE_LOCALE])];
}

/** True when `locale` should list and index this playlist's product page. */
export function isProductPageIndexable(
  featuredLocale: string | null | undefined,
  locale: string,
  validLocales: string[]
): boolean {
  const locales = productPageLocales(featuredLocale, validLocales);
  return locales === null || locales.includes(locale);
}
