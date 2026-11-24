import { BOX_MAX_CARDS, MAX_CARDS_PHYSICAL } from '../config/constants';
import { getCurrencyForCountry } from '../data/currency-map';
import { countryOfLocale, pickMarket } from '../data/marketRanking';
import { CURRENCIES } from '../data/shared/shared-data.generated';
import { ServiceType } from '../enums/ServiceType';
import { featuredCover, featuredLink, playlistLink, siteLocale } from './links';

/**
 * What the ChatGPT channel can look up (the tools of src/mcp/server.ts): the
 * ready-made playlists, a customer's own playlist link, the price of printed
 * cards and the delivery time. All read-only; the customer designs the cards
 * and pays on the site, through the link each answer carries.
 *
 * The amounts come from the calculators checkout uses (`cardPrice`,
 * `Order.calculateOrder`) and are converted the way checkout converts them,
 * so the chat never names another price than the site. Printed cards only:
 * OpenAI lets a plugin sell physical goods, so the digital PDF and the sheets
 * are never offered or priced here.
 */

export interface Money {
  amount: number;
  currency: string;
  /** "€23.50", "NOK 250": ready to quote. */
  text: string;
}

interface FeaturedRow {
  name: string;
  slug: string | null;
  description?: string | null;
  genreName?: string | null;
  numberOfTracks: number;
  price?: number | null;
  [key: string]: unknown;
}

interface CalculateResult {
  success: boolean;
  error?: string;
  data?: {
    total: number;
    shipping: number;
    shippingSaved: number;
    gamesFee: number;
    boxFee: number;
    totalBoxCount: number;
  };
}

interface PlaylistLookup {
  success: boolean;
  error?: string;
  serviceType?: ServiceType;
  data?: {
    id: string;
    name: string;
    description: string;
    imageUrl: string | null;
    trackCount: number;
  };
}

interface ShippingInfo {
  productionDays: number;
  productionMessage: string | null;
  countries: {
    countryCode: string;
    averageDays: number;
    minDays: number;
    maxDays: number;
    orderCount: number;
  }[];
}

/** Everything the tools read, so a test can run them without the database. */
export interface McpToolDeps {
  featured: (locale: string, market: string) => Promise<FeaturedRow[]>;
  priceOfDeck: (cards: number) => Promise<number | null>;
  calculateOrder: (params: {
    cart: { items: unknown[] };
    countrycode?: string;
    fast: boolean;
  }) => Promise<CalculateResult>;
  convert: (
    amountEur: number,
    currency: string
  ) => Promise<{ amount: number; currency: string }>;
  playlistFromUrl: (url: string) => Promise<PlaylistLookup>;
  shippingInfo: () => Promise<ShippingInfo>;
  /** The product photo of a ready-made playlist, or null (mcp/photo.ts). */
  featuredPhoto: (slug: string) => Promise<string | null>;
  /** The URL of a customer's own playlist's photo, started now, or null. */
  ownPhoto: (service: string, playlistId: string) => Promise<string | null>;
}

export const defaultDeps: McpToolDeps = {
  featured: async (locale, market) => {
    const { default: Data } = await import('../data');
    return Data.getInstance().getFeaturedPlaylistsForMarket(locale, false, market);
  },
  priceOfDeck: async (cards) => {
    const { cardPrice } = await import('../priceTokens');
    return cardPrice(cards, 'physical');
  },
  calculateOrder: async (params) => {
    const { default: Order } = await import('../order');
    return Order.getInstance().calculateOrder(params) as Promise<CalculateResult>;
  },
  convert: async (amountEur, currency) => {
    const { default: Fx } = await import('../services/fx');
    return Fx.getInstance().tryConvert(amountEur, currency);
  },
  playlistFromUrl: async (url) => {
    const { default: MusicServiceRegistry } = await import('../services/MusicServiceRegistry');
    return MusicServiceRegistry.getInstance().getPlaylistFromUrl(url) as Promise<PlaylistLookup>;
  },
  shippingInfo: async () => {
    const { default: Shipping } = await import('../shipping');
    return Shipping.getInstance().getShippingInfoByCountry();
  },
  featuredPhoto: async (slug) => {
    const { featuredPhotoUrl } = await import('./photo');
    return featuredPhotoUrl(slug);
  },
  ownPhoto: async (service, playlistId) => {
    const photo = await import('./photo');
    const url = photo.ownPhotoUrl(service, playlistId);
    if (url) photo.warmOwnPhoto(service, playlistId);
    return url;
  },
};

