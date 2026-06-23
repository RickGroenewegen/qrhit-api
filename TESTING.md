# Testing qrhit-api

Vitest test harness. All suites live in `test/`; nothing in `src/` is
test-only except the two factory methods on `Server`.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Full suite (unit + integration + websocket), serial |
| `npm run test:watch` | Watch mode |
| `npm run test:unit` | Pure unit tests only (fast, ~10s) |
| `npm run test:int` | Integration + websocket suites (hits test DB/Redis) |
| `npm run test:coverage` | Full suite + V8 coverage report + thresholds |
| `npm run test:db:push` | Push prisma schema to the test database (run after every schema change) |

## How the environment works

`test/setup.ts` loads your real `.env` first (DB/Redis hosts + credentials —
never committed), then `.env.test` overrides (committed, no secrets), then
rewrites `DATABASE_URL` to the database named by `TEST_DATABASE_NAME`
(default `qrhit_test`, must end in `_test` — guarded in two places so a
misconfiguration can never truncate dev data).

- **MariaDB**: `qrhit_test` on the same server as your dev DB. Schema via
  `npm run test:db:push`. Suites call `resetDb()` (truncates everything in
  one FK-checks-off transaction) + `seedBaseline()` (user groups).
- **Redis**: same server, **db 9** (`REDIS_DB=9`, honored by `src/cache.ts`).
  `flushTestRedis()` refuses to run unless `REDIS_DB=9`.
  ⚠️ Exception: game-room state (websocket-native.ts, gameRoutes) hardcodes
  **db 1** in production code; ws tests use throwaway UUID keys with short
  TTLs there.
- **`ENVIRONMENT=test`** keeps dev-gated cron jobs off. Gotcha: several
  modules treat anything `!== 'development'` as production (mail, pushover,
  printers, fx) — that's why `test/setup.ts` globally mocks
  mail/pushover/push/printer with recording proxies (see
  `test/helpers/recording-mock.ts`; assert with `outbound.calls(...)`,
  program returns with `outbound.respondWith(...)`).
- Non-localhost `fetch` is blocked and throws; axios is NOT blocked — mock
  at the module boundary (see `test/unit/fx.test.ts`).
- BigInt JSON serialization is patched in setup to mirror `src/app.ts`.

## Writing tests

- **Unit** (`test/unit/`): import the module, mock collaborators with
  `vi.mock`. No DB/Redis.
- **Integration** (`test/integration/`): `buildTestApp()` →
  `fastify.inject()`. Skeleton:

  ```ts
  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
  });
  afterAll(async () => closeTestApp(app));
  ```

  Auth: `const { user, token } = await createTestUser({ groups: ['admin'] })`
  then `headers: authHeader(token)`. Captcha:
  `vi.spyOn(Utils.prototype, 'verifyRecaptcha').mockResolvedValue({ isHuman: true, score: 0.9 })`.
- **Websocket** (`test/ws/`): `startTestWsServer()` + `WsTestClient` from
  `test/helpers/wsServer.ts`.
- Files run serially (shared DB) — never assume another suite's data.
- Never weaken an assertion to make a test pass; match real behavior and
  flag suspected bugs.

## Coverage ratchet

`vitest.config.ts` `coverage.thresholds` are a one-way ratchet: set just
below achieved coverage, never lowered. After meaningful gains, raise them.
