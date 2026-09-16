/**
 * Repairs playlist descriptions that carry the model's own prompt scaffolding,
 * e.g. "Numbers you'll spot: 1990, 8 - hit play and let QRSong do the rest."
 * Four of these were live on the English catalogue.
 *
 * The description prompt no longer asks for a list of figures and
 * stripNumberScaffolding() now runs on every generated description, so this
 * only has to repair the rows written before that.
 *
 *   npx tsx _scripts/fix-playlist-descriptions.ts          # dry run, prints changes
 *   npx tsx _scripts/fix-playlist-descriptions.ts --apply  # writes them
 *
 * Reads DATABASE_URL from the environment, so point it at the database you
 * actually mean to change.
 */
import 'dotenv/config';
import PrismaInstance from '../src/prisma';
import { stripNumberScaffolding } from '../src/chatgpt';

const LOCALES = [
  'en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'jp', 'cn', 'sv', 'no',
] as const;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  // The shared singleton, so the driver adapter and pool settings match the app.
  const prisma = PrismaInstance.getInstance();

  const columns = LOCALES.map((l) => `description_${l}`);
  const playlists = await prisma.playlist.findMany({
    select: Object.fromEntries([
      ['id', true],
      ['name', true],
      ...columns.map((c) => [c, true]),
    ]) as any,
  });

  let changedRows = 0;
  let changedFields = 0;

  for (const row of playlists as any[]) {
    const patch: Record<string, string> = {};
    for (const column of columns) {
      const before = row[column];
      if (typeof before !== 'string' || !before) continue;
      const after = stripNumberScaffolding(before);
      if (after !== before) {
        patch[column] = after;
        changedFields++;
        console.log(`\n[${row.id}] ${row.name} :: ${column}`);
        console.log(`  before: ${before}`);
        console.log(`  after : ${after}`);
      }
    }
    if (Object.keys(patch).length === 0) continue;
    changedRows++;
    if (apply) {
      await prisma.playlist.update({ where: { id: row.id }, data: patch });
    }
  }

  console.log(
    `\n${apply ? 'Updated' : 'Would update'} ${changedFields} description(s) across ${changedRows} playlist(s), out of ${playlists.length} scanned.`
  );
  if (!apply && changedRows > 0) {
    console.log('Nothing was written. Re-run with --apply to write these.');
  }
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