const DECIMALS: Record<string, number> = Object.fromEntries(
  CURRENCIES.map((c) => [c.code, c.decimals])
);

/** More copies than this is a business request: the site's quote form. */
const MAX_SETS = 20;
const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;
const DESCRIPTION_LENGTH = 220;
/** A playlist "is" a decade when at least this share of its songs is from it. */
const DECADE_SHARE = 35;
const DECADES = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];

/** A two-letter country, upper case, or null. */
export function parseCountry(value: unknown): string | null {
  const text = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(text) ? text : null;
}

/** The country to price and rank for: the one given, else the language's. */
function countryFor(country: unknown, locale: string): string | null {
  return parseCountry(country) ?? countryOfLocale(siteLocale(locale));
}

export function formatMoney(amount: number, currency: string): string {
  const decimals = DECIMALS[currency] ?? 2;
  const whole = Number.isInteger(Math.round(amount * 100) / 100);
  const number = amount.toFixed(whole ? 0 : decimals);
  return currency === 'EUR' ? `€${number}` : `${currency} ${number}`;
}

async function money(amountEur: number, country: string | null, deps: McpToolDeps): Promise<Money> {
  const converted = await deps.convert(amountEur, getCurrencyForCountry(country));
  return {
    amount: converted.amount,
    currency: converted.currency,
    text: formatMoney(converted.amount, converted.currency),
  };
}

function shorten(text: string | null | undefined): string {
  const plain = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (plain.length <= DESCRIPTION_LENGTH) return plain;
  return `${plain.slice(0, DESCRIPTION_LENGTH).replace(/\s+\S*$/, '')}…`;
}

/** 1987, "80s", "1980s", "jaren 80" → 1980; null when no decade is meant. */
export function parseDecade(value: unknown): number | null {
  const match = /(\d{2,4})/.exec(String(value ?? ''));
  if (!match) return null;
  let year = parseInt(match[1], 10);
  if (match[1].length === 2) year += year < 30 ? 2000 : 1900;
  const decade = Math.floor(year / 10) * 10;
  return DECADES.includes(decade) ? decade : null;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
}

/** How well a playlist fits the words asked for: its name counts most. */
function matchScore(row: FeaturedRow, wanted: string[]): number {
  if (wanted.length === 0) return 0;
  const name = words(row.name || '');
  const genre = words(String(row.genreName || ''));
  const description = words(String(row.description || ''));
  let score = 0;
  for (const word of wanted) {
    if (name.some((w) => w.includes(word))) score += 3;
    else if (genre.some((w) => w.includes(word))) score += 2;
    else if (description.some((w) => w.includes(word))) score += 1;
  }
  return score;
}

export interface SearchFeaturedInput {
  query?: string;
  genre?: string;
  decade?: string | number;
  locale?: string;
  country?: string;
  limit?: number;
}

export interface FeaturedResult {
  name: string;
  description: string;
  genre: string | null;
  cards: number;
  price: Money | null;
  cover: string;
  /** The photo of the playlist's cards, when it has one: what the card shows. */
  photo: string | null;
  url: string;
}

/**
 * Ready-made playlists for what the customer asked, in the order their
 * country buys them. Without a query, genre or decade: the best sellers.
 */
