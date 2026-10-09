# Technical due diligence readiness: roadmap

Working checklist for getting QRSong! ready for a buyer's technical due
diligence (DD). Started 2026-10-09 from three read-only audits of `qrhit`,
`qrhit-api` and the sibling repos (security and privacy; code quality, tests
and CI; infrastructure, vendors and IP). We work through it over several weeks;
tick items here as they ship and add a line to the buyer document's
improvement log.

- **Buyer-facing overview** (what the stack does, plus a dated improvement log):
  the Claude Doc "QRSong! Technology Overview",
  https://claude.ai/code/artifact/b0c45aee-9b2c-458d-b490-239466ee73bb
- **This file** is internal: it names open weaknesses. Never share it with a
  buyer as is; the data room (Phase 6) gets the finished documents.

Owner tags: **[code]** = done in the repos (Claude can do it), **[Rick]** =
AWS console, accounts, contracts, lawyer or accountant.

## Keeping the buyer document current (every session)

Whenever an item here ships, or something the overview describes changes:

1. Tick it here.
2. Update the Claude Doc (a row in its improvement log, newest first, plus
   any section the change affects).
3. Make the same edit in `technology-overview.md` (this folder): the doc's
   mirror and the PDF's source. Bump `<!-- as-of: ... -->` to today.
4. Rebuild the PDF from the frontend repo:
   `node _scripts/build-tech-overview-pdf.mjs` → `QRSong-Technology-Overview.pdf`
   here (A4, brand look). Check a page or two before handing it over.

The overview must be true in production when it is shared. Before sending
the PDF to anyone, check that every improvement-log entry is deployed (the
2026-10-09 entries are on branch `security-phase0` until Rick deploys it).

## What a buyer's DD looks like

- A data-room request list: architecture, infrastructure, vendors, licences,
  security, GDPR, incidents, costs.
- Automated scans of the code: vulnerabilities and licences (SBOM), secrets.
- An external penetration test, or a request for the latest one.
- Interviews: how code reaches production, how you recover from a disaster,
  who knows what.
- An IP chain-of-title review: who owns the code, the accounts and the data.

Buyers rarely walk away over code style. They walk away, or lower the price
and add escrow or indemnities, over security holes, unclear IP ownership,
GDPR exposure, platform/ToS risk and "only the founder can run this".

Strengths to show: about 190k lines of TypeScript, about 7,900 tests at
roughly 80% coverage, a current stack (Angular 22 zoneless, Fastify 5,
Prisma 7), no secrets ever committed to git, an idempotent Mollie webhook that
re-fetches each payment, print rendering on Lambda, rich internal docs.

---

## Phase 0: urgent security fixes (sale or no sale)

Branch `security-phase0` in `qrhit-api` and `qrhit`. Not deployed until Rick
deploys.

- [x] **[code] CORS + session cookie.** Every origin got credentialed CORS
  (`src/server.ts`) and the cookie was `SameSite=None`, so a page on another
  site could act as a logged-in admin. Now: credentials only for the site's own
  origins (`src/corsOrigins.ts`), cookie `SameSite=Lax`, and a cookie on a
  request another site started is ignored (`src/cookieAuth.ts`), which also
  covers the old `SameSite=None` cookies still in browsers.
- [x] **[code] Reset/registration PIN brute force.** `customer-verify-pincode`
  had no limit and PINs came from `Math.random()`. Now: `crypto.randomInt`,
  the `pincode` limiter applied, the PIN voided after 5 wrong guesses per
  address, PIN requests limited (`pincode-request`), and the forgot-password
  limiter actually counts (it only checked). New key
  `userAccount.tooManyAttempts` (account bundle) also fixes the raw key the
  login lockout showed.
- [x] **[code] SQL injection in admin charts.** `startDate`/`endDate` were
  interpolated into SQL (`src/charts.ts`). Now only `YYYY-MM-DD` passes.
- [x] **[code] SSRF in the shortlink resolvers.** `/resolve_shortlink`,
  `/apple-music/resolve-shortlink`, `/deezer/resolve-shortlink` fetched any
  URL. Now only the services' own shortlink hosts (`src/shortlinks.ts`), and
  a Spotify redirect off Spotify's hosts is not followed.
