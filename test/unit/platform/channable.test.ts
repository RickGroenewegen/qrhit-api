/**
 * Unit tests for src/channable.ts (ChannableService).
 *
 * Everything with I/O is mocked at the module boundary:
 *  - cron                     → no-op CronJob class (the 5 AM job never fires)
 *  - ../../../src/prisma      → in-memory prisma stub (no MariaDB)
 *  - ../../../src/services/fx → deterministic convertAndFormat with fixed rates
 *  - ../../../src/translation / order / shipping / utils / logger → stubs
 * src/data/currency-map and src/productFeed are the REAL modules (both pure).
 *
 * The filesystem is NOT mocked: test/setup.ts points PUBLIC_DIR at a scratch
 * dir, so the CSV is really written and read back — which is the only way to
 * check the atomic write and the RFC 4180 escaping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import path from 'path';

const h = vi.hoisted(() => {
  process.env['FRONTEND_URI'] = 'https://www.qrsong.io';
  process.env['API_URI'] = 'https://api.qrsong.io';
  process.env['ENVIRONMENT'] = 'test';
  process.env['CHANNABLE_FEED_TOKEN'] = 'feed-token-test';
  delete process.env['DEBUG_CHANNABLE'];

  return {
    prisma: {
      playlist: {
        findMany: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    },
    translationsByPrefix: vi.fn(),
    getOrderType: vi.fn(),
    getShippingInfoByCountry: vi.fn(),
    // Default needed: the constructor calls isMainServer().then() at module
    // import, before any test can configure the mock.
    isMainServer: vi.fn(async () => false),
    fxConvertAndFormat: vi.fn(),
    cronCtor: vi.fn(),
  };
});

vi.mock('cron', () => ({
  CronJob: class {
    constructor(...args: any[]) {
      h.cronCtor(...args);
    }
    start() {}
    stop() {}
  },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log(_msg?: any) {}
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prisma },
}));

vi.mock('../../../src/translation', () => ({
  default: class {
    getTranslationsByPrefix = h.translationsByPrefix;
  },
}));

vi.mock('../../../src/order', () => ({
  default: { getInstance: () => ({ getOrderType: h.getOrderType }) },
}));

vi.mock('../../../src/shipping', () => ({
  default: {
    getInstance: () => ({
      getShippingInfoByCountry: h.getShippingInfoByCountry,
    }),
  },
}));

vi.mock('../../../src/utils', () => ({
  default: class {
    isMainServer = h.isMainServer;
  },
}));

vi.mock('../../../src/services/fx', () => ({
  default: { getInstance: () => ({ convertAndFormat: h.fxConvertAndFormat }) },
}));

import { channable } from '../../../src/channable';

const svc: any = channable; // for private-method access in tests

const PUBLIC_DIR = process.env['PUBLIC_DIR']!;
const PRODUCTS_DIR = path.join(PUBLIC_DIR, 'products');
const FEED_DIR = path.join(PUBLIC_DIR, 'channable');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makePlaylist(overrides: Record<string, any> = {}) {
  return {
    id: 7,
    playlistId: 'spot123',
    name: 'Greatest Hits',
    slug: 'greatest-hits',
    image: 'https://i.scdn.co/image/abc.jpg',
    numberOfTracks: 100,
    price: 29.99,
    featured: true,
    featuredLocale: null,
    promotionalActive: true,
    score: 10,
    description_en: 'An English description.',
    description_nl: 'Een Nederlandse omschrijving.',
    description_de: 'Eine deutsche Beschreibung.',
    genre: { slug: 'pop', name_en: 'Pop', name_nl: 'Pop', name_de: 'Pop' },
    ...overrides,
  };
}

function makeVariant(overrides: Partial<any> = {}) {
  return {
    id: 7,
    playlistId: 'spot123',
    name: 'Greatest Hits',
    description: 'An English description.',
    image: 'https://i.scdn.co/image/abc.jpg',
    price: 29.99,
    numberOfTracks: 100,
    type: 'physical' as const,
    locale: 'en',
    country: 'US',
    slug: 'greatest-hits',
    genre: 'Pop',
    genreSlug: 'pop',
    ...overrides,
  };
}

/** Put an AI product image on disk for a playlist so rows aren't skipped. */
async function seedAiImage(playlistId = 'spot123', stamp = 1700000000000) {
  await fsp.mkdir(PRODUCTS_DIR, { recursive: true });
  const file = `merchant_ai_${playlistId}_${stamp}.jpg`;
  await fsp.writeFile(path.join(PRODUCTS_DIR, file), 'jpeg-bytes');
  return file;
}

