/**
 * Clears the cached featured-playlist lists.
 *
 * getFeaturedPlaylists caches its result per day and locale, so a change to a
 * playlist description is not visible on /playlists or a product page until
 * that key goes. Running redis-cli by hand is easy to get wrong: the key is
 * prefixed with the API's package version, and REDIS_URL may not be the Redis
 * a bare redis-cli connects to. This uses the app's own cache client, so the
 * server, the database index and the prefix are all whatever the API uses.
 *
 *   npx tsx _scripts/clear-featured-cache.ts          # list the keys only
 *   npx tsx _scripts/clear-featured-cache.ts --apply  # delete them
 */
import 'dotenv/config';
import Cache from '../src/cache';
import { CACHE_KEY_FEATURED_PLAYLISTS } from '../src/data/featuredPlaylists';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const cache = Cache.getInstance();
  await cache.init(); // reads the version that prefixes every key

  const pattern = `*${CACHE_KEY_FEATURED_PLAYLISTS}*`;
  console.log(`Redis: ${process.env['REDIS_URL']}`);
  console.log(`Looking for keys matching ${pattern}`);

  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, keys]: [string, string[]] = await cache.executeCommand(
      'scan',
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      500
    );
    cursor = next;
    found.push(...keys);
  } while (cursor !== '0');

  if (found.length === 0) {
    console.log(
      '\nNo cached lists found. Either they have already gone, or this is not the Redis the API writes to.'
    );
  } else {
    console.log(`\n${found.length} key(s):`);
    found.forEach((k) => console.log(`  ${k}`));
    if (apply) {
      await cache.executeCommand('del', ...found);
      console.log(`\nDeleted ${found.length} key(s). The next request rebuilds them from the database.`);
    } else {
      console.log('\nNothing deleted. Re-run with --apply.');
    }
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