- [x] **[code] Vulnerable dependencies.** API: `handlebars` 4.7.10 (critical;
  4 days old, Rick's call), `sharp` 0.35.5, `fastify` 5.12.5, `moment`
  2.31.0, `source-map-js` 1.2.2. Frontend: `proxy-addr` 2.0.8 (critical, in
  the SSR server's Express), `dompurify` 3.4.16, `source-map-js` 1.2.2.
  Then:
  - [x] `mysql2` (high) inside the Prisma CLI (only Prisma Studio uses it):
    `overrides.prisma.mysql2 ^3.24.5` in the API's `package.json`, since
    Prisma 7.10 pins 3.15.3. Drop the override once a Prisma release ships a
    fixed mysql2. The API audits clean (0 vulnerabilities).
  - [x] `quill` 2.0.3 (CVE-2025-15056, XSS in the HTML export of the formula
    and video embeds; no patched release, and 2.0.2, npm audit's "fix", has
    the same code; no release since 2024-11): **removed**. Its only use, the
    App Designer's help text, is now a Markdown editor
    (`shared/app-design-editor/help-text-editor/`, converters in
    `help-text-markdown.ts`) that saves exactly the HTML Quill saved, so the
    API, the database and the app are unchanged; a text opened and saved
    unchanged comes out byte for byte the same (spec). `quill`, `ngx-quill`
    and the global `quill.snow.css` are gone. The frontend audits clean
    apart from the `growl` false positive.
  - `growl` (critical) is a false positive: npm audit takes the local
    `file:../growl` tool for an old npm package of the same name. Goes away
    with the Phase 1 clean-install item.
- [x] **[code] Small items.** `POST /tidal/disconnect` moved to the admin
  routes (admin only; nothing in the frontend calls it); `GET /test` leaves
  out the private IP in production; global body limit 100 MB → 20 MB, with
  30 MB kept on the three base64 image routes (`BASE64_IMAGE_BODY_LIMIT`).
  Deliberately left: `/theme/debug/all` (the app's dev theme picker; customer
  themes are already left out in production) and the frontend's `/debug-geo`
  (echoes the visitor's own geo headers).
- [ ] **[Rick] AWS console checks.**
  - Production `JWT_SECRET` is not the local value; rotate if unsure
    (everyone logs in again).
  - RDS is not publicly accessible. (2026-10-09: it is: `kwisbaas...` resolves
    to a public address and answered on 3306 from the laptop until the IP
    changed, so it is public behind an IP allowlist. Make it private and reach
    it through a bastion or SSM, and move dev/test databases off it.)
  - ALB/EC2 security groups only accept CloudFront (else the
    `CloudFront-Viewer-Address` header can be spoofed, e.g. into the trusted
    IP list).
  - IMDSv2 required on the EC2 instances.

## Phase 1: how code reaches production (1 to 2 weeks)

The first thing a DD interviewer asks about.

- [x] **[code] Integration suite green again** (2026-10-09). 29 tests in 10
  files had gone red on `main` since 2026-09-12, unnoticed for lack of CI:
  blog admin tests for removed routes, a seed without the `companyadmin`
  group, two new markets, the FX "complete day" refetch, new response
  fields, and a `qrhit_test` schema never pushed after 2026-10-07. One was a
  real bug: help text such as "Have <fun>" was treated as HTML and lost its
  text (API `sanitizeHelpText` and the site now test for real tags).
- [ ] **[code] CI on GitHub Actions** for both repos: build, unit tests,
  `node _scripts/i18n-check.mjs`, `npm audit --audit-level=high`. The
  integration suite needs a test database, so CI either gets one (a MySQL
  service container) or runs unit tests only and the integration suite
  stays a pre-deploy step.
- [ ] **[Rick] Branch protection** on `main`.
- [ ] **[code+Rick] Prisma migrations instead of `prisma db push`.** The deploy
  scripts run `sudo prisma db push` against production; 65 models have 2
  hand-written migrations.
  1. Apply the pending db pushes (see memory notes).
  2. Diff production against `schema.prisma` (live database: ask first).
  3. Create the `0_init` baseline, mark it applied (`migrate resolve --applied`).
  4. `prisma migrate deploy` in the deploy scripts from then on.
- [ ] **[code] Deploy scripts.** `npm ci` instead of `sudo npm install
  --force`, no `sudo`, run the tests before the restart, a written rollback
  (keep the previous build, pm2 back to it).
- [ ] **[Rick] Staging.** The dev database `qrhit_dev` sits on the production
  RDS instance; development goes through ngrok to the laptop. Minimum: a
  separate database server for dev/staging and a `staging.qrsong.io`.
- [ ] **[code] Clean installs.** `"growl": "file:../growl"` in the frontend's
  devDependencies breaks `npm ci` without the sibling repo; the API's tests are
  never type-checked (`tsconfig` excludes `test`): add `tsconfig.test.json`.
- [ ] **[code] Minimal ESLint**: new `any` and unused code only, no mass
  reformat.

## Phase 2: infrastructure and continuity (1 to 2 weeks, mostly AWS console)

- [ ] **[Rick] Write down what runs**: instances and Name tags, the auto
  scaling group, EFS or not, RDS Multi-AZ, backup retention and point-in-time
  recovery, where Redis runs and whether it persists, which machine hosts the
  Spotify scraper. (`docs/features_final.md` makes claims the code cannot
  confirm.)
- [ ] **[code+Rick] Backups and disaster recovery.** Uploads, PDFs, invoices
  and company files live on local disk (`PUBLIC_DIR`/`PRIVATE_DIR`): move to S3
  (versioned) or AWS Backup. One restore drill (database plus files), with the
  RTO/RPO it achieved written down.
- [ ] **[Rick] Secrets.** An instance role instead of the long-lived IAM keys
  (SES, Lambda, EC2-describe, CloudFront); `.env` (129 variables) into SSM
  Parameter Store or Secrets Manager; delete unused keys (OpenRouter, Gemini,
  Perplexity, IPLookup, ELB, Route53, ...).
- [ ] **[code] Complete `.env.example`**: it lists 4 variables, the code reads
  about 110.
- [ ] **[code+Rick] Monitoring.** A `/health` endpoint and an external uptime
  monitor; central logs (CloudWatch agent); alerts to more than one person;
  heartbeats for the scheduled jobs so a missed run alerts (if the main-server
  lookup fails, every job silently stops: `src/utils.ts`).
- [ ] **[code] Multi-instance safety.** `review.ts` and `shipping.ts` run on
  every production instance (gate `isMainServer || ENVIRONMENT !=
  'development'`, so also when `ENVIRONMENT` is unset); the review mail has no
  lock (`review.ts`), so a second instance sends it twice. Redis lock or the
  main-server gate. The chat cleanup (`chat.ts`) and the hourly
  track-enrichment reload run on every process too.
- [ ] **[code] Scheduler hygiene** (found 2026-10-09 by the scheduled-jobs
  inventory; the buyer doc lists the twenty jobs that run):
  - The Merchant Center upload (daily 04:00), the AI product images (daily
    01:00) and the Channable feed (daily 05:00) are **never scheduled**:
    `merchantcenter.ts` and `channable.ts` are only loaded by `await import`
    inside request handlers, which run in cluster workers, where the
    `cluster.isPrimary` gate is false. Check whether the Merchant Center feed
    is stale; move the crons to startup.
  - `Mollie`'s constructor schedules its 01:00 cleanup, and the primary
    constructs `new Mollie()` five times at boot (plus once per generator job
    when queue workers run there): five concurrent runs of "release expired
    discount reservations, delete expired/canceled payments". Make it a
    singleton or move the cron to startup; check that the release cannot
    double-count.
  - Whether the BullMQ queues are processed depends on `RUN_QUEUE_WORKERS`
    on the main server; no standalone `worker.ts` process is in the deploy
    scripts. Document it.
- [ ] **[Rick] Infrastructure as code, light.** At least the CloudFront, ALB
  and security-group config exported into the repo with a diagram
  (`qrhit/_cloudfront/*.json` holds hand-edited copies).

## Phase 3: IP, ownership and licences (in parallel; partly legal)

The area most likely to delay a deal.

- [ ] **[Rick] GitHub organisation**; transfer `qrhit`, `qrhit-api`,
  `qrhit-app`, `qrhit-lambda-pdf`, `qrhit-spotify-scraper`.
- [ ] **[Rick] `qrhit-lambda` (production QR rendering) has no remote**: it
  exists only on the laptop. Push it.
- [ ] **[Rick] Commit the uncommitted change in `qrhit-lambda-pdf`.**
- [ ] **[Rick] Skill repos** (`skill-box-designer`, `skill-qrsong`,
  `skill-qrsong-quotation`, zero commits): first commit, or exclude from the
  deal on purpose.
- [ ] **[Rick] Archive abandoned repos**: flutter, ios, game, melvin, scraper,
  as.
- [ ] **[Rick] Chain of title for `capacitor-spotify-remote`** (the app's
  playback plugin): remote `SourceOneMedia/...`, no LICENSE, 2 unpushed
  commits. Clarify ownership, add a licence.
- [ ] **[Rick] Accounts to company-owned logins** (not a personal Gmail) in a
  shared password vault: AWS root, domain registrar, Apple Developer (team
  `7CNC4K97KZ`; bundle id `nl.rickgroenewegen.qrsong` stays, the app can be
  transferred), Google Play, Mollie, the Spotify developer app, Tidal and
  Pushover tokens, every vendor in the register.
- [ ] **[code] SBOM and licence report** (`npm sbom`, CycloneDX) per repo.
- [ ] **[Rick] ApexCharts**: free licence ends at $2M annual revenue
  (commercial licence or replace).
- [ ] **[code] `ytmusic-api` is GPL-3.0** (server-side only): isolate or
  replace. The 13 `hyphenation.*` packages declare no licence.
- [ ] **[Rick] Commercial fonts** (Interstate, Moret, Aeonik) in
  `qrhit-api/assets/fonts`, no licence, served publicly: find the client's
  licence or take them off the public path.
- [ ] **[Rick] Client brand assets** (`src/_data/themes`,
  `assets/images/clients`): confirm consent.
- [ ] **[Rick, lawyer] Competitor and trademark exposure**: the nightly fetch
  of the competitor's `gameset_database.json` (`externalCardService.ts`) and
  `docs/j.json`; resolving the competitor's card URLs; the comparative SEO
  pages.
- [ ] **[code+Rick] Spotify Developer Terms**, the biggest business risk a
  buyer will see: when the official API rate-limits, `spotify.ts` falls back
  automatically to a scraper of Spotify's internal API (Chrome via ngrok on a
  desktop). Make it a switch, measure the business impact without it,
  document the Spotify app's quota mode. Playback through the official App
  Remote SDK is fine; say so.
- [ ] **[Rick] Statement on AI-written code**: 53% of frontend and 31% of API
  commits are authored by "aider". Tools used, Rick owns the output, no code
  copied from licensed sources.
- [ ] **[code] Repo hygiene with IP weight**: untrack
  `.claude/settings.local.json`; remove the committed customer Excel
  `public/excel/supplemented_...xlsx` (personal data); remove
  `assets/downloads/qrsong.zip` (45.8 MB, a signed APK).

## Phase 4: privacy and GDPR (1 to 2 weeks)

- [ ] **[Rick] Record of processing** (GDPR art. 30) and a sub-processor list
  with signed DPAs: Mollie, AWS, EmailOctopus, Print&Bind, PostNL,
  TrackingMore, Moneybird, OpenAI, Anthropic, ConvertAPI, PostHog, Firebase,
  Google, Crisp, Trustpilot. The privacy policy names the AI processors
  (contact-form mail and chat go there).
- [ ] **[code] Retention policy plus a nightly purge.** Paid orders, IP
  addresses, voting submissions, contact mails and uploaded photos are kept
  forever today. Proposal: orders 7 years (Dutch tax rules), IPs 90 days,
  photos N months after printing, voting submissions after the event.
- [ ] **[code] Data-subject rights**: self-service account deletion and data
  export, or a written admin procedure with an SLA (only the admin can delete
  today).
- [ ] **[code] Personal data by order id alone**: `GET
  /progress/:playlistId/:paymentId` returns name, e-mail and address; `GET
  /invoice/:paymentId` never expires; printer PDFs are public at a predictable
  path (`generator.ts`). Signed, expiring tokens; private PDFs behind signed
  URLs.
- [ ] **[code] Personal data in logs**: about 21 log calls write e-mails, IPs or
  addresses (`mail.ts`, `printenbindV2.ts`, ...). Mask them.
- [ ] **[Rick] Consent Mode v2** configured in the GTM container (GTM loads
  before consent).

## Phase 5: code polish (ongoing; only what a reviewer notices)

- [ ] **[code] Open bugs list** `qrhit/BUGS_FOUND_BY_TESTS.md`: money bugs #3
  (VAT on the price before discount), #4 (games fee per line, not per copy),
  #5 (promotional credit counted twice) are listed open but their pinning
  markers seem gone: verify, fix or close. #19 (customers cannot change their
  password) is still pinned: fix.
- [ ] **[Rick, accountant] If #3 was ever live**: quantify the historic VAT
  impact.
- [ ] **[code] READMEs** per repo (what, local setup, test, deploy) and a
  `docker-compose.yml` for MySQL and Redis.
- [ ] **[code] Stale docs**: `docs/BACKEND_INVENTORY_ACQUISITION.md`
  (2025-11), `TESTING.md` (Angular 21 branch), the CLAUDE.md line "Database
  migrations handled by Prisma".
- [ ] **[code] Clutter out of the repo roots**: 13 screenshots, 7 ad-hoc
  reports, `fix-qrsong-branding.py`, `push`, `test-channable.ts`,
  `test-merchant-center.ts`.
- [ ] **[code] Frontend coverage gate**: 81.8% against a threshold of 86%;
  enforce in CI, then raise coverage or set the threshold honestly.
- [ ] **[code] Schema validation** on public and payment routes first (8 of
  446 routes have it).
- [ ] **[code] Tokens**: JWT lifetime 30 days sliding instead of 1 year, a
  `tokenVersion` for revocation, admin rights checked against the database on
  admin routes; stop keeping the token in `localStorage`; re-enable the
  frontend CSP (commented out in `qrhit/server.ts`; blog HTML uses
  `bypassSecurityTrustHtml`).

Not before a DD: rewriting the very large files (`adminRoutes.ts` 5.7k lines,
`card-designer.component.ts` 2.8k), chasing every `any` (1,444 in the API),
migrating Karma, rewriting git history to shrink the 381 MB pack. A buyer
notes these and moves on; the churn adds risk.

## Phase 6: data room pack (`qrhit-api/docs/due-diligence/`)

- [ ] Architecture overview with a diagram (in the Claude Doc).
- [ ] Infrastructure inventory (from Phase 2).
- [ ] Vendor register: purpose, criticality, owner account, DPA, monthly cost.
- [ ] Repo and app inventory.
- [ ] Security overview, plus an **external pentest after Phases 0 and 1**
  (the strongest single signal).
- [ ] Backup and DR runbook with evidence of the restore drill.
- [ ] Deploy and rollback runbook.
- [ ] Incident history.
- [ ] SBOM and licence report.
- [ ] GDPR documents (Phase 4).
- [ ] Monthly infrastructure and SaaS costs (the AI costs page covers LLM
  spend).
- [ ] Key-person plan: the laptop-only workflows (quotations via Spark/qquote,
  box design, translations, Schneider mails, app signing, Lambda deploys) and
  how a successor runs each.

## Verification per item

- CORS: `curl -H 'Origin: https://evil.example' -i <api>/...` returns no
  `Access-Control-Allow-Credentials`; the site and the scan app still log in.
- PIN: integration tests (`test/integration/account-customer.test.ts`,
  "pincode guessing").
- Charts / SSRF: unit tests with a quote in a date and with
  `http://169.254.169.254/`.
- Gates: `npm audit --omit=dev` without high or critical; API `npx vitest
  run`; frontend `npm test`, `npx ng build --configuration=development` (never
  `npm run build`), `node _scripts/i18n-check.mjs`.
- Migrations: `prisma migrate status` clean on a staging copy first.
- DR: a timed restore into a scratch RDS instance.
