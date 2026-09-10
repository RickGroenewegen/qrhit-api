/**
 * Writes a card-sized WebP next to every existing blog image.
 *
 * The blog slider shows these in a 316x178 card but was given the full
 * 1280x720 JPEG, so four cards cost roughly 340KB on every landing page and on
 * the homepage. New images get a thumbnail from generateBlogImage(); this
 * covers the ones already on disk.
 *
 *   npx tsx _scripts/build-blog-thumbnails.ts          # report only
 *   npx tsx _scripts/build-blog-thumbnails.ts --apply  # write them
 *
 * Safe to re-run: existing thumbnails are skipped unless --force is given.
 */
import 'dotenv/config';
import { readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { thumbnailNameFor } from '../src/chatgpt';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');
  const dir = path.join(process.env['PUBLIC_DIR'] || 'public', 'blog_images');

  if (!existsSync(dir)) {
    console.error(`No blog image directory at ${dir}`);
    process.exit(1);
  }

  const files = (await readdir(dir)).filter((f) => /\.(jpe?g|png)$/i.test(f));
  let before = 0;
  let after = 0;
  let written = 0;

  for (const file of files) {
    const from = path.join(dir, file);
    const to = path.join(dir, thumbnailNameFor(file));
    if (existsSync(to) && !force) {
      console.log(`skip ${file} (thumbnail exists)`);
      continue;
    }
    const originalSize = (await stat(from)).size;
    before += originalSize;
    if (apply) {
      await sharp(from).resize(640, 360, { fit: 'cover' }).webp({ quality: 72 }).toFile(to);
      const thumbSize = (await stat(to)).size;
      after += thumbSize;
      written++;
      console.log(
        `${file}: ${Math.round(originalSize / 1024)}KB -> ${Math.round(thumbSize / 1024)}KB`
      );
    } else {
      console.log(`would build thumbnail for ${file} (${Math.round(originalSize / 1024)}KB)`);
    }
  }

  if (apply) {
    console.log(
      `\nWrote ${written} thumbnail(s): ${Math.round(before / 1024)}KB of originals now ${Math.round(after / 1024)}KB in the slider.`
    );
  } else {
    console.log(`\n${files.length} image(s) scanned. Re-run with --apply to write thumbnails.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