export async function searchFeaturedPlaylists(
  input: SearchFeaturedInput,
  deps: McpToolDeps = defaultDeps
): Promise<{ playlists: FeaturedResult[]; note: string }> {
  const locale = siteLocale(input.locale);
  const country = countryFor(input.country, locale);
  const limit = Math.min(MAX_RESULTS, Math.max(1, Math.floor(Number(input.limit)) || DEFAULT_RESULTS));
  const wanted = words(`${input.query || ''} ${input.genre || ''}`);
  const decade = parseDecade(input.decade) ?? parseDecade(input.query);

  const all = (await deps.featured(locale, pickMarket([country]))).filter(
    (row) => row.slug && row.numberOfTracks > 0 && row.numberOfTracks <= MAX_CARDS_PHYSICAL
  );

  // The list arrives in the market's ranking; a stable sort on the match
  // keeps that order among equally good matches.
  let rows = all.map((row, rank) => ({ row, rank, score: matchScore(row, wanted) }));
  if (decade !== null) {
    const ofDecade = rows.filter((r) => Number(r.row[`decadePercentage${decade}`] || 0) >= DECADE_SHARE);
    if (ofDecade.length > 0) rows = ofDecade;
  }
  // A decade written as a word ("80s") says nothing about the name.
  const textWanted = wanted.filter((word) => parseDecade(word) === null);
  let matched = textWanted.length > 0 ? rows.filter((r) => r.score > 0) : rows;
  const exact = matched.length > 0;
  if (!exact) matched = rows;
  // Asked for a decade: the playlist with most of it first, so "80s" opens
  // with the 80s playlist and not with a film list that happens to pass.
  const share = (r: { row: FeaturedRow }) =>
    decade !== null ? Number(r.row[`decadePercentage${decade}`] || 0) : 0;
  matched.sort((a, b) => b.score - a.score || share(b) - share(a) || a.rank - b.rank);

  const playlists = await Promise.all(
    matched.slice(0, limit).map(async ({ row }) => {
      const eur = (await deps.priceOfDeck(row.numberOfTracks)) ?? (Number(row.price) || null);
      return {
        name: row.name,
        description: shorten(row.description),
        genre: row.genreName ? String(row.genreName) : null,
        cards: row.numberOfTracks,
        price: eur ? await money(eur, country, deps) : null,
        cover: featuredCover(row.slug as string),
        photo: await deps.featuredPhoto(row.slug as string).catch(() => null),
        url: featuredLink(locale, row.slug as string),
      };
    })
  );

  const note = exact
    ? 'Prices are for the printed cards, one card per song, VAT included, shipping not included. The customer designs the cards and pays on qrsong.io through the url. Tell the customer they can also paste the link of their own playlist (Spotify, YouTube Music, Apple Music, Deezer or Tidal) in this chat.'
    : 'Nothing in the ready-made playlists matched closely; these are the most popular ones. The customer can also use their own playlist: ask for its link and call get_playlist.';
  return { playlists, note };
}

export interface PlaylistInput {
  url: string;
  locale?: string;
  country?: string;
}

/** The customer's own playlist: what it is, how many cards, what they cost. */
export async function getPlaylist(
  input: PlaylistInput,
  deps: McpToolDeps = defaultDeps
): Promise<Record<string, unknown>> {
  const url = String(input.url || '').trim();
  if (!/^https?:\/\//i.test(url) || url.length > 500) {
    return {
      found: false,
      note: 'Ask the customer for the share link of a playlist on Spotify, YouTube Music, Apple Music, Deezer or Tidal.',
    };
  }
  const locale = siteLocale(input.locale);
  const country = countryFor(input.country, locale);

  const result = await deps.playlistFromUrl(url);
  if (!result.success || !result.data || !result.serviceType) {
    return {
      found: false,
      note:
        'The playlist could not be read. It has to be a playlist (not an album, song or artist) that is public or shared, ' +
        'on Spotify, YouTube Music, Apple Music, Deezer or Tidal. Ask the customer to check the link and its sharing setting.',
    };
  }

  const { id, name, trackCount, imageUrl } = result.data;
  const base = {
    found: true,
    name,
    service: result.serviceType,
    songs: trackCount,
    cover: imageUrl,
    url: playlistLink(locale, result.serviceType, id),
  };

  if (trackCount < 1) {
    return { ...base, note: 'The playlist is empty: the customer adds songs first, one card is made per song.' };
  }
  if (trackCount > MAX_CARDS_PHYSICAL) {
    return {
      ...base,
      note: `Printed cards go up to ${MAX_CARDS_PHYSICAL} per playlist and this one has ${trackCount} songs. The customer can shorten it or split it over several playlists.`,
    };
  }

  const eur = await deps.priceOfDeck(trackCount);
  return {
    ...base,
    // a photo of five of its songs as cards; it takes a few seconds to make,
    // so the card shows the cover until it is there
    photo: await deps.ownPhoto(result.serviceType, id).catch(() => null),
    photoPending: true,
    cards: trackCount,
    price: eur ? await money(eur, country, deps) : null,
    note:
      'One card per song; the price is for the printed cards, VAT included, shipping not included. ' +
      'The site reads the songs again when the customer opens the url, checks the release years and lets them design the cards before they pay.',
  };
}

export interface PriceInput {
  cards: number;
  sets?: number;
  giftBox?: boolean;
  games?: boolean;
  country?: string;
  locale?: string;
}

