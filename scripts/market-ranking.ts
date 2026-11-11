/**
 * Shows the featured ranking of a market with the numbers behind each place,
 * to read before and after a deploy. Computes it fresh; stores nothing.
 *
 *   npm run market-ranking -- --country=NL [--top=25]
 *   npm run market-ranking -- --country=world
 *   npm run market-ranking -- --untagged     international lists that sell in one language group only
 *
 * Read-only, and only when the operator asks: production through the
 * read-only user (LIVE_DB_READONLY_USER and LIVE_DB_READONLY_PASSWORD, on the
 * host of DATABASE_URL), never through DATABASE_URL's own user, like
 * studio-catalogue.ts.
 */
import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '@prisma/client';

import {
  WORLD,
  languageGroup,
  loadRankingInput,
  pickMarket,
  rankMarket,
  weighSales,
} from '../src/data/marketRanking';
import { MARKETS } from '../src/data/shared/shared-data.generated';

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
    connectionLimit: 1,
  });
  return new PrismaClient({ adapter });
}

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

async function main() {
  const prisma = createClient();
  try {
    const input = await loadRankingInput({ prisma } as any);
    const names = new Map(input.playlists.map((p) => [p.id, p]));

    if (process.argv.includes('--untagged')) {
      const { world, perCountry } = weighSales(input.buckets);
      const groups = [...new Set(MARKETS.map((m) => languageGroup(m.code).join('+')))];
      const rows = input.playlists
        .filter((p) => !p.featuredLocale && !p.featuredHidden)
        .map((p) => {
          const total = world.get(p.id) ?? 0;
          const best = groups
            .map((g) => ({
              group: g,
              sales: g.split('+').reduce((s, c) => s + (perCountry.get(c)?.get(p.id) ?? 0), 0),
            }))
            .sort((a, b) => b.sales - a.sales)[0];
          return { id: p.id, name: p.name, total, group: best.group, share: total ? best.sales / total : 0 };
        })
        .filter((r) => r.total >= 3 && r.share >= 0.9 && !r.group.includes('US'))
        .sort((a, b) => b.total - a.total);
      console.table(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          'weighted sales': r.total.toFixed(1),
          'sells in': r.group,
          share: `${Math.round(r.share * 100)}%`,
        }))
      );
      return;
    }

    const asked = arg('country') ?? WORLD;
    const market = asked.toLowerCase() === WORLD ? WORLD : pickMarket([asked]);
    const top = parseInt(arg('top') ?? '25', 10);
    const visible = input.playlists.filter((p) => !p.featuredHidden);
    const ranked = rankMarket(visible, input.buckets, market);
    console.log(`Ranking for ${market} (${visible.length} playlists)`);
    console.table(
      ranked.slice(0, top).map((r, i) => ({
        place: i + 1,
        id: r.id,
        name: names.get(r.id)?.name,
        locale: names.get(r.id)?.featuredLocale ?? '',
        'own sales': r.ownSales.toFixed(1),
        'world sales': r.worldSales.toFixed(1),
        'share ‰': (r.value * 1000).toFixed(2),
        'own language': r.ownLanguage ? 'yes' : '',
        new: r.isNew ? 'yes' : '',
      }))
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
