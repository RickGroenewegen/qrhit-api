import { CardDesign, IMAGE_FILENAME, sanitizeCardDesign } from '../cardDesigns';
import { productPageDesign } from '../data/productPageDesign';

/**
 * The card design a playlist's product photo shows: the product page's rule
 * (productPageDesign), so a design the customer kept private or an admin
 * vetoed never reaches a photo, else the standard QRSong! design (no
 * pictures: the printer template then draws the brand artwork).
 */
export type ShowcaseDesignSource = 'playlist' | 'standard';

// Designs saved before the designer stored bare filenames only carry the
// picture's URL, e.g. https://api.qrsong.io/public/background/<file>.
const URL_FIELDS = [
  { field: 'background', urlField: 'backgroundImage', folder: 'background' },
  { field: 'backgroundBack', urlField: 'backgroundBackImage', folder: 'background' },
  { field: 'logo', urlField: 'logoImage', folder: 'logo' },
] as const;

function fileFromUrl(url: unknown, folder: string): string | null {
  if (typeof url !== 'string') return null;
  const match = url.match(new RegExp(`/public/${folder}/([^/?#]+)$`));
  return match && IMAGE_FILENAME.test(match[1]) ? match[1] : null;
}

export function showcaseDesign(playlist: {
  design?: unknown;
  promotionalShareDesign?: boolean | null;
  featuredDesignHidden?: boolean | null;
}): { design: CardDesign; source: ShowcaseDesignSource } {
  const shared = productPageDesign(playlist);
  if (!shared || typeof shared !== 'object') {
    return { design: sanitizeCardDesign({}), source: 'standard' };
  }
  const raw: Record<string, unknown> = { ...(shared as Record<string, unknown>) };
  for (const { field, urlField, folder } of URL_FIELDS) {
    if (!raw[field]) raw[field] = fileFromUrl(raw[urlField], folder);
  }
  return { design: sanitizeCardDesign(raw), source: 'playlist' };
}

/** The pictures a design draws, as paths under PUBLIC_DIR. */
export function designImages(design: CardDesign): string[] {
  const files = [
    design.background && `background/${design.background}`,
    design.backgroundBack && `background/${design.backgroundBack}`,
    design.logo && `logo/${design.logo}`,
    design.qrLogo && `logo/${design.qrLogo}`,
  ];
  return [...new Set(files.filter((file): file is string => !!file))];
}
