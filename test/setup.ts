/**
 * Global Vitest setup. Runs before each test file (same fork).
 *
 * Order matters: environment variables must be finalized BEFORE any src/
 * module is imported, because several modules (prisma, cache, mail, ...)
 * read process.env at import time.
 */
import { vi } from 'vitest';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Mirror the BigInt JSON serialization patch from the production
// entrypoints (src/app.ts, src/worker.ts): buildForTesting() boots Server
// directly and would otherwise 500 on raw-SQL LONGLONG values.
(BigInt.prototype as any).toJSON = function () {
  const int = Number.parseInt(this.toString());
  return int ?? this.toString();
};

// 1. Real .env first (DB/Redis hosts + credentials stay out of the repo),
//    then .env.test overrides (ENVIRONMENT=test, scratch dirs, REDIS_DB...).
dotenv.config({ quiet: true });
dotenv.config({ path: '.env.test', override: true, quiet: true });

// 2. Point DATABASE_URL at the dedicated test database: same server and
//    credentials as .env, different database name.
const testDbName = process.env['TEST_DATABASE_NAME'] || 'qrhit_test';
if (!testDbName.endsWith('_test')) {
  throw new Error(
    `TEST_DATABASE_NAME must end in "_test" (got "${testDbName}") — refusing to run tests against a non-test database.`
  );
}
const devUrl = process.env['DATABASE_URL'];
if (!devUrl) {
  throw new Error('DATABASE_URL missing — tests need .env with database credentials.');
}
const parsed = new URL(devUrl);
parsed.pathname = `/${testDbName}`;
process.env['DATABASE_URL'] = parsed.toString();
process.env['DATABASE_NAME'] = testDbName;

// 3. Scratch directories for anything that writes files. @fastify/static
//    requires absolute roots, so resolve the relative .env.test paths here.
for (const key of ['PUBLIC_DIR', 'PRIVATE_DIR', 'ASSETS_DIR', 'APP_ROOT'] as const) {
  process.env[key] = path.resolve(process.env[key]!);
}
for (const dir of [
  process.env['PUBLIC_DIR']!,
  process.env['PRIVATE_DIR']!,
  process.env['ASSETS_DIR']!,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

// 4. Globally mock outbound side-effect modules. ENVIRONMENT=test is treated
//    as "not development" by mail/pushover/printer, i.e. they would really
//    send — so they are never allowed to load for real in tests.
//    Each mock is a recording proxy: every method call is captured and
//    resolves to undefined unless a suite overrides it.
import { makeRecordingSingleton, outbound } from './helpers/recording-mock';

vi.mock('../src/mail', () => makeRecordingSingleton('Mail'));
vi.mock('../src/pushover', () => makeRecordingSingleton('PushoverClient'));
vi.mock('../src/push', () => makeRecordingSingleton('Push'));
vi.mock('../src/printer', () => makeRecordingSingleton('Printer'));
vi.mock('../src/printers/printenbind', () => makeRecordingSingleton('PrintEnBind'));

// 5. Safety net: any fetch to a non-local URL inside tests is a missed mock.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(url)) {
    return realFetch(input, init);
  }
  outbound.blockedFetches.push(url);
  return Promise.reject(
    new Error(`Unmocked external fetch in test: ${url}`)
  );
}) as typeof fetch;
