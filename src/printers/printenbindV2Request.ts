import { maxCardsFor } from '../config/constants';

/**
 * The request shapes printenbindV2.ts sends to Print&Bind's REST API, as
 * pure functions. They live apart from the class so the Print&Bind test
 * harness (scripts/pnb-harness) sends exactly what production sends, without
 * booting Prisma, Redis or the mailer.
 */

/**
 * `/orders/calculate` checks the postal code format for a handful of
 * countries (NL, BE, DE, FR, GB as of September 2026) and accepts anything
 * for the rest, so a shipping quote needs a well-formed code only for those.
 * NL is covered by the request builder's own placeholder address; the
 * others get a capital-city code here. The city is never checked.
 */
export const QUOTE_POSTCODES: Record<string, string> = {
  BE: '1000',
  DE: '10115',
  FR: '75001',
  GB: 'SW1A 1AA',
};

export interface PbCustomerInfo {
  fullname?: string;
  company?: string;
  email: string;
  address?: string;
  housenumber?: string;
  zipcode?: string;
  city?: string;
  countrycode: string;
}

/**
 * The internal game-card article for one physical deck (`losbladig`, 60x60
 * cards or A4 sheets). `item` is the playlist line: addHowToCard, subType,
 * boxEnabled, amount and paymentHasPlaylistId are read from it.
 */
export function gameCardsArticle(
  numberOfTracks: number,
  fileUrl: string,
  item: any,
  playlistItem: any = null
): any {
  let numberOfPages = numberOfTracks * 2;
  if (item.addHowToCard) {
    numberOfPages += 2;
  }

  // Safety ceiling on the page count we hand the printer. Derived from the
  // physical card cap (2 pages per card, front + back, plus the how-to
  // card) rather than a literal — it used to be a hardcoded 2000, which was
  // MAX_CARDS_PHYSICAL back when that was 1000, so raising the cap silently
  // under-printed every order above 1000 cards.
  const maxPages = maxCardsFor(false) * 2 + 2;
  if (numberOfPages > maxPages) {
    numberOfPages = maxPages;
  }

  // Calculate batch number with item index if available
  const batchNumber = playlistItem
    ? `${item.paymentHasPlaylistId}-${playlistItem.index}`
    : item.paymentHasPlaylistId;

  // When playlistItem exists, we're creating one order item per instance (amount=1)
  // When playlistItem is null (backward compatibility), use original amount
  const orderAmount = playlistItem ? 1 : item.amount;

  // Print&Bind's `losbladig` (loose page) product. `borderless` and
  // `check_doc` are explicit in the REST API; the values below are what
  // Print&Bind applied to our v1 orders (borderless for the 60x60 custom
  // size, standard file check), so the product and price stay the same.
  let orderObj: any = {
    type: 'physical',
    amount: orderAmount,
    product: 'losbladig',
    number: 1,
    copies: numberOfPages,
    color: 'all',
    size: 'custom',
    printside: 'double',
    finishing: 'loose',
    finishing2: 'none',
    finishing_extra: 'none',
    accessory_item: 'none',
    papertype: 'card',
    size_custom_width: 60,
    size_custom_height: 60,
    borderless: true,
    check_doc: false,
    add_file_method: 'url',
    file_overwrite: true,
    file_url: fileUrl,
    comment: `Batch nummer op de kaartjes (rechts onderin op kant met titel/artiest/jaar) moet #${batchNumber} zijn`,
  };

  if (item.subType == 'sheets') {
    orderObj.copies = Math.ceil(numberOfTracks / 12) * 2;
    orderObj.size = 'a4';
    orderObj.borderless = false;
    delete orderObj.size_custom_width;
    delete orderObj.size_custom_height;
    orderObj.comment =
      orderObj.comment +
      '. Deze bestelling is een A4 die door de klant zelf uitgeknipt zal gaan worden.';
  }

  // Print&Bind auto-adds a 2nd/3rd/… box for every 190 cards based on
  // the accessory line — we never specify a box quantity ourselves.
  if (item.boxEnabled) {
    orderObj.accessory_group = 'packaging';
    orderObj.accessory_item = 'box_qrsong';
  }

  return orderObj;
}

/**
 * The insert card of a box ordered on its own (box upgrade): a 120x120
 * `werkblad` that carries the box as its packaging accessory.
 */
