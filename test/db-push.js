/**
 * Push the Prisma schema to the dedicated test database.
 *
 * Derives the test DATABASE_URL the same way test/setup.ts does: host and
 * credentials from .env, database name from TEST_DATABASE_NAME in .env.test.
 * Run once before first use and again after any schema change.
 */
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

dotenv.config({ quiet: true });
dotenv.config({ path: '.env.test', override: true, quiet: true });

const testDbName = process.env.TEST_DATABASE_NAME || 'qrhit_test';
if (!testDbName.endsWith('_test')) {
  console.error(`TEST_DATABASE_NAME must end in "_test", got "${testDbName}"`);
  process.exit(1);
}
const url = new URL(process.env.DATABASE_URL);
url.pathname = `/${testDbName}`;

console.log(`Pushing Prisma schema to ${url.hostname}/${testDbName} ...`);
// Forward extra CLI args (e.g. --accept-data-loss) to prisma db push.
const extraArgs = process.argv.slice(2);
const result = spawnSync('npx', ['prisma', 'db', 'push', ...extraArgs], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url.toString() },
});
process.exit(result.status ?? 1);
