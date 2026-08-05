/**
 * Central font configuration — single source of truth for all fonts used
 * across the card designer, PDF templates, EJS partials, and the reseller API.
 *
 * NOTE: The Google Fonts <link> in the Angular frontend's index.html must stay
 * hardcoded (it must load before Angular boots). Keep it in sync manually.
 */

export interface FontConfig {
  /**
   * Stable identifier for this option. Also the id the reseller API exposes
   * and accepts. Usually equal to googleFontName, but weight variants of the
   * same Google family need their own id (e.g. 'Roboto Condensed Bold').
   * Arial keeps the empty id documented in docs/reseller.md.
   */
  id: string;
  family: string;
  displayName: string;
  defaultSize: string;
  yearSize: string;
  googleFontName: string;
  googleFontWeights: string;
  /**
   * CSS font-weight for the card text. Only set on weight variants; when it is
   * absent the templates leave the weight alone.
   *
   * Google Fonts has no separate family for a bold cut, so a variant lists a
   * private alias first in `family` purely to keep `selectedFont` unique per
   * option. The alias never resolves — the real family right after it does —
   * and this weight is what actually renders the text bold.
   */
  fontWeight?: string;
}

export const FONTS: FontConfig[] = [
  { id: '', family: 'Arial, sans-serif', displayName: 'Arial (Classic)', defaultSize: '16px', yearSize: '44px', googleFontName: '', googleFontWeights: '' },
  { id: 'Oswald', family: 'Oswald, Arial, sans-serif', displayName: 'Oswald (Modern)', defaultSize: '15px', yearSize: '42px', googleFontName: 'Oswald', googleFontWeights: '400;700' },
  { id: 'Fredoka', family: 'Fredoka, Arial, sans-serif', displayName: 'Fredoka (Rounded)', defaultSize: '15px', yearSize: '40px', googleFontName: 'Fredoka', googleFontWeights: '400;700' },
  { id: 'Caveat', family: 'Caveat, Arial, cursive', displayName: 'Caveat (Handwritten)', defaultSize: '18px', yearSize: '44px', googleFontName: 'Caveat', googleFontWeights: '400;700' },
  { id: 'Righteous', family: 'Righteous, Arial, sans-serif', displayName: 'Righteous (Retro)', defaultSize: '15px', yearSize: '42px', googleFontName: 'Righteous', googleFontWeights: '400' },
  { id: 'Alfa Slab One', family: 'Alfa Slab One, Arial, serif', displayName: 'Alfa Slab One (Bold)', defaultSize: '14px', yearSize: '38px', googleFontName: 'Alfa Slab One', googleFontWeights: '400' },
  { id: 'Lato', family: 'Lato, Arial, sans-serif', displayName: 'Lato (Professional)', defaultSize: '16px', yearSize: '44px', googleFontName: 'Lato', googleFontWeights: '400;700' },
  { id: 'Playfair Display', family: 'Playfair Display, Arial, serif', displayName: 'Playfair (Elegant)', defaultSize: '15px', yearSize: '40px', googleFontName: 'Playfair Display', googleFontWeights: '400;700' },
  { id: 'Bebas Neue', family: 'Bebas Neue, Arial, sans-serif', displayName: 'Bebas Neue (Tall)', defaultSize: '18px', yearSize: '46px', googleFontName: 'Bebas Neue', googleFontWeights: '400' },
  { id: 'Pacifico', family: 'Pacifico, Arial, cursive', displayName: 'Pacifico (Casual)', defaultSize: '14px', yearSize: '36px', googleFontName: 'Pacifico', googleFontWeights: '400' },
  { id: 'Dancing Script', family: 'Dancing Script, Arial, cursive', displayName: 'Dancing Script (Flowing)', defaultSize: '16px', yearSize: '38px', googleFontName: 'Dancing Script', googleFontWeights: '400;700' },
  { id: 'Sofia', family: 'Sofia, Arial, cursive', displayName: 'Sofia (Elegant)', defaultSize: '16px', yearSize: '44px', googleFontName: 'Sofia', googleFontWeights: '400' },
  { id: 'Fira Sans', family: '"Fira Sans", Arial, sans-serif', displayName: 'Fira Sans (Extra Bold)', defaultSize: '15px', yearSize: '42px', googleFontName: 'Fira Sans', googleFontWeights: '400;700' },
  { id: 'Ubuntu', family: 'Ubuntu, Arial, sans-serif', displayName: 'Ubuntu (Clean)', defaultSize: '16px', yearSize: '44px', googleFontName: 'Ubuntu', googleFontWeights: '400;700' },
  { id: 'Teko', family: 'Teko, Arial, sans-serif', displayName: 'Teko (Athletic)', defaultSize: '18px', yearSize: '44px', googleFontName: 'Teko', googleFontWeights: '300;400;500;600;700' },
  { id: 'Montserrat', family: 'Montserrat, Arial, sans-serif', displayName: 'Montserrat (Geometric)', defaultSize: '15px', yearSize: '42px', googleFontName: 'Montserrat', googleFontWeights: '400;700' },
  { id: 'Roboto Condensed', family: '"Roboto Condensed", Arial, sans-serif', displayName: 'Roboto Condensed (Compact)', defaultSize: '15px', yearSize: '42px', googleFontName: 'Roboto Condensed', googleFontWeights: '400;700' },
  { id: 'Roboto Condensed Bold', family: '"Roboto Condensed Bold", "Roboto Condensed", Arial, sans-serif', displayName: 'Roboto Condensed Bold (Compact)', defaultSize: '15px', yearSize: '42px', googleFontName: 'Roboto Condensed', googleFontWeights: '400;700', fontWeight: '700' },
  { id: 'Raleway', family: 'Raleway, Arial, sans-serif', displayName: 'Raleway (ExtraBold/Black)', defaultSize: '15px', yearSize: '42px', googleFontName: 'Raleway', googleFontWeights: '400;700;800;900' },
];