/** Minimal, deterministic CSV parser that honours quoting. */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // part of \r\n, handled on \n
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Read the built feed back as an array of column→value objects. */
async function readFeed(country?: string) {
  const csv = await fsp.readFile(svc.getFeedPath(country), 'utf8');
  const [header, ...rows] = parseCsv(csv);
  return rows.map((r) =>
    Object.fromEntries(header.map((c, i) => [c, r[i]]))
  ) as Record<string, string>[];
}

// ---------------------------------------------------------------------------

beforeEach(async () => {
  vi.clearAllMocks();

  await fsp.rm(FEED_DIR, { recursive: true, force: true });
  await fsp.rm(PRODUCTS_DIR, { recursive: true, force: true });
  await fsp.mkdir(PRODUCTS_DIR, { recursive: true });

  svc.shippingCostsByCountry = new Map();
  svc.building = null;

  h.getOrderType.mockResolvedValue({ amount: 29.99 });

  h.translationsByPrefix.mockImplementation(async (locale: string) => {
    const byLocale: Record<string, any> = {
      en: { qr_music_game: 'QR Music Game', cards: 'cards' },
      nl: { qr_music_game: 'QR Muziekspel', cards: 'kaarten' },
      de: { qr_music_game: 'QR Musikspiel', cards: 'Karten' },
    };
    return byLocale[locale] || byLocale['en'];
  });

  h.getShippingInfoByCountry.mockResolvedValue({
    countries: [
      { countryCode: 'US', shippingCosts: [{ size: 80, cost: 9 }, { size: 405, cost: 12 }, { size: 1000, cost: 15 }] },
      { countryCode: 'NL', shippingCosts: [{ size: 80, cost: 3 }, { size: 405, cost: 5 }, { size: 1000, cost: 8 }] },
      { countryCode: 'DE', shippingCosts: [{ size: 80, cost: 4 }, { size: 405, cost: 6 }, { size: 1000, cost: 9 }] },
    ],
  });

  // Fixed rates so assertions are exact. EUR is 1:1, everything else scaled.
  const RATES: Record<string, number> = {
    EUR: 1,
    USD: 1.1,
    GBP: 0.85,
    CHF: 0.95,
    SEK: 11,
    NOK: 11.5,
    AUD: 1.6,
    CAD: 1.5,
  };
  h.fxConvertAndFormat.mockImplementation(
    async (amount: number, currency: string) => {
      const rate = RATES[currency];
      if (!rate) return { value: amount.toFixed(2), currency: 'EUR' };
      return { value: (amount * rate).toFixed(2), currency };
    }
  );

  h.prisma.playlist.findMany.mockImplementation(async (args: any) => {
    if (args?.select?.id) return [{ id: 7 }];
    return [makePlaylist()];
  });
});

