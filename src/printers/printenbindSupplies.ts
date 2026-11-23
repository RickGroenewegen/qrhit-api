import { PbCustomerInfo } from './printenbindV2Request';

/**
 * Packing supplies ordered from Print&Bind for our own use: the paper band
 * round a stack of cards and the round sticker that closes it. One order
 * holds both. It has nothing to do with a customer order (no Payment, no
 * printer pass); the bulk actions' "Order bands & stickers" form calculates
 * and places it through PrintEnBindV2.calculateSupplies / orderSupplies.
 *
 * Print&Bind prints no strip narrower than 50 mm (60 mm on plain paper), so
 * the bands come six next to each other on an A4 that we cut ourselves:
 * 6 x 35 mm = 210 mm, each band 297 mm long. A stack of 60x60 cards that is
 * 2, 3 or 4 cm high has a girth of 160, 180 or 200 mm, so every height
 * leaves an overlap for the sticker.
 */
export const BANDS_PER_SHEET = 6;
export const BAND_WIDTH_MM = 35;
export const BAND_LENGTH_MM = 297;
export const STICKER_DIAMETER_MM = 30;
export const SUPPLIES_MAX_QUANTITY = 20000;

export const SUPPLIES_FILES = {
  band: 'supplies/band-a4.pdf',
  sticker: 'supplies/sticker-30mm.pdf',
  bandPreview: 'supplies/band-a4.png',
  stickerPreview: 'supplies/sticker-30mm.png',
};

export type SupplyKind = 'bands' | 'stickers';

export interface SuppliesQuantities {
  bands: number;
  stickers: number;
}

export interface SuppliesQuoteLine {
  kind: SupplyKind;
  /** What was asked for: bands or stickers */
  quantity: number;
  /** What Print&Bind prints: A4 sheets or stickers */
  printed: number;
  /** Per printed piece, ex VAT, rounded to cents by Print&Bind */
  unitPrice: number;
}

