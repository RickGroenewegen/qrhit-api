/**
 * The card design a featured playlist's product page draws its cards with,
 * or null for the standard design.
 *
 * `design` is the design the first buyer ordered with, so it can carry
 * personal photos, names or just something nobody else wants to look at. Two
 * people get a say, and either can keep it off the page:
 *
 * - the customer, on the featured playlist form (`promotionalShareDesign`,
 *   true by default for curated lists and submissions from before the
 *   question existed);
 * - an admin, with the "Own design" switch on the Featured page
 *   (`featuredDesignHidden`). It is a column of its own so the customer
 *   re-saving the form cannot undo it.
 *
 * In its own module because spotify.ts (the product page lookup) needs it and
 * data/featuredPlaylists.ts already imports spotify.ts.
 */
export function productPageDesign(playlist: {
  design?: unknown;
  promotionalShareDesign?: boolean | null;
  featuredDesignHidden?: boolean | null;
}): unknown | null {
  if (!playlist.design) return null;
  if (playlist.promotionalShareDesign === false) return null;
  if (playlist.featuredDesignHidden) return null;
  return playlist.design;
}
