/**
 * growth-oracle studio catalogue adapter: which ready-made playlists sell,
 * and what one looks like as cards, for ads that show a real theme.
 *
 * Contract (qrhit growth.config.json -> pillars.studio.catalogueCommand),
 * one line of JSON on stdout, exit 0:
 *   list [--limit=N]  → {"items":[{"id","name","sales","note"}]}
 *                       featured playlists, most ordered in the last 365 days first
 *   item <id>         → {"id","name","data":{…},"files":[{"name","url"}]}
 *                       its songs (artist, title, year, spread over the list),
 *                       its card design when the product page may show it, and
 *                       the cover and design images to download
 *
 * Read-only, and only when the operator asks (`growth studio catalogue`):
 * production through the read-only user (LIVE_DB_READONLY_USER and
 * LIVE_DB_READONLY_PASSWORD, on the host of DATABASE_URL), never through
 * DATABASE_URL's own user. GROWTH_KPI_DATABASE picks another database, as for
 * the KPI adapter.
 *
 * The design follows the product page's rule (productPageDesign): a customer
 * who kept their design private, or a design an admin vetoed, is not handed
 * to an ad either.
 */
import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '@prisma/client';

import { productPageDesign } from '../src/data/productPageDesign';

const SALES_DAYS = 365;
const SONGS = 40;
const SITE = 'https://www.qrsong.io';
const API = 'https://api.qrsong.io';
// the design's own pictures, and the name each is saved under
const DESIGN_IMAGES: Record<string, string> = {
  backgroundImage: 'front',
  backgroundBackImage: 'back',
  logoImage: 'logo',
  qrLogo: 'qr-logo',
};

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  const user = process.env.LIVE_DB_READONLY_USER;
  const password = process.env.LIVE_DB_READONLY_PASSWORD;
  if (!connectionString) throw new Error('DATABASE_URL is not set (its host is the one read)');
  if (!user || !password) throw new Error('LIVE_DB_READONLY_USER / LIVE_DB_READONLY_PASSWORD are not set');
  const url = new URL(connectionString);
  const adapter = new PrismaMariaDb({
    host: url.hostname,
    port: parseInt(url.port) || 3306,
    user,
    password,
    database: process.env.GROWTH_KPI_DATABASE || 'qrhit',
    // one connection, so the session time limit below covers every query
    connectionLimit: 1,
  });
  return new PrismaClient({ adapter });
}

/** An image URL from a stored design, absolute; a data: URL or nothing gives null. */
function absolute(src: unknown): string | null {
  if (typeof src !== 'string' || !src || src.startsWith('data:')) return null;
  if (/^https?:\/\//.test(src)) return src.replace(/^https?:\/\/localhost(:\d+)?/, API);
  return `${SITE}/${src.replace(/^\/+/, '')}`;
}

const extOf = (url: string) => (url.split('?')[0].match(/\.(png|jpe?g|webp|svg|gif)$/i)?.[0] ?? '.png').toLowerCase();

/** `n` rows spread evenly over the list, first and last included. */
function spread<T>(rows: T[], n: number): T[] {
  if (rows.length <= n) return rows;
  return Array.from({ length: n }, (_, i) => rows[Math.round((i * (rows.length - 1)) / (n - 1))]);
}

async function list(prisma: PrismaClient, limit: number) {
  const rows = await prisma.$queryRaw<Array<{ id: number; name: string; featuredLocale: string | null; sales: bigint }>>`
    SELECT p.id, p.name, p.featuredLocale, COUNT(DISTINCT pay.id) AS sales
    FROM playlists p
    JOIN payment_has_playlist php ON php.playlistId = p.id
    JOIN payments pay ON pay.id = php.paymentId
    WHERE p.featured = 1
      AND p.featuredHidden = 0
      AND pay.status = 'paid'
      AND pay.createdAt >= DATE_SUB(NOW(), INTERVAL ${SALES_DAYS} DAY)
    GROUP BY p.id, p.name, p.featuredLocale
    ORDER BY sales DESC, p.id
    LIMIT ${limit}
  `;
  return {
    items: rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      sales: Number(r.sales),
      note: r.featuredLocale ? `market ${r.featuredLocale}` : null,
    })),
  };
}

async function item(prisma: PrismaClient, id: number) {
  // featuredDesignHidden is newer than some databases this may read
  const vetoColumn = (await prisma.$queryRawUnsafe<unknown[]>(`SHOW COLUMNS FROM playlists LIKE 'featuredDesignHidden'`)).length > 0;
  const rows = await prisma.$queryRawUnsafe<
    Array<{ id: number; name: string; slug: string; featuredLocale: string | null; numberOfTracks: number; design: unknown; promotionalShareDesign: number; featuredDesignHidden: number | null }>
  >(
    `SELECT id, name, slug, featuredLocale, numberOfTracks, design, promotionalShareDesign, ${vetoColumn ? 'featuredDesignHidden' : 'NULL AS featuredDesignHidden'}
     FROM playlists WHERE id = ? AND featured = 1`,
    id
  );
  const p = rows[0];
  if (!p) throw new Error(`no featured playlist ${id}`);
  const songs = await prisma.$queryRaw<Array<{ artist: string; title: string; year: number }>>`
    SELECT t.artist, t.name AS title, t.year
    FROM playlist_has_tracks pht
    JOIN tracks t ON t.id = pht.trackId
    WHERE pht.playlistId = ${id} AND t.year IS NOT NULL
    ORDER BY pht.order, t.id
    LIMIT 1000
  `;
  const stored = typeof p.design === 'string' ? JSON.parse(p.design) : p.design;
  const design = productPageDesign({ design: stored, promotionalShareDesign: !!p.promotionalShareDesign, featuredDesignHidden: !!p.featuredDesignHidden }) as Record<string, unknown> | null;
  const files = [{ name: 'cover.jpg', url: `${API}/product-cover/${p.slug}.jpg` }];
  for (const [key, name] of Object.entries(DESIGN_IMAGES)) {
    const url = absolute(design?.[key]);
    if (url) files.push({ name: `${name}${extOf(url)}`, url });
  }
  return {
    id: String(p.id),
    name: p.name,
    data: {
      slug: p.slug,
      page: `${SITE}/en/product/${p.slug}`,
      market: p.featuredLocale,
      tracks: p.numberOfTracks,
      songs: spread(songs, SONGS).map((s) => ({ artist: s.artist, title: s.title, year: Number(s.year) })),
      // null: the standard design (the customer's own is private, vetoed or absent)
      design,
    },
    files,
  };
}

async function main(): Promise<void> {
  const [verb, arg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const limit = Math.min(200, Math.max(1, Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 50)));
  if (verb !== 'list' && verb !== 'item') throw new Error('usage: studio-catalogue list [--limit=N] | item <id>');
  if (verb === 'item' && !/^\d+$/.test(arg ?? '')) throw new Error('item needs a playlist id (a number)');
  const prisma = createClient();
  try {
    await prisma.$executeRawUnsafe('SET SESSION max_execution_time = 15000');
    const answer = verb === 'list' ? await list(prisma, limit) : await item(prisma, Number(arg));
    process.stdout.write(JSON.stringify(answer) + '\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  process.stderr.write(`studio catalogue failed: ${e?.message || e}\n`);
  process.exit(1);
});