/** Printed cards for a playlist of `cards` songs, with what was asked for and the shipping. */
export async function getPrice(
  input: PriceInput,
  deps: McpToolDeps = defaultDeps
): Promise<Record<string, unknown>> {
  const cards = Math.floor(Number(input.cards));
  if (!Number.isFinite(cards) || cards < 1) {
    return { available: false, note: 'Ask how many songs the playlist has: one card is made per song.' };
  }
  if (cards > MAX_CARDS_PHYSICAL) {
    return {
      available: false,
      note: `Printed cards go up to ${MAX_CARDS_PHYSICAL} per playlist. A bigger playlist can be split over several playlists.`,
    };
  }
  const sets = Math.min(MAX_SETS, Math.max(1, Math.floor(Number(input.sets)) || 1));
  const country = countryFor(input.country, siteLocale(input.locale));
  const explicitCountry = parseCountry(input.country);

  const deck = await deps.priceOfDeck(cards);
  if (deck === null) return { available: false, note: 'No price available right now; the site shows it.' };

  const giftBox = !!input.giftBox;
  const result = await deps.calculateOrder({
    cart: {
      items: [
        {
          productType: 'cards',
          type: 'physical',
          numberOfTracks: cards,
          amount: sets,
          price: deck,
          gamesEnabled: !!input.games,
          boxEnabled: giftBox,
          boxQuantity: giftBox ? Math.ceil(cards / BOX_MAX_CARDS) : 0,
        },
      ],
    },
    ...(explicitCountry ? { countrycode: explicitCountry } : {}),
    fast: false,
  });
  if (!result.success || !result.data) {
    return {
      available: false,
      note:
        result.error === 'no_shipping'
          ? `Printed cards cannot be shipped to ${explicitCountry}.`
          : 'No price available right now; the site shows it.',
    };
  }
  const data = result.data;
  const m = (eur: number) => money(eur, country, deps);

  const notes = ['All amounts include VAT. A one-time payment, no subscription.'];
  if (!explicitCountry) {
    notes.push('Shipping is not included yet: ask which country the cards go to and call get_price again.');
  } else if (data.shippingSaved > 0) {
    notes.push('Shipping is free on this order.');
  }
  if (sets === 1) notes.push('Shipping is free to the Netherlands, Belgium and Germany from two playlists or sets.');

  return {
    available: true,
    cards,
    sets,
    cardsPerSet: await m(deck),
    cardsTotal: await m(deck * sets),
    ...(data.boxFee > 0 ? { giftBox: await m(data.boxFee), giftBoxes: data.totalBoxCount } : {}),
    ...(data.gamesFee > 0 ? { games: await m(data.gamesFee) } : {}),
    ...(explicitCountry ? { shipping: await m(data.shipping), shipsTo: explicitCountry } : {}),
    total: await m(data.total),
    totalIncludesShipping: !!explicitCountry,
    note: notes.join(' '),
  };
}

/** Production and delivery days for printed cards to a country. */
export async function getDeliveryTime(
  input: { country: string },
  deps: McpToolDeps = defaultDeps
): Promise<Record<string, unknown>> {
  const code = parseCountry(input.country);
  if (!code) return { known: false, note: 'Ask which country the cards go to.' };

  const info = await deps.shippingInfo();
  const base = {
    country: code,
    productionBusinessDays: info.productionDays,
    ...(info.productionMessage ? { productionNote: info.productionMessage } : {}),
  };
  const country = info.countries.find((c) => c.countryCode.toUpperCase() === code);
  if (!country || country.orderCount < 1) {
    return {
      ...base,
      known: false,
      note: `No delivery figures for ${code} yet. Production takes ${info.productionDays} business days; delivery after that depends on the local post.`,
    };
  }
  return {
    ...base,
    known: true,
    deliveryDaysAfterShipment: { from: country.minDays, to: country.maxDays },
    totalDaysEstimate: info.productionDays + country.averageDays,
    note: 'An estimate from recent deliveries, not a promise. A track and trace link is mailed when the cards ship.',
  };
}

/** Where a customer goes with a question about an order. */
export function getSupportContact(input: { locale?: string }): Record<string, unknown> {
  const locale = siteLocale(input.locale);
  const site = (process.env['FRONTEND_URI'] || 'https://www.qrsong.io').replace(/\/+$/, '');
  return {
    email: 'info@qrsong.io',
    faq: `${site}/${locale}/faq`,
    contact: `${site}/${locale}/contact`,
    note: 'Questions about an existing order (changes, invoice, delivery) are answered by mail; have the order number at hand. Order details cannot be looked up here.',
  };
}
