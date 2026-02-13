/**
 * Central font configuration — single source of truth for all fonts used
 * across the card designer, PDF templates, EJS partials, and the reseller API.
 *
 * NOTE: The Google Fonts <link> in the Angular frontend's index.html must stay
 * hardcoded (it must load before Angular boots). Keep it in sync manually.
 */

export interface FontConfig {
  family: string;
  displayName: string;
  defaultSize: string;
  yearSize: string;
  googleFontName: string;
  googleFontWeights: string;
}

export const FONTS: FontConfig[] = [
  { family: 'Arial, sans-serif', displayName: 'Arial (Classic)', defaultSize: '16px', yearSize: '44px', googleFontName: '', googleFontWeights: '' },
  { family: 'Oswald, Arial, sans-serif', displayName: 'Oswald (Modern)', defaultSize: '15px', yearSize: '42px', googleFontName: 'Oswald', googleFontWeights: '400;700' },
  { family: 'Fredoka, Arial, sans-serif', displayName: 'Fredoka (Rounded)', defaultSize: '15px', yearSize: '40px', googleFontName: 'Fredoka', googleFontWeights: '400;700' },
  { family: 'Caveat, Arial, cursive', displayName: 'Caveat (Handwritten)', defaultSize: '18px', yearSize: '44px', googleFontName: 'Caveat', googleFontWeights: '400;700' },
  { family: 'Righteous, Arial, sans-serif', displayName: 'Righteous (Retro)', defaultSize: '15px', yearSize: '42px', googleFontName: 'Righteous', googleFontWeights: '400' },
  { family: 'Alfa Slab One, Arial, serif', displayName: 'Alfa Slab One (Bold)', defaultSize: '14px', yearSize: '38px', googleFontName: 'Alfa Slab One', googleFontWeights: '400' },
  { family: 'Lato, Arial, sans-serif', displayName: 'Lato (Professional)', defaultSize: '16px', yearSize: '44px', googleFontName: 'Lato', googleFontWeights: '400;700' },
  { family: 'Playfair Display, Arial, serif', displayName: 'Playfair (Elegant)', defaultSize: '15px', yearSize: '40px', googleFontName: 'Playfair Display', googleFontWeights: '400;700' },
  { family: 'Bebas Neue, Arial, sans-serif', displayName: 'Bebas Neue (Tall)', defaultSize: '18px', yearSize: '46px', googleFontName: 'Bebas Neue', googleFontWeights: '400' },
  { family: 'Pacifico, Arial, cursive', displayName: 'Pacifico (Casual)', defaultSize: '14px', yearSize: '36px', googleFontName: 'Pacifico', googleFontWeights: '400' },
  { family: 'Dancing Script, Arial, cursive', displayName: 'Dancing Script (Flowing)', defaultSize: '16px', yearSize: '38px', googleFontName: 'Dancing Script', googleFontWeights: '400;700' },
  { family: 'Sofia, Arial, cursive', displayName: 'Sofia (Elegant)', defaultSize: '16px', yearSize: '44px', googleFontName: 'Sofia', googleFontWeights: '400' },
  { family: '"Fira Sans", Arial, sans-serif', displayName: 'Fira Sans (Extra Bold)', defaultSize: '15px', yearSize: '42px', googleFontName: 'Fira Sans', googleFontWeights: '400;700' },
  { family: 'Ubuntu, Arial, sans-serif', displayName: 'Ubuntu (Clean)', defaultSize: '16px', yearSize: '44px', googleFontName: 'Ubuntu', googleFontWeights: '400;700' },
  { family: 'Teko, Arial, sans-serif', displayName: 'Teko (Athletic)', defaultSize: '18px', yearSize: '44px', googleFontName: 'Teko', googleFontWeights: '300;400;500;600;700' },
];

/**
 * Look up the year font size for a given selectedFont CSS string.
 * Falls back to 44px (the default) if no match is found.
 */
export function getYearFontSize(selectedFont: string): string {
  if (!selectedFont) return '44px';
  const match = FONTS.find((f) => selectedFont.includes(f.googleFontName) && f.googleFontName !== '');
  return match ? match.yearSize : '44px';
}

/**
 * Look up the Google Font weight string for a given selectedFont CSS string.
 * Returns e.g. '400;700'. Falls back to '400;700' if no match.
 */
export function getGoogleFontWeights(selectedFont: string): string {
  if (!selectedFont) return '400;700';
  const match = FONTS.find((f) => selectedFont.includes(f.googleFontName) && f.googleFontName !== '');
  return match ? match.googleFontWeights : '400;700';
}
