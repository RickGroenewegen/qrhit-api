/**
 * Curated, gift-relevant occasions for the admin Event calendar.
 *
 * Occasions are filled per country by `CalendarService.prefillEvents()` from two
 * sources, merged so the library wins and the supplement only fills gaps:
 *
 *  1. `OCCASION_MATCHERS` — matched against the English holiday names returned by
 *     the `date-holidays` library. This authoritatively covers the movable,
 *     country-specific dates (Mother's Day, Easter, King's Day, Sinterklaas, ...).
 *  2. `SUPPLEMENT_RULES` — computed fallbacks for occasions the library does not
 *     emit for a given country (e.g. Valentine's Day in NL/FR/GB, Father's Day in
 *     DE/FR/IT/ES/AT). These are well-known rules; admins can correct any row in
 *     the UI and the prefill never overwrites admin edits to relevant/hidden/notes.
 *
 * Match patterns are anchored to avoid false positives such as "Kingdom Day",
 * "Martin Luther King Jr. Day" or "Day after Thanksgiving Day".
 */

// ISO-3166 alpha-2 store markets the calendar is prefilled for.
export const TARGET_COUNTRIES = [
  'NL', 'BE', 'DE', 'AT', 'FR', 'ES', 'IT', 'PT', 'PL', 'SE', 'NO', 'GB', 'US', 'JP', 'CN',
] as const;

// The store market whose occasion date drives each locale's public occasion
// landing page (landing pages are per-language; see the seasonal plan). `en→US`
// so US-only occasions (Thanksgiving) and Father's Day get an English page; GB
// shares the same Father's Day date.
export const LOCALE_PRIMARY_COUNTRY: Record<string, string> = {
  en: 'US',
  nl: 'NL',
  de: 'DE',
  fr: 'FR',
  es: 'ES',
  it: 'IT',
  pt: 'PT',
  pl: 'PL',
  sv: 'SE',
  no: 'NO',
  jp: 'JP',
  cn: 'CN',
};

/**
 * Canonical localised occasion slug, with English/key fallbacks (so CJK names
 * that slugify to empty still get a usable latin slug). Shared by
 * CalendarService and the sitemap generator.
 */
export function occasionSlug(eb: any, locale: string): string {
  return (
    slugify(eb?.[`name_${locale}`]) ||
    slugify(eb?.name_en) ||
    slugify((eb?.key || '').replace(/_/g, ' '))
  );
}

