/**
 * One-off: pull every live blog post, in every locale, from the public API into
 * a directory of raw JSON so the markdown migration has a stable input that does
 * not depend on the database or on the network a second time.
 *
 * The public endpoints only ever return active posts, which is deliberate: the
 * migration should carry across what is actually published, not draft rows that
 * nobody has looked at since they were written.
 *
 * Usage: node scripts/fetch-live-blogs.mjs <outDir>
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API = process.env.BLOG_API ?? 'https://api.qrsong.io';

// qrhit's own locale codes, not the ISO ones. `jp`, `cn` and `no` are the
// directory names the app and the sitemaps use; the ISO forms (ja, zh, nb)
// only ever appear in hreflang attributes.
const LOCALES = [
  'en', 'nl', 'de', 'fr', 'es', 'it',
  'pt', 'pl', 'jp', 'cn', 'sv', 'no',
];

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node scripts/fetch-live-blogs.mjs <outDir>');
  process.exit(1);
}

const get = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

const unwrap = (payload, key) =>
  Array.isArray(payload) ? payload : payload?.[key] ?? payload?.data ?? payload;

await mkdir(outDir, { recursive: true });

// The English list is the spine: it defines which posts exist and their ids.
const index = unwrap(await get(`${API}/blogs/en`), 'blogs');
console.log(`posts: ${index.length}`);

// Each detail response carries `allSlugs`, which is the only place the
// per-locale slug mapping is exposed. Fetching one English detail per post is
// enough to learn every locale's slug, so the per-locale loop below can address
// posts directly instead of listing all twelve locales first.
const slugsById = new Map();
for (const post of index) {
  const detail = unwrap(await get(`${API}/blogs/en/${post.slug}`), 'blog');
  slugsById.set(post.id, detail.allSlugs ?? { en: post.slug });
}

const results = [];
let missing = 0;

for (const post of index) {
  const allSlugs = slugsById.get(post.id);
  const record = { id: post.id, image: post.image, allSlugs, locales: {} };

  for (const locale of LOCALES) {
    const slug = allSlugs?.[locale];
    if (!slug) {
      missing++;
      console.warn(`  ! post ${post.id} has no ${locale} slug`);
      continue;
    }
    try {
      const detail = unwrap(await get(`${API}/blogs/${locale}/${slug}`), 'blog');
      record.locales[locale] = {
        slug,
        title: detail.title,
        summary: detail.summary,
        content: detail.content,
        createdAt: detail.createdAt,
        updatedAt: detail.updatedAt,
      };
    } catch (err) {
      missing++;
      console.warn(`  ! post ${post.id} ${locale}: ${err.message}`);
    }
  }

  results.push(record);
  const got = Object.keys(record.locales).length;
  console.log(`  [${post.id}] ${got}/${LOCALES.length} locales  ${post.slug}`);
}

await writeFile(
  path.join(outDir, 'raw-blogs.json'),
  JSON.stringify(results, null, 2),
  'utf8'
);

console.log(`\nwrote ${results.length} posts to ${outDir}/raw-blogs.json`);
if (missing) console.log(`WARNING: ${missing} locale fetches did not land`);
