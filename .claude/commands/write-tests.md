---
description: Write/update tests for recently changed backend code (run manually now and again)
---

Backfill tests for code that changed since the last test-writing pass in
this repo (qrhit-api). Follow TESTING.md conventions strictly.

## Procedure

1. **Determine the change window.** Read `.claude/last-tested-commit`
   (gitignored marker). If it exists, the window is `<marker>..HEAD` plus
   uncommitted changes. If it doesn't exist, use the last 20 commits.
2. **Collect changed source files**: `git diff --name-status <window>` +
   `git status --porcelain`, keep only `src/**/*.ts`, exclude locales,
   templates, interfaces and pure type files.
3. **If `$ARGUMENTS` contains "coverage"**: instead of the git window, run
   `npm run test:coverage` and pick the 5 worst-covered files that contain
   meaningful business logic (skip glue/config).
4. **For each candidate file**, decide the right layer per TESTING.md:
   - pure logic → `test/unit/<name>.test.ts`
   - route/DB behavior → `test/integration/<name>.test.ts` using
     `buildTestApp` + `resetDb` + `seedBaseline` + `createTestUser`
   - websocket behavior → `test/ws/` with `startTestWsServer`
   Extend an existing suite when one covers the module already.
5. **Write the tests.** Use the helpers in `test/helpers/`. Mock external
   services at module boundaries (`vi.mock`), never let network calls
   escape. Never weaken an assertion to force a pass — if code behavior
   looks wrong, write the test against the CORRECT behavior, mark it
   `.todo`/`.fails` as appropriate, and report the suspected bug to the
   user.
6. **Run targeted suites first** (`npx vitest run <files>`), iterate to
   green, then run the full `npm test`.
7. **Report**: coverage delta (`npm run test:coverage`), and if coverage
   rose meaningfully, propose bumping `coverage.thresholds` in
   vitest.config.ts (ratchet: up only).
8. **Update the marker**: write the current HEAD hash to
   `.claude/last-tested-commit`.