/** URL-safe slug from a display name ("Father's Day" → "fathers-day"). */
export function slugify(text: string): string {
  return (text || '')
    .toString()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/['’]/g, '') // drop apostrophes: Father's → fathers
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface OccasionMatcher {
  /** stable slug stored as CalendarEvent.eventKey */
  key: string;
  /** matched (case-insensitive) against the date-holidays English name */
  match: RegExp;
  /** restrict to these countries; undefined = all target countries */
  countries?: string[];
}

export const OCCASION_MATCHERS: OccasionMatcher[] = [
  { key: 'new_year', match: /^new year'?s day$/i },
  { key: 'valentines_day', match: /^valentine'?s day$/i },
  { key: 'easter', match: /^easter sunday$/i },
  { key: 'mothers_day', match: /^mother'?s day$/i },
  { key: 'fathers_day', match: /^father'?s day$/i },
  { key: 'christmas', match: /^christmas day$/i },
  { key: 'sinterklaas', match: /nicholas/i, countries: ['NL', 'BE'] },
  { key: 'kings_day', match: /^king'?s day$/i, countries: ['NL'] },
  { key: 'thanksgiving', match: /^thanksgiving day$/i, countries: ['US'] },
];

export interface BaseEventSeed {
  /** unique slug, matches the eventKey the prefill assigns to instances */
  key: string;
  /** display name for the base occasion */
  name: string;
  /** English description of what kind of playlists fit this occasion */
  description: string;
  /** long-form English landing-page copy (editorial, gift-intent SEO) */
  body: string;
}

// Canonical base occasions. `prefillEvents()` upserts these (never overwriting
// admin edits) and links every generated instance to its base by key. The keys
// must match the slugs in OCCASION_MATCHERS / SUPPLEMENT_RULES. The description
// guides the AI playlist classifier and is shown/edited in the admin.
export const BASE_EVENT_SEEDS: BaseEventSeed[] = [
  {
    key: 'new_year',
    name: "New Year's Day",
    description:
      'Upbeat party, countdown and celebration playlists for ringing in the New Year.',
    body:
      "Ring in the New Year with a playlist that captures the year's best moments. A QRSong card turns those songs into a keepsake gift: scan the QR code and the music starts playing instantly. It is a thoughtful way to celebrate a fresh start with someone you love.",
  },
  {
    key: 'valentines_day',
    name: "Valentine's Day",
    description:
      'Romantic music and love songs that make a heartfelt gift for a partner.',
    body:
      "Say it with songs this Valentine's Day. Build a playlist of the tracks that tell your love story and we turn it into a personalised QRSong card your partner can scan and play. It is a romantic, lasting alternative to flowers and chocolates.",
  },
  {
    key: 'easter',
    name: 'Easter',
    description: 'Springtime and feel-good, family-friendly playlists suited to Easter gatherings.',
    body:
      'Bring the family together this Easter with a playlist everyone can enjoy. A QRSong music card makes a cheerful spring gift: pick feel-good favourites, scan the code, and let the songs play. A simple, memorable present for gatherings big and small.',
  },
  {
    key: 'mothers_day',
    name: "Mother's Day",
    description:
      "Sentimental, feel-good and timeless playlists that make a thoughtful gift for Mum.",
    body:
      "Show Mum how much she means with a playlist of the songs she loves. A QRSong card turns those tracks into a heartfelt Mother's Day gift she can scan and play whenever she wants. More personal than flowers, and it lasts a lot longer.",
  },
  {
    key: 'fathers_day',
    name: "Father's Day",
    description:
      "Classic rock, oldies and feel-good hits that make a great gift for Dad.",
    body:
      "Give Dad the soundtrack to his best memories this Father's Day. Choose the classics, the road-trip anthems and the songs that remind him of you, and we print them on a personalised QRSong card he can scan and play. A gift with real meaning.",
  },
  {
    key: 'christmas',
    name: 'Christmas',
    description:
      'Festive holiday playlists full of Christmas songs, carols and winter classics to gift around the holidays.',
    body:
      'Make the holidays merrier with a Christmas playlist on a personalised QRSong card. Pick the carols, classics and family favourites, and your gift recipient just scans the QR code to start the music. A warm, original present to find under the tree.',
  },
  {
    key: 'sinterklaas',
    name: 'Sinterklaas',
    description:
      'Dutch and Belgian Sinterklaas playlists and festive gift music for early December.',
    body:
      'Celebrate Sinterklaas with a playlist of festive favourites. A QRSong card makes an original surprise gift for early December: choose the songs, scan the code, and the music plays. A modern twist on a beloved Dutch and Belgian tradition.',
  },
  {
    key: 'kings_day',
    name: "King's Day",
    description: "Dutch King's Day playlists that are upbeat, orange and celebratory.",
    body:
      "Get the party started for King's Day with an upbeat, orange-tinted playlist. A QRSong card turns the celebration's anthems into a fun, scannable gift. Perfect for the biggest street party of the Dutch year.",
  },
  {
    key: 'thanksgiving',
    name: 'Thanksgiving',
    description: 'Warm, nostalgic family-gathering playlists suited to Thanksgiving in the US.',
    body:
      'Set the mood for Thanksgiving with a playlist the whole table will love. A QRSong music card makes a warm, personal gift for the host or a loved one: pick the songs, scan the code, and the music plays. A heartfelt way to say thanks.',
  },
];

// --- date helpers (all in UTC, dates stored at UTC midnight) ---------------

/** Build a UTC-midnight Date. `month` is 1-based. */
export function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Easter Sunday (Gregorian / Meeus-Jones-Butcher algorithm). */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(year, month, day);
}

/** The n-th `weekday` (0 = Sunday) of a 1-based `month`. */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((7 + weekday - firstDow) % 7) + (n - 1) * 7;
  return utcDate(year, month, day);
}

// --- computed supplement ----------------------------------------------------

// Father's Day differs widely by country and the library omits most of them.
const FATHERS_DAY: Record<string, (year: number) => Date> = {
  DE: (y) => addDays(easterSunday(y), 39), // Vatertag = Ascension Day
  AT: (y) => nthWeekdayOfMonth(y, 6, 0, 2), // 2nd Sunday of June
  BE: (y) => nthWeekdayOfMonth(y, 6, 0, 2), // 2nd Sunday of June
  FR: (y) => nthWeekdayOfMonth(y, 6, 0, 3), // 3rd Sunday of June
  IT: (y) => utcDate(y, 3, 19), // St Joseph's Day
  ES: (y) => utcDate(y, 3, 19),
  PT: (y) => utcDate(y, 3, 19),
  SE: (y) => nthWeekdayOfMonth(y, 11, 0, 2), // 2nd Sunday of November
  JP: (y) => nthWeekdayOfMonth(y, 6, 0, 3), // 3rd Sunday of June
  CN: (y) => nthWeekdayOfMonth(y, 6, 0, 3),
};

// Mother's Day where the library has no entry (covered everywhere else).
const MOTHERS_DAY: Record<string, (year: number) => Date> = {
  JP: (y) => nthWeekdayOfMonth(y, 5, 0, 2), // 2nd Sunday of May
  CN: (y) => nthWeekdayOfMonth(y, 5, 0, 2),
};

export interface SupplementRule {
  key: string;
  /** English display name stored as CalendarEvent.name */
  label: string;
  /** restrict to these countries; undefined = all target countries */
  countries?: string[];
  /** resolve the date for a country/year, or null to skip */
  resolve: (year: number, country: string) => Date | null;
}

export const SUPPLEMENT_RULES: SupplementRule[] = [
  { key: 'valentines_day', label: "Valentine's Day", resolve: (y) => utcDate(y, 2, 14) },
  { key: 'mothers_day', label: "Mother's Day", resolve: (y, c) => MOTHERS_DAY[c]?.(y) ?? null },
  { key: 'fathers_day', label: "Father's Day", resolve: (y, c) => FATHERS_DAY[c]?.(y) ?? null },
];