export interface SuppliesQuote {
  /** Everything ex VAT: the articles, handling and delivery */
  total: number;
  delivery: number;
  /** The articles with Print&Bind's handling fee: total minus delivery */
  goods: number;
  vat: number;
  totalInclVat: number;
  deliveryMethod: string;
  deliveryAt: string | null;
  lines: SuppliesQuoteLine[];
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** A4 sheets needed for this many bands. */
export function bandSheets(bands: number): number {
  return Math.ceil(Math.max(0, bands) / BANDS_PER_SHEET);
}

/**
 * Null when the quantities can be ordered, otherwise what is wrong with
 * them.
 */
export function suppliesQuantitiesError(input: any): string | null {
  for (const kind of ['bands', 'stickers'] as SupplyKind[]) {
    const value = input?.[kind];
    if (!Number.isInteger(value) || value < 0) {
      return `${kind} must be a whole number of 0 or more`;
    }
    if (value > SUPPLIES_MAX_QUANTITY) {
      return `${kind} cannot be more than ${SUPPLIES_MAX_QUANTITY}`;
    }
  }
  if (input.bands === 0 && input.stickers === 0) {
    return 'Order at least one band or one sticker';
  }
  return null;
}

/**
 * The Print&Bind articles for these quantities, in the order bands,
 * stickers; a quantity of 0 leaves its article out. `fileUrls` are the
 * public URLs of the print files; without them the articles can still be
 * calculated but not ordered.
 */
export function suppliesArticles(
  quantities: SuppliesQuantities,
  fileUrls?: { band: string; sticker: string }
): { kind: SupplyKind; quantity: number; article: Record<string, any> }[] {
  const file = (url?: string) =>
    url
      ? { add_file_method: 'url', file_url: url, file_overwrite: true }
      : {};
  const result: {
    kind: SupplyKind;
    quantity: number;
    article: Record<string, any>;
  }[] = [];

  if (quantities.bands > 0) {
    result.push({
      kind: 'bands',
      quantity: quantities.bands,
      article: {
        product: 'flyer',
        size: 'a4',
        color: 'all',
        printside: 'single',
        // 170 g glossy: the cheapest paper that still looks like packaging
        papertype: 'mc_170',
        finishing_extra: 'none',
        finishing2: 'none',
        check_doc: false,
        // The bands fill the sheet edge to edge
        borderless: true,
        number: bandSheets(quantities.bands),
        comment: `QRSong! bands, ${BANDS_PER_SHEET} per sheet. Please do not cut: we cut them ourselves.`,
        ...file(fileUrls?.band),
      },
    });
  }

  if (quantities.stickers > 0) {
    result.push({
      kind: 'stickers',
      quantity: quantities.stickers,
      article: {
        product: 'sticker-rond',
        size: 'o30',
        papertype: 'sticker_paper',
        cutting: 'sheet',
        coating: 'none',
        fullscreen: false,
        check_doc: false,
        number: quantities.stickers,
        copies: 1,
        ...file(fileUrls?.sticker),
      },
    });
  }

  return result;
}

/**
 * The delivery address the form starts with: our own, the sender on our
 * PostNL labels.
 */
export function suppliesDefaultAddress(
  env: Record<string, string | undefined> = process.env
): PbCustomerInfo {
  return {
    fullname: env['SUPPLIES_CONTACT'] || 'Rick Groenewegen',
    company: env['POSTNL_SENDER_COMPANY'] || 'QRSong!',
    email: env['SUPPLIES_EMAIL'] || 'info@qrsong.io',
    address: env['POSTNL_SENDER_STREET'] || '',
    housenumber: `${env['POSTNL_SENDER_HOUSENR'] || ''}${
      env['POSTNL_SENDER_HOUSENR_EXT'] || ''
    }`,
    zipcode: env['POSTNL_SENDER_ZIPCODE'] || '',
    city: env['POSTNL_SENDER_CITY'] || '',
    countrycode: env['POSTNL_SENDER_COUNTRYCODE'] || 'NL',
  };
}

/** Null when the address is complete, otherwise the first field missing. */
export function suppliesAddressError(address: any): string | null {
  const required: [keyof PbCustomerInfo, string][] = [
    ['fullname', 'contact name'],
    ['address', 'street'],
    ['housenumber', 'house number'],
    ['zipcode', 'postal code'],
    ['city', 'city'],
    ['countrycode', 'country'],
  ];
  for (const [field, label] of required) {
    if (typeof address?.[field] !== 'string' || !address[field].trim()) {
      return `The delivery address has no ${label}`;
    }
  }
  return null;
}

/**
 * Reads the purchase price from Print&Bind's order resource (the answer of
 * `/orders/calculate` and of `/orders`). `amount` is the whole order ex VAT
 * with delivery and handling in it; an article's `amount` is the price per
 * printed piece rounded to cents, too coarse to add up (500 stickers at
 * 4.6 ct read as 5 ct), so the lines carry the unit price only.
 */
export function suppliesQuote(
  order: any,
  articles: { kind: SupplyKind; quantity: number; article: Record<string, any> }[]
): SuppliesQuote {
  const total = Number(order?.amount) || 0;
  const delivery = Number(order?.delivery_amount) || 0;
  const vat =
    (Number(order?.amount_tax_standard) || 0) +
    (Number(order?.amount_tax_reduced) || 0);

  const lines: SuppliesQuoteLine[] = articles.map((entry, index) => {
    const unitPrice = Number(order?.articles?.[index]?.amount) || 0;
    const printed = Number(entry.article['number']) || 0;
    return {
      kind: entry.kind,
      quantity: entry.quantity,
      printed,
      unitPrice,
    };
  });

  return {
    total: round2(total),
    delivery: round2(delivery),
    goods: round2(total - delivery),
    vat: round2(vat),
    totalInclVat: round2(total + vat),
    deliveryMethod: String(order?.delivery_method || ''),
    deliveryAt: order?.delivery_at || null,
    lines,
  };
}