afterEach(async () => {
  await fsp.rm(FEED_DIR, { recursive: true, force: true });
  await fsp.rm(PRODUCTS_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('cron registration', () => {
  it('does not schedule the build when this is not the main server', () => {
    // isMainServer defaults to false, so the constructor must not have
    // registered anything at import time.
    expect(h.cronCtor).not.toHaveBeenCalled();
  });
});

describe('market gating', () => {
  it('publishes an international playlist to every locale/country pair', async () => {
    await seedAiImage();
    await channable.generateFeed();

    const rows = await readFeed();
    const pairs = rows.map((r) => `${r.content_language}~${r.target_country}`);

    expect(pairs).toEqual([
      'en~US',
      'en~GB',
      'en~AU',
      'en~CA',
      'nl~NL',
      'nl~BE',
      'de~DE',
      'de~AT',
      'de~CH',
      'es~ES',
      'sv~SE',
      'no~NO',
    ]);
  });

  it('restricts a locale-specific playlist to countries that allow it', async () => {
    h.prisma.playlist.findMany.mockImplementation(async (args: any) => {
      if (args?.select?.id) return [{ id: 7 }];
      return [makePlaylist({ featuredLocale: 'de' })];
    });
    await seedAiImage();
    await channable.generateFeed();

    const rows = await readFeed();
    expect(rows.map((r) => r.target_country)).toEqual(['DE', 'AT', 'CH']);
  });

  it('honours a comma-separated featuredLocale', async () => {
    h.prisma.playlist.findMany.mockImplementation(async (args: any) => {
      if (args?.select?.id) return [{ id: 7 }];
      return [makePlaylist({ featuredLocale: 'nl,de' })];
    });
    await seedAiImage();
    await channable.generateFeed();

    const rows = await readFeed();
    expect(rows.map((r) => r.target_country)).toEqual([
      'NL',
      'BE',
      'DE',
      'AT',
      'CH',
    ]);
  });

  it('never writes markedForMerchantCenter — that flag belongs to the Google sync', async () => {
    await seedAiImage();
    await channable.generateFeed();

    expect(h.prisma.playlist.update).not.toHaveBeenCalled();
    expect(h.prisma.playlist.updateMany).not.toHaveBeenCalled();

    // ...and it must not filter on it either, or the feed would only ever
    // contain playlists the Google sync happened to leave flagged.
    const where = h.prisma.playlist.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('markedForMerchantCenter');
    expect(where).toMatchObject({ featured: true, promotionalActive: true });
  });
});

describe('row contents', () => {
  it('builds an id that matches the Merchant Center product id', async () => {
    await seedAiImage();
    await channable.generateFeed();

    const rows = await readFeed();
    const us = rows.find((r) => r.target_country === 'US')!;

    // "{contentLanguage}~{feedLabel}~{dbId}_{typeNum}_{localeNum}"
    expect(us.id).toBe('en~US~7_3_1');
    expect(us.offer_id).toBe('7_3_1');

    const de = rows.find((r) => r.target_country === 'DE')!;
    expect(de.id).toBe('de~DE~7_3_3');
  });

  it('converts price and shipping into the local currency', async () => {
    await seedAiImage();
    await channable.generateFeed();

    const rows = await readFeed();

    const us = rows.find((r) => r.target_country === 'US')!;
    expect(us.currency).toBe('USD');
    expect(us.price).toBe('32.99'); // 29.99 * 1.1
    // 100 tracks → the 405 tier → 12 EUR → USD
    expect(us.shipping_price).toBe('13.20');
    expect(us.shipping_currency).toBe('USD');

    const nl = rows.find((r) => r.target_country === 'NL')!;
    expect(nl.currency).toBe('EUR');
    expect(nl.price).toBe('29.99');
    expect(nl.shipping_price).toBe('5.00');
  });

  it('falls back to 4.95 EUR when a country has no shipping costs', async () => {
    await seedAiImage();
    await channable.generateFeed();

    const rows = await readFeed();
    // GB is absent from the mocked shipping table.
    const gb = rows.find((r) => r.target_country === 'GB')!;
    expect(gb.shipping_price).toBe('4.21'); // 4.95 * 0.85
  });

  it('localises the title and description', async () => {
    await seedAiImage();
    await channable.generateFeed();

    const rows = await readFeed();

    const de = rows.find((r) => r.target_country === 'DE')!;
    expect(de.title).toBe(
      'QR Musikspiel (Karten) - Greatest Hits - 100 Karten'
    );
    expect(de.description).toBe(
      'Eine deutsche Beschreibung. Enthält 100 Musiktitel'
    );
    expect(de.link).toBe(
      'https://www.qrsong.io/de/product/greatest-hits?orderType=physical'
    );

    const nl = rows.find((r) => r.target_country === 'NL')!;
    expect(nl.title).toBe(
      'QR Muziekspel (kaarten) - Greatest Hits - 100 kaarten'
    );
  });

  it('sets the PMax custom labels', async () => {
    await seedAiImage();
    await channable.generateFeed();

    const [row] = await readFeed();
    expect(row.custom_label_0).toBe('physical');
    expect(row.custom_label_1).toBe('pop_hits');
    expect(row.custom_label_2).toBe('pop');
    expect(row.custom_label_3).toBe('medium'); // 100 tracks
    expect(row.product_type).toBe('Music > QR Codes > Pop > Physical Product');
    expect(row.brand).toBe('QRSong!');
    expect(row.availability).toBe('in_stock');
    expect(row.condition).toBe('new');
    expect(row.google_product_category).toBe('5030');
    expect(row.shipping_label).toBe('standard_shipping');
  });
});

describe('image resolution', () => {
  it('prefers the newest AI product image', async () => {
    await seedAiImage('spot123', 1700000000000);
    const newest = await seedAiImage('spot123', 1800000000000);
    await channable.generateFeed();

    const [row] = await readFeed();
    expect(row.image_link).toBe(`https://api.qrsong.io/public/products/${newest}`);
  });

  it('falls back to the Sharp composite when there is no AI image', async () => {
    await fsp.writeFile(
      path.join(PRODUCTS_DIR, 'merchant_spot123_physical_en_1700000000000.jpg'),
      'jpeg-bytes'
    );
    await channable.generateFeed();

    const rows = await readFeed();
    // The composite is keyed by playlist+type+locale, so only the four en/*
    // pairs find one; the nl/de/es/sv/no pairs are skipped.
    expect(rows.map((r) => r.target_country)).toEqual(['US', 'GB', 'AU', 'CA']);
    expect(rows[0].image_link).toBe(
      'https://api.qrsong.io/public/products/merchant_spot123_physical_en_1700000000000.jpg'
    );
  });

  it('skips a variant with no hosted image rather than shipping a CDN url', async () => {
    // Nothing on disk at all.
    await channable.generateFeed();

    const rows = await readFeed();
    expect(rows).toHaveLength(0);
    // The raw Spotify cover must never reach the feed.
    const csv = await fsp.readFile(svc.getFeedPath(), 'utf8');
    expect(csv).not.toContain('i.scdn.co');
  });
});

describe('CSV output', () => {
  it('writes a header row even when there are no products', async () => {
    h.prisma.playlist.findMany.mockResolvedValue([]);
    await channable.generateFeed();

    const csv = await fsp.readFile(svc.getFeedPath(), 'utf8');
    expect(csv.split('\r\n')[0]).toContain('id,offer_id,content_language');
    expect(await readFeed()).toHaveLength(0);
  });

  it('escapes commas, quotes and newlines per RFC 4180', async () => {
    h.prisma.playlist.findMany.mockImplementation(async (args: any) => {
      if (args?.select?.id) return [{ id: 7 }];
      return [
        makePlaylist({
          name: 'Rock, Pop & "More"',
          description_en: 'Line one\nline two, with a comma.',
          featuredLocale: 'en',
        }),
      ];
    });
    await seedAiImage();
    await channable.generateFeed();

    const rows = await readFeed();
    const us = rows.find((r) => r.target_country === 'US')!;

    // Round-tripping through the parser proves the escaping is correct.
    expect(us.title).toBe(
      'QR Music Game (cards) - Rock, Pop & "More" - 100 cards'
    );
    expect(us.description).toBe(
      'Line one\nline two, with a comma. Contains 100 music tracks'
    );
  });

  it('leaves no .tmp file behind, so the write was atomic', async () => {
    await seedAiImage();
    await channable.generateFeed();

    const files = await fsp.readdir(FEED_DIR);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(files).toContain('feed.csv');
  });

  it('reports the row count and path it wrote', async () => {
    await seedAiImage();
    const result = await channable.generateFeed();

    expect(result.rows).toBe(12);
    expect(result.path).toBe(svc.getFeedPath());
  });
});

describe('per-country slices', () => {
  it('writes one file per country we sell in', async () => {
    await seedAiImage();
    await channable.generateFeed();

    for (const country of channable.getFeedCountries()) {
      const rows = await readFeed(country);
      expect(rows).toHaveLength(1);
      expect(rows[0].target_country).toBe(country);
    }
  });

  it('writes an empty slice rather than no file when a country has nothing', async () => {
    h.prisma.playlist.findMany.mockImplementation(async (args: any) => {
      if (args?.select?.id) return [{ id: 7 }];
      return [makePlaylist({ featuredLocale: 'de' })];
    });
    await seedAiImage();
    await channable.generateFeed();

    // Channable treats a missing file as an import error, an empty one as
    // "nothing to list today".
    await expect(fsp.access(svc.getFeedPath('US'))).resolves.toBeUndefined();
    expect(await readFeed('US')).toHaveLength(0);
    expect(await readFeed('DE')).toHaveLength(1);
  });
});

describe('build coordination', () => {
  it('shares one build between concurrent callers', async () => {
    await seedAiImage();
    const [a, b] = await Promise.all([
      channable.generateFeed(),
      channable.generateFeed(),
    ]);

    expect(a).toEqual(b);
    // One build ⇒ the playlist query ran once (twice: ids, then records).
    expect(h.prisma.playlist.findMany).toHaveBeenCalledTimes(2);
  });

  it('keeps going when one playlist blows up', async () => {
    h.prisma.playlist.findMany.mockImplementation(async (args: any) => {
      if (args?.select?.id) return [{ id: 7 }, { id: 8 }];
      return [
        makePlaylist({ featuredLocale: 'en' }),
        makePlaylist({ id: 8, playlistId: 'spot456', featuredLocale: 'nl' }),
      ];
    });
    // The second playlist's price lookup throws.
    h.getOrderType.mockImplementation(async (_t: number, _d: boolean, _p: string, playlistId: string) => {
      if (playlistId === 'spot456') throw new Error('printer down');
      return { amount: 29.99 };
    });
    await seedAiImage('spot123');
    await seedAiImage('spot456');

    const result = await channable.generateFeed();

    // The healthy playlist still made it into the feed. Every country allows
    // English, so an 'en' playlist reaches all twelve pairs.
    expect(result.rows).toBe(12);
    const rows = await readFeed();
    expect(rows.every((r) => r.playlist_id === 'spot123')).toBe(true);
  });

  it('falls back to the playlist price when the order type has none', async () => {
    h.getOrderType.mockResolvedValue(null);
    h.prisma.playlist.findMany.mockImplementation(async (args: any) => {
      if (args?.select?.id) return [{ id: 7 }];
      return [makePlaylist({ featuredLocale: 'nl', price: 24.5 })];
    });
    await seedAiImage();
    await channable.generateFeed();

    const rows = await readFeed();
    expect(rows.find((r) => r.target_country === 'NL')!.price).toBe('24.50');
  });
});

describe('feedExists', () => {
  it('is false before a build and true after', async () => {
    expect(await channable.feedExists()).toBe(false);
    await seedAiImage();
    await channable.generateFeed();
    expect(await channable.feedExists()).toBe(true);
    expect(await channable.feedExists('DE')).toBe(true);
  });
});
