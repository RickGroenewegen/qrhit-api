/**
 * Customers name a competitor in their own playlist titles and descriptions;
 * whatever we publish from them says QRSong! instead.
 */
export function sanitizeBrandName(text: string): string {
  return text.replace(/hitster/gi, 'QRSong!');
}
