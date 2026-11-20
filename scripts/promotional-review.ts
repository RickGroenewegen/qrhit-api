/**
 * Asks the automatic review (src/promotionalReview.ts) about submissions Rick
 * already decided, and shows where it agrees. Writes nothing to production:
 * the model's answers are only printed, and the playlist is not probed (a
 * declined list is often gone by now; that part is the service's, not the
 * model's).
 *
 *   npm run promotional-review                    all declined, the 30 newest approved, and what is pending
 *   npm run promotional-review -- --approved=60   more approved ones
 *   npm run promotional-review -- --id=12345,678  these playlists (database ids)
 *
 * Read-only, and only when the operator asks: production through the
 * read-only user (LIVE_DB_READONLY_USER and LIVE_DB_READONLY_PASSWORD, on the
 * host of DATABASE_URL), like market-ranking.ts. Each answer is one model
 * call (task promotionalReview), booked in the llm_calls of DATABASE_URL.
 */
import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '@prisma/client';

import { askModel, decideReview, loadTracks, taggableLocales } from '../src/promotionalReview';

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
    connectionLimit: 2,
  });
  return new PrismaClient({ adapter });
}

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const SELECT = {
  id: true,
  playlistId: true,
  name: true,
  promotionalTitle: true,
  promotionalDescription: true,
  promotionalLocale: true,
  promotionalAccepted: true,
  promotionalHide: true,
  featuredLocale: true,
} as const;

type Rick = 'approved' | 'declined' | 'pending';

const pad = (s: unknown, n: number) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t.padEnd(n);
};

async function main() {
  const prisma = createClient();
  const taggable = taggableLocales();
  try {
    const id = arg('id');
    const submitted = { promotionalActive: true };
    const rows: any[] = id
      ? await prisma.playlist.findMany({ where: { id: { in: id.split(',').map(Number) } }, select: SELECT })
      : [
          ...(await prisma.playlist.findMany({
            where: { ...submitted, promotionalAccepted: false, promotionalHide: true },
            select: SELECT,
            orderBy: { id: 'desc' },
          })),
          ...(await prisma.playlist.findMany({
            where: { ...submitted, promotionalAccepted: true },
            select: SELECT,
            orderBy: { id: 'desc' },
            take: Number(arg('approved') ?? 30),
          })),
          ...(await prisma.playlist.findMany({
            where: { ...submitted, promotionalAccepted: false, promotionalHide: false },
            select: SELECT,
            orderBy: { id: 'desc' },
          })),
        ];

    const results: Array<{ row: any; rick: Rick; tracks: number; decision: ReturnType<typeof decideReview> | null }> = [];
    const queue = [...rows];
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const rick: Rick = row.promotionalAccepted ? 'approved' : row.promotionalHide ? 'declined' : 'pending';
        const tracks = await loadTracks(prisma, row.id);
        const answer = await askModel({
          title: row.promotionalTitle || row.name,
          description: row.promotionalDescription || '',
          siteLanguage: row.promotionalLocale,
          trackCount: tracks.length,
          tracks,
        }).catch((e) => {
          process.stderr.write(`${row.id}: ${e?.message || e}\n`);
          return null;
        });
        const decision = answer
          ? decideReview(answer, { trackCount: tracks.length, gone: false, siteLanguage: row.promotionalLocale }, taggable)
          : null;
        results.push({ row, rick, tracks: tracks.length, decision });
        process.stderr.write('.');
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    process.stderr.write('\n');

    const order: Record<Rick, number> = { declined: 0, approved: 1, pending: 2 };
    results.sort((a, b) => order[a.rick] - order[b.rick] || b.row.id - a.row.id);
    console.log(`${pad('id', 7)} ${pad('Rick', 9)} ${pad('model', 8)} ${pad('songs', 5)} ${pad('site', 4)} ${pad('locale now', 10)} ${pad('model locale', 12)} ${pad('title', 34)} reason`);
    for (const r of results) {
      const d = r.decision;
      console.log(
        `${pad(r.row.id, 7)} ${pad(r.rick, 9)} ${pad(d ? d.action : 'no answer', 8)} ${pad(r.tracks, 5)} ${pad(r.row.promotionalLocale, 4)} ${pad(r.row.featuredLocale ?? '-', 10)} ${pad(d ? (d.featuredLocale ?? '-') : '', 12)} ${pad(r.row.promotionalTitle || r.row.name, 34)} ${d?.reason ?? ''}`
      );
    }

    const tally = (rick: Rick) => {
      const of = results.filter((r) => r.rick === rick);
      const by = (a: string) => of.filter((r) => (r.decision?.action ?? 'none') === a).length;
      return `${rick} ${of.length}: model accept ${by('accept')}, decline ${by('decline')}, leave ${by('leave')}, no answer ${by('none')}`;
    };
    console.log('\n' + ['declined', 'approved', 'pending'].map((r) => tally(r as Rick)).join('\n'));
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
