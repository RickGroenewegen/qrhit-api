/**
 * Central background configuration — single source of truth for all preset
 * card backgrounds used in the card designer and the reseller API.
 *
 * The actual image files live in the Angular frontend's
 * src/assets/images/card_backgrounds/ directory.
 */

export interface BackgroundConfig {
  id: number;
  filename: string;
  thumbnailFilename: string;
}

export const BACKGROUNDS: BackgroundConfig[] = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  filename: `background${i + 1}.png`,
  thumbnailFilename: `background${i + 1}_thumb.png`,
}));

/**
 * Returns backgrounds with full URLs suitable for external consumers (reseller API).
 * Thumbnail URLs point into the thumbnails/ subfolder.
 * When mediaIds is provided, each entry also includes its database media ID.
 */
export function getBackgroundsWithUrls(
  frontendUrl: string,
  mediaIds?: Map<string, number>,
) {
  const base = `${frontendUrl}/assets/images/card_backgrounds`;
  return BACKGROUNDS.map((bg) => ({
    mediaId: mediaIds?.get(bg.filename) ?? 0,
    thumbnail: `${base}/thumbnails/${bg.thumbnailFilename}`,
    full: `${base}/${bg.filename}`,
  }));
}