/**
 * Resolve a selectedFont CSS string back to its FontConfig.
 *
 * Exact family match first, then the leading family name against the id —
 * both needed so weight variants that share a googleFontName ('Roboto
 * Condensed' vs 'Roboto Condensed Bold') resolve to the right entry. The
 * substring pass at the end keeps older/looser stored values working.
 */
export function findFont(selectedFont: string): FontConfig | undefined {
  if (!selectedFont) return undefined;

  const exact = FONTS.find((f) => f.family === selectedFont);
  if (exact) return exact;

  const leadingFamily = selectedFont.split(',')[0].trim().replace(/["']/g, '');
  const byId = FONTS.find((f) => f.id !== '' && f.id === leadingFamily);
  if (byId) return byId;

  return FONTS.find((f) => f.googleFontName !== '' && selectedFont.includes(f.googleFontName));
}

/**
 * Look up the year font size for a given selectedFont CSS string.
 * Falls back to 44px (the default) if no match is found.
 */
export function getYearFontSize(selectedFont: string): string {
  return findFont(selectedFont)?.yearSize ?? '44px';
}

/**
 * Look up the Google Font weight string for a given selectedFont CSS string.
 * Returns e.g. '400;700'. Falls back to '400;700' if no match.
 */
export function getGoogleFontWeights(selectedFont: string): string {
  return findFont(selectedFont)?.googleFontWeights || '400;700';
}

/**
 * Real Google Fonts family name to request for a selectedFont CSS string.
 * Templates cannot derive this from the string itself, because a weight
 * variant leads with a private alias that Google does not know.
 */
export function getGoogleFontName(selectedFont: string): string {
  const match = findFont(selectedFont);
  if (match) return match.googleFontName;
  return selectedFont ? selectedFont.split(',')[0].trim().replace(/["']/g, '') : '';
}

/**
 * CSS font-weight to render card text with, or '' when the font carries no
 * explicit weight (templates then leave font-weight untouched).
 */
export function getFontWeight(selectedFont: string): string {
  return findFont(selectedFont)?.fontWeight ?? '';
}