export function boxUpgradeArticle(
  fileUrl: string,
  playlistName: string,
  pageCount: number
): any {
  return {
    type: 'physical',
    // The file is pre-multiplied (one front+back pair per purchased box),
    // same convention as boxInsertArticle: amount stays 1 and
    // copies equals the file's actual page count.
    amount: 1,
    product: 'werkblad',
    number: 1,
    copies: pageCount,
    color: 'all',
    size: 'custom',
    printside: 'double',
    finishing: 'loose',
    finishing2: 'none',
    finishing_extra: 'none',
    papertype: 'card',
    size_custom_width: 120,
    size_custom_height: 120,
    borderless: true,
    check_doc: false,
    add_file_method: 'url',
    file_overwrite: true,
    file_url: fileUrl,
    // Box ships as a packaging accessory on this insert-card article.
    accessory_group: 'packaging',
    accessory_item: 'box_qrsong',
    comment: `Box insert for playlist ${playlistName}`,
  };
}

/**
 * Generic insert-card article shape: the file already contains every page
 * that needs printing, so `amount` stays at 1 and `copies` equals the file's
 * actual page count. Used for both single-playlist (pre-multiplied source
 * file) and multi-playlist (merged file) cases.
 */
export function boxInsertArticle(
  fileUrl: string,
  pageCount: number,
  comment: string
): any {
  return {
    type: 'physical',
    amount: 1,
    product: 'werkblad',
    number: 1,
    copies: pageCount,
    color: 'all',
    size: 'custom',
    printside: 'double',
    finishing: 'loose',
    finishing2: 'none',
    finishing_extra: 'none',
    accessory_item: 'none',
    papertype: 'card',
    size_custom_width: 120,
    size_custom_height: 120,
    borderless: true,
    check_doc: false,
    add_file_method: 'url',
    file_overwrite: true,
    file_url: fileUrl,
    comment,
  };
}

/**
 * The order comment that tells the packer how many boxes go in the parcel:
 * an article carries one packaging accessory line whatever the box count.
 */
export function boxPackingComment(totalBoxes: number): string {
  return `LET OP: Deze order moet verpakt worden met in totaal ${totalBoxes} QRSong! ${
    totalBoxes === 1 ? 'doos' : 'dozen'
  }`;
}

/**
 * Convert an internal article (built by gameCardsArticle and the box
 * builders) into the REST article payload: internal routing fields are
 * stripped, v1-only article fields dropped, and numbers/booleans typed the
 * way the REST validation expects.
 */
export function toPbArticle(item: any): Record<string, any> {
  const {
    type: _type,
    amount: _amount,
    delivery_method: _deliveryMethod,
    delivery_option: _deliveryOption,
    payment_method: _paymentMethod,
    check_doc,
    borderless,
    number,
    copies,
    ...rest
  } = item;

  return {
    ...rest,
    number: parseInt(String(number), 10) || 1,
    copies: parseInt(String(copies), 10) || 1,
    // v1 took 'standard' here; in REST `true` requests the paid extended check
    check_doc: check_doc === true,
    borderless:
      borderless !== undefined ? Boolean(borderless) : rest.size === 'custom',
    add_inserts: false,
  };
}

/**
 * Build the REST `StoreOrderRequest`: address, delivery, production and the
 * articles. Field limits follow the API schema.
 */
export function buildOrderRequest(
  customerInfo: PbCustomerInfo,
  articles: Record<string, any>[],
  options: { fast: boolean; orderComment: string; reference?: string }
): Record<string, any> {
  const country = (customerInfo.countrycode || 'NL').toUpperCase();
  const request: Record<string, any> = {
    contact: (customerInfo.fullname?.trim() || 'John Doe').slice(0, 35),
    street: (customerInfo.address?.trim() || 'Some lane').slice(0, 95),
    number: (customerInfo.housenumber?.trim() || '1').slice(0, 35),
    postalcode: (customerInfo.zipcode?.trim() || '1234AB').slice(0, 17),
    city: (customerInfo.city?.trim() || 'Amsterdam').slice(0, 35),
    country,
    email: (customerInfo.email || 'john@doe.com').slice(0, 100),
    // Same rule as v1: NL goes via post (Print&Bind picks mailbox or parcel
    // by size), everything else via the international service.
    delivery_method: country === 'NL' ? 'post' : 'international',
    production_method: options.fast ? 'fast' : 'standard',
    // No Print&Bind branding on the package (was `blanco: 1` in v1)
    anonymous: true,
    articles,
  };
  if (customerInfo.company) {
    // Printed on the label above the contact
    request.company = customerInfo.company.slice(0, 35);
  }
  if (options.orderComment) {
    request.comment = options.orderComment.slice(0, 255);
  }
  if (options.reference) {
    // Must be unique per order at Print&Bind; a re-send of the same
    // payment gets a fresh suffix.
    request.reference = `${options.reference}-${Date.now().toString(
      36
    )}`.slice(0, 100);
  }
  return request;
}
