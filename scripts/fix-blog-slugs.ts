/**
 * Repair blog slugs that the old ASCII-only slugify() mangled.
 *
 * `slugify()` used to strip everything outside `[\w-]`, so a title written in
 * a non-Latin script lost every character. The uniqueness loop then appended a
 * counter to the empty string, which is how `/cn/blog/-1`, `/cn/blog/-2` and
 * `/jp/blog/-1` came to be real, indexable URLs. Latin titles ending in
 * punctuation kept a dangling trailing dash for the same reason.
 *
 * The generator is fixed in src/blog.ts; this backfills rows written before
 * that. Run with --dry (the default) first and read the table.
 *
 *   npx tsx scripts/fix-blog-slugs.ts          # report only
 *   npx tsx scripts/fix-blog-slugs.ts --apply  # write
 *
 * Renaming changes public URLs. The affected ones are degenerate (`-1`, `qr`)
 * and carry no meaningful link equity, but they will 404 afterwards rather
 * than redirect: getBlog() resolves a request by looking up the current slug
 * columns, so once a slug is replaced the old value is gone. Check Search
 * Console for impressions on these paths before applying if that matters.
 */
import { PrismaClient } from '@prisma/client';

const SUPPORTED_LOCALES = [
  'en',
  'nl',
  'de',
  'fr',
  'es',
  'it',
  'pt',
  'pl',
  'sv',
  'no',
  'jp',
  'cn',
  'hin',
  'ru',
];

/** Kept in sync with Blog.slugify() in src/blog.ts. */
function slugify(text: string): string {
  return text
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A slug is degenerate when it leads or trails with a dash, is only digits and
 * dashes, or is too short to say anything about the post.
 */
function isDegenerate(slug: string): boolean {
  if (!slug) return true;
  if (slug.startsWith('-') || slug.endsWith('-')) return true;
  if (/^-?\d+$/.test(slug)) return true;
  return slug.length < 3;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();

  const select: Record<string, boolean> = { id: true };
  for (const loc of SUPPORTED_LOCALES) {
    select[`slug_${loc}`] = true;
    select[`title_${loc}`] = true;
  }

  const blogs: any[] = await prisma.blog.findMany({ select });
  const changes: Array<{
    id: number;
    locale: string;
    from: string;
    to: string;
    title: string;
  }> = [];

  for (const blog of blogs) {
    for (const loc of SUPPORTED_LOCALES) {
      const current: string = blog[`slug_${loc}`] || '';
      const title: string = blog[`title_${loc}`] || '';
      if (!current || !title || !isDegenerate(current)) continue;

      let base = slugify(title) || slugify(blog['title_en'] || '') || 'post';

      // Keep uniqueness within the locale, skipping this row.
      let candidate = base;
      let counter = 1;
      while (
        await prisma.blog.findFirst({
          where: { [`slug_${loc}`]: candidate, id: { not: blog.id } },
          select: { id: true },
        })
      ) {
        candidate = `${base}-${counter}`;
        counter++;
      }

      if (candidate === current) continue;
      changes.push({
        id: blog.id,
        locale: loc,
        from: current,
        to: candidate,
        title: title.slice(0, 40),
      });
    }
  }

  if (changes.length === 0) {
    console.log('No degenerate blog slugs found.');
    await prisma.$disconnect();
    return;
  }

  console.log(`${changes.length} degenerate slug(s):\n`);
  for (const c of changes) {
    console.log(`  [${c.locale}] ${c.from}\n      -> ${c.to}\n      (${c.title})`);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write these.');
    await prisma.$disconnect();
    return;
  }

  for (const c of changes) {
    await prisma.blog.update({
      where: { id: c.id },
      data: { [`slug_${c.locale}`]: c.to },
    });
    console.log(`updated blog ${c.id} [${c.locale}] -> ${c.to}`);
  }

  console.log(
    `\nDone. Clear the blog caches (or restart the API) so the new slugs are served, ` +
      `and regenerate the sitemaps.`
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
