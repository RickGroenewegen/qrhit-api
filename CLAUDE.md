# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development Commands
- `npm run start:dev` - Start development server with TypeScript watch mode and nodemon
- `npm run start:dev2` - Alternative development server using tsx watch
- `npm run build` - Build TypeScript to JavaScript (outputs to ./build)
- `npm run start` - Start the production server; builds first only when `./build` is stale (see "Startup and deploys")
- `npm run test` - Run the vitest suites (see TESTING.md)

### Production Commands
- `npm run start_pm2` - Production deployment with git pull, npm install, prisma db push, build, and start

### Database Commands
- `npx prisma db push` - Push schema changes to database
- `npx prisma generate` - Generate Prisma client
- `npx prisma studio` - Open Prisma Studio for database management

### TypeScript Commands
- `tsc` - Compile TypeScript
- `tsc -w` - Watch mode compilation

## Scripts (_scripts folder)

### Locale/Translation Management

1. **remove-from-cache.sh**
   - Removes translation keys from translated.cache files (src/locales, build/locales, src/locales/business)
   - Usage: `./_scripts/remove-from-cache.sh key1 key2 key3 ...`
   - Example: `./_scripts/remove-from-cache.sh mail.promotionalCtaSubtitle mail.promotionalSaleSubject`
   - Use this after modifying translation keys in en.json to ensure translations are regenerated

2. **rebuild-locales.sh**
   - Rebuilds the API to update locale files in the build folder
   - Usage: `./_scripts/rebuild-locales.sh [key1 key2 ...]`
   - Keys are optional and just logged for documentation purposes

### Production, read-only

3. **ro-query.sh**
   - One query against the production database as the read-only user (`LIVE_DB_READONLY_*`, host from `DATABASE_URL`), with a 10 s limit
   - Usage: `./_scripts/ro-query.sh [--vertical|--batch] "SELECT …"`; anything but SELECT/SHOW/DESCRIBE/EXPLAIN/WITH is refused (`--batch` is tab-separated with a header, for scripts)
   - Keep it narrow (indexed ids, LIMIT): it is the live database

### Languages, countries, currencies: `src/data/shared/`

`locales.json`, `markets.json` and `currencies.json` are the one source for the
API, the website and the scan app. Edit them here, then run
`node scripts/sync-shared-data.mjs`: it copies them into `qrhit` and
`qrhit-app` and writes `shared-data.generated.ts` in all three (typed accessors
plus the `LocaleCode` / `MarketCode` / `CurrencyCode` unions). `LOCALE_DATA`,
the currency maps and snap steps, the Mollie method/locale/currency tables,
the occasion markets, hyphenation, the playlist prompt's language names and
the product feed tables all derive from them; a new hand-written list of
language or country codes is a regression. `test/unit/shared-data.test.ts`
fails on drift, on a site language without its database columns, and on a
dangling reference. Adding a language or currency: `NEW_LANGUAGE.md`.

### Translation Files
- Translations are stored in `src/locales/*.json` (en.json, nl.json, de.json, etc.)
- Translation cache files exist at: `src/locales/translated.cache`, `build/locales/translated.cache`
- Changed English is translated again by itself (2026-10-12): `translated.hashes` next to each cache holds a fingerprint of the English each key was translated from, and a key whose `en.json` text changed is translated into every language again. A key with no fingerprint is only recorded; more than 25 changed keys in a bundle are listed and left alone until `node translate.js --retranslate-changed`. `remove-from-cache.sh` is now only for forcing a new translation of unchanged English.
- `translate.js` uses Claude Opus 5.5 (effort high, structured output, the bundle's rules as a cached system prompt), like the site's and the app's.
- **Removing a key** means removing it from every `src/locales/*.json` and from the cache: `translate.js` never prunes. Before removing, check every way a key is read: `translate('ns.key')`, and `getTranslationsByPrefix(locale, 'ns')`, which hands a whole namespace to a mail template, a view or code (`invoice.ejs` even reads `translations[payment.paymentMethod]`). Cleaned up on 2026-10-09: 99 unused keys plus 29 that existed only in other languages. The old web app's `assets/i18n/` went too.
- `translate.js` runs both bundles; `node translate.js business` limits it to one

### Business document copy (`src/locales/business/`)

Quotations, technical instruction PDFs and MoneyBird invoice lines are B2B
correspondence and must read as **formal** (German `Sie`, Dutch `u`). The main
`src/locales/*.json` bundle is deliberately informal (`translate.js` prompts for
German `du`), so that copy must never be reused for these documents. They read
from a separate bundle instead:

- `src/locales/business/{en,nl,de}.json` — flat dotted keys under the
  `quotation.*`, `instructions.*`, `invoice_lines.*`, `pricing.*` and
  `defaultPlaylists.*` prefixes (`pricing.*` covers the price-list brochure and
  the partials `front_page` and `closing_page`; `defaultPlaylists.*` is the
  default playlists brochure, which reuses those partials through a
  translator that falls back to `pricing.*` for any key it does not define
  itself, see "Default playlists"). The `suggestions.*` keys went with the
  playlist suggestions brochure on 2026-10-16.
- Only these three languages are produced. `Translation.resolveBusinessLocale()`
  is the single fallback point: any other `Company.locale` becomes `en`. Missing
  keys fall back to the English string, never to `undefined`.
- `nl.json` is the original hand-written Dutch (it is the source these documents
  were written in) and `de.json` is hand-written German. Both are pre-seeded in
  `src/locales/business/translated.cache`, so `translate.js` will not overwrite
  them; only newly added keys get generated, using the bundle's formal prompt.
  That prompt carries a fixed vocabulary (Dutch "doos/dozen", "proefdoosjes",
  "omdozen", "playlist", "digitale proef", "jaartal", "sjablonen", "btw"), so
  one box is never a doos, a box and a doosje on one page.
  `_scripts/remove-from-cache.sh` cleans this bundle's cache too. A key removed
  from `en.json` has to leave `nl.json`/`de.json` as well: `translate.js` never
  prunes, and an orphan with a `{{placeholder}}` fails the translation test.
- **The technical instructions are two pages in every language** (2026-10-15):
  boxes on the first, cards with the tip and the footer on the second. The print
  rules at the end of `technical_instructions.ejs` do it (no container padding on
  top of the 15 mm `@page` margin, a page break before the card section, tighter
  list rows); they come last because a print rule placed above the base rules
  loses to them. German runs longest (page two at ~251 of 267 mm): after changing
  the copy, print nl/en/de for both printers the way the Lambda does (viewport
  1920x1080, A4, margin 0, `preferCSSPageSize`) and count the pages. Before this
  the German document came out on three pages, the first holding only the title.
- **The Algemene Voorwaarden / IP clauses in this bundle are contract text.**
  Have any change to `quotation.terms*` / `quotation.ip*` reviewed before it
  reaches a customer.

Consume them via `translation.getBusinessTranslator(locale, prefix)`, which
returns a `t(key, vars)` for EJS views, and `translation.getIntlTag(locale)` for
date/currency formatting (this is what makes German render `1.234,56 €` and
`1. September 2026`). All four PDF routes (quotation, technical instructions,
retail and reseller price lists) are screenshotted by Lambda, which has no
session, so the language travels in the URL as `?locale=`.

Where the language comes from differs per document:

| Document | Source |
|---|---|
| Quotation, technical instructions, MoneyBird invoice | `Company.locale` |
| Price lists, from a company's Documents tab | that company's `Company.locale` |
| Price lists, from the standalone Pricing Tables page | an explicit picker (no company context to infer from; defaults to `nl`) |

The price-list PDF routes name the download from the bundle and return it in
`Content-Disposition`; the frontend reads the name from that header rather
than duplicating the mapping.

### The price-list brochure (rebuilt 2026-10-05)

One brochure, `src/views/price_list.ejs` with one partial per page in
`src/views/partials/brochure/`, in three editions (`src/priceList.ts`):

| edition | for | prices |
|---|---|---|
| `retail` | companies ordering from us | recommended price per box |
| `reseller` | resellers; adds a "Working together" page | purchase price, RRP under it |
| `client` | what a reseller forwards to their client | **none**: no amounts, no VAT, no costs, no wordmark, none of our contact details |

The pages answer what business clients asked by mail in 2026 (how it works and
the music, the box, what is included and the options, who does what, planning,
prices, questions). Rick's rules for the copy: never mention removing duplicate
songs, no free box design (only the design service, and most clients design
themselves), lead time "about 15 working days, a little longer during the
holidays", shipping included to one address in the Netherlands only, sample
boxes are in the standard QRSong! design, the Deezer/Tidal preview without a
subscription only as a small footnote.

- Prices come from `buildPriceList`: the printer cost, the saved profit table
  and `priceFromCost` (`src/services/boxPricing.ts`, the Schneider
  calculator's tier pick and rounding), and it refuses a tier without our
  margin (never a list at the printer's cost).
- The GET views (`/business/{edition}-pricing`) render only from a URL the PDF
  route signed (`priceListQuery`, HMAC on `JWT_SECRET`); unsigned they answer
  403. Before 2026-10-05 anyone could render them with an empty matrix and
  read the cost per box.
- The PDF routes take `profitMatrix` only from the Pricing Tables page (unsaved
  numbers can be printed); everything else uses the saved table. The company
  Documents tab sends just the language. The client edition needs no table.
- One-off option prices (custom app, voting portal, design service) are
  `src/businessOptions.ts`; `business.ts` still prices quotations with literals.

## Print&Bind (physical card printing)

Two integrations exist and an admin toggle picks one at runtime:

| file | API | env |
|---|---|---|
| `src/printers/printenbindV2.ts` | REST, https://www.printenbind.nl/api/docs (OpenAPI at `/api/openapi.json`) | `PRINTENBIND_API_URL` (`.../api/rest`) |
| `src/printers/printenbindV1.ts` | legacy JSON (`/v1/orders`, `/v1/delivery`), kept as rollback | `PRINTENBIND_V1_API_URL` (bare `.../api`, the code appends `/v1`) |

`src/printers/printenbind.ts` is the facade everything else imports. It reads
the `printenbind_api_version` app setting (`v1` or `v2`, default `v2`) per
call, owns the hourly tracking and box-instruction crons, and is what the
bulk-actions "Print&Bind API" toggle flips through
`/admin/printenbind/api-version`. Both integrations use the same
`PRINTENBIND_API_KEY`; v1 sends it raw, v2 as a bearer token. Orders carry
the order id of the API that placed them, so after a switch the tracking
poll cannot see orders placed on the other API.

- `PRINTENBIND_API_URL` / `PRINTENBIND_API_KEY`: development must point at
  `https://sandbox.printenbind.nl/api/rest` with the sandbox token; production
  uses `https://www.printenbind.nl/api/rest`. Production needs the REST
  token, not the older live token. The older one authenticates on REST and
  prices plain cards, but any article with `accessory_item: box_qrsong`
  gets a bare `500 Server Error`: until 2026-09-29 every gift-box cart fell
  back to the stored shipping rates. To see which token a machine resolves
  to, and what Print&Bind answers for a given cart, run
  `node _scripts/pb-quote-check.mjs [--box] [--country DE]` there; it prints
  a sha256 fingerprint of the key, never the key. The API reads `.env` at
  start, so a changed key needs a restart. Whether v1 accepts the REST
  token is untested; a switch back to v1 may need the older token.
- `POST /orders` places (checks out) the order immediately; there is no
  separate finish step. `processOrderRequest` therefore refuses to place
  orders on the live host unless `ENVIRONMENT=production` and runs
  `/orders/calculate` instead. `/orders/calculate` never creates anything.
- `/orders/calculate` does price delivery: `delivery_amount` (EUR ex VAT,
  already inside `amount`). It only fetches and checks a file when the
  article carries one; leave the file fields off and `copies` is priced as
  sent. That is how `quoteShippingCost` gets a shipping quote for a cart
  without any PDF. Checkout (`calculateOrder`) charges that quote and falls
  back to the stored `shipping_costs_new` rates plus their flat overrides
  when Print&Bind is unreachable; the admin "calculate shipping costs" bulk
  action refreshes that table from the same quotes.
- Calculate validates the postal code format only for NL, BE, DE, FR and GB
  (checked September 2026); every other country accepts any string. The
  email domain must exist.
- Products: `losbladig` (60x60 game cards, or A4 sheets) and `werkblad`
  (120x120 box insert cards). `accessory_item` is required for our account
  (`none` or the customer-specific `box_qrsong`). `borderless: true` and
  `check_doc: false` reproduce what Print&Bind applied to our v1 orders.
- Tracking comes back as barcodes only; `buildTrackingUrl` rebuilds the
  PostNL / international URLs because `shipping.ts` parses
  `code/country/postalcode` off the URL tail.
- Sandbox orders can be cancelled with `DELETE /orders/{id}`.
- The tracking poll treats `Afgeleverd` / `Afgehaald` as shipped too, but
  only mails orders placed in the last 30 days. v1 only knew `Verzonden`, so
  every order that skipped it stayed `Submitted` forever; the first v2 poll
  after the September 2026 deploy mailed tracking links for orders delivered
  a year earlier. Older ones are now closed without a mail or tracking.

## Parcel tracking: PostNL's public track & trace

Print&Bind ships on its own PostNL contract, so PostNL's Shippingstatus API
with our key (`postnl.ts`, labels for business shipments) cannot see these
parcels. `postnlTracking.ts` reads the JSON endpoint behind the tracking page
instead, which needs no account:
`https://jouw.postnl.nl/track-and-trace/api/trackAndTrace/{barcode}-{country}-{postcode}?language=en`.
It replaced TrackingMore ($74 a month, which did the same lookup) on
2026-10-12; the TrackingMore account is shared with 21pix, so it is only
cancelled once 21pix has moved too.

- `createShipment` (called when the printer poll stores a tracking link)
  takes barcode, country and postcode off the link's tail (both the
  `jouw.postnl.nl` and the `internationalparceltracking.com` form) and looks
  the parcel up once. The hourly cron (`updateAllShippingStatuses`) asks again
  for every Shipped payment shipped in the last 60 days, 500 ms apart, and
  marks delivered ones `Delivered`.
- The postcode must be right: a wrong one answers `{"colli":{}}`, which we
  read as "unknown parcel", not as an error. PostNL ignores spaces and dashes
  in it, and the dash also separates the key, so both are stripped.
- `shippingStatus` keeps TrackingMore's words (`inforeceived`, `transit`,
  `pickup`, `delivered`, `exception`) because the admin tracking page and the
  chat read them. `isDelivered` + `deliveryDate` decide delivery; the
  delivery is not one of the `observations` (newest first). Picked up is the
  first observation that is not `A01` (the pre-announcement). Never use
  `internationalStatus`: it says `ReceivedByPostNl` on a delivered domestic
  parcel.
- When a run of 10 or more lookups fails completely (PostNL down, the endpoint
  moved, a bot wall in front), it logs red every run and sends one Pushover a
  day. That is the moment to look at what jouw.postnl.nl itself calls now.
- `payments.shippingId` holds the old TrackingMore ids and is not read any
  more.

## Adding New Music Services

See [NEW_MUSIC_SERVICE.md](./NEW_MUSIC_SERVICE.md) for complete documentation on integrating new music streaming services (Spotify, Tidal, YouTube Music, etc.).

## High-Level Architecture

### Core Application Structure
This is a **Node.js/Fastify API** for a music playlist and QR code service called "QRHit" that allows users to create QR codes for Spotify playlists and physical music cards.

### Key Components

#### 1. Server Architecture (src/server.ts)
- **Fastify-based** web server with clustering support
- **Multi-worker** setup using Node.js cluster module
- **Singleton pattern** for main Server class
- **Plugin-based** architecture with custom plugins (IP tracking, CORS, static files)
- **Role-based authentication** system with JWT tokens
- **EJS templating** for dynamic content rendering

#### 2. Data Layer
- **Prisma ORM** with MySQL database (see prisma/schema.prisma)
- **Complex relational schema** with 20+ models including:
  - User management (Users, UserGroups, Authentication)
  - Music data (Tracks, Playlists, Spotify integration)
  - E-commerce (Payments, Orders, Shipping, Discounts)
  - Company/Business features (Companies, CompanyLists, Submissions)
  - Content management (Blogs, Reviews, Push notifications)

#### 3. External Service Integrations
- **Spotify API** - Primary music data source and playlist management
- **Mollie** - Payment processing
- **AWS Services** - SES for email, Lambda, EC2
- **Firebase** - Push notifications and additional services
- **Print APIs** - For physical card production
- **Anthropic and OpenAI** - AI-powered features, all through the LLM layer (`src/llm`)
- **Trustpilot** - Customer reviews

#### 4. Business Logic Modules
- **Music Processing** (`src/music.ts`, `src/spotify.ts`) - Spotify integration, track management
- **Order Management** (`src/order.ts`, `src/mollie.ts`) - Payment processing, order fulfillment
- **QR Code Generation** (`src/qr.ts`) - QR code creation for tracks
- **PDF Generation** (`src/pdf.ts`, `src/generator.ts`) - Document generation for physical orders
- **Email System** (`src/mail.ts`) - Transactional and marketing emails
- **Analytics** (`src/analytics.ts`) - Usage tracking and reporting

#### 5. User Features
- **Authentication System** - JWT-based with multiple user roles (admin, companyadmin, users)
- **Company Portal** - Business customers can create voting lists for their playlists
- **Review System** - Customer feedback and Trustpilot integration
- **Multi-language Support** - Full i18n with 12+ languages
- **Discount System** - Promotional codes and vouchers

### Key Workflows

#### 1. Playlist Processing
1. User submits Spotify playlist URL
2. System fetches tracks via Spotify API
3. Tracks are processed for metadata (year, genre, etc.)
4. QR codes generated for each track
5. PDF documents created for physical cards
6. Payment processed via Mollie
7. Order fulfillment (digital delivery or physical printing)

#### 2. Company Voting Lists
1. Companies create voting campaigns
2. Employees/users submit track preferences
3. System aggregates votes and creates final playlist
4. Automatic Spotify playlist creation
5. PDF generation for physical cards

#### 3. Track Metadata Enhancement
- **Multi-source year detection** - Spotify, MusicBrainz, Discogs, and Claude
  (task `yearLookup`), which reads a Google search (Serper) and Wikipedia when
  the three disagree (see "Release-year lookup" under the LLM layer)
- **YouTube link association** - Automatic YouTube link finding
- **Manual verification system** - Admin interface for data quality

### Important Technical Details

#### Authentication & Authorization
- **JWT tokens** with role-based access control
- **User groups**: admin, companyadmin, users
- **Company-scoped permissions** for business features
- **Token middleware** on protected routes

#### File Structure
- `src/` - Main application code
- `src/interfaces/` - TypeScript interfaces
- `src/config/` - Configuration constants
- `src/plugins/` - Custom Fastify plugins
- `src/routes/` - Route definitions (organized by feature)
  - `accountRoutes.ts` - User authentication and account management
  - `adminRoutes.ts` - Admin panel and management routes
  - `companyRoutes.ts` - Companies, company lists, voting, quotations and calculators (`/business/*`; logic in `src/business.ts`)
  - `musicRoutes.ts` - Spotify integration and music-related routes
  - `paymentRoutes.ts` - Payment processing and order management
  - `publicRoutes.ts` - Public endpoints and general functionality
  - `blogRoutes.ts` - Blog/content management routes
- `src/templates/` - Email templates
- `src/views/` - EJS templates
- `public/` - Static assets (QR codes, PDFs, images)
- `private/` - Protected files (invoices, audio)

#### Development Patterns
- **Singleton pattern** for core services (Server, Data, Cache, etc.)
- **Service layer architecture** - Each major feature has its own service class
- **Interface-driven development** - TypeScript interfaces for data models
- **Error handling** - Comprehensive error handling with status codes
- **Logging** - Custom logger with color-coded output

#### Environment Configuration
- Uses `.env` files for configuration
- **Multi-environment support** (development, production)
- **Feature flags** for development vs production behavior
- **AWS configuration** for cloud services

## LLM layer: one source for every model call

Every language, image and speech model call goes through `src/llm` (built
2026-10-08). Nothing else in `src/` imports an AI SDK; a test fails if
something does (`test/unit/llm/single-source.test.ts`). The root `translate.js`
is a standalone dev script and stays outside it.

| what | where |
|---|---|
| **which provider, model and effort each task uses** (the switchboard), with a fallback route per task | `src/llm/tasks.ts` |
| every model with its prices (the only place a price lives) and what it accepts | `src/llm/models.ts` |
| `llm.json` / `tryJson` / `text` / `stream` / `image` / `speech`, the fallback, the log line | `src/llm/index.ts` |
| one adapter per provider; a new provider is one file plus a line in `providers/index.ts` | `src/llm/providers/` |
| OpenAI-to-Anthropic schema conversion | `src/llm/schema.ts` |
| the cost ledger, one row per model run | `src/llm/ledger.ts` → table `llm_calls` |
| the prompts and answer handling of most tasks | `src/aiTasks.ts` (was `chatgpt.ts`) |

- **A task is a kind of call**, with a readable label and description for the
  admin AI costs page. To move a task, change its route in `tasks.ts`, update
  the snapshot in `test/unit/llm/tasks.test.ts` on purpose, and deploy.
- **Every text task falls back once to its OpenAI route** (the one it used
  before the layer) when the primary fails: provider down, the Anthropic credit
  used up, no `ANTHROPIC_API_KEY` in the process (the layer warns once), a
  refusal, an unusable answer. A request we built wrong (`LlmRequestError`)
  never falls back. A stream falls back only before its first token.
- **`json()` throws `LlmOutputError`** for an unusable answer (refused, cut
  off, empty, not JSON) and rethrows provider errors; `tryJson()` returns null
  for the first. The error carries the attempts and their cost.
- **Costs** are priced at call time from `models.ts` and stored per attempt in
  `llm_calls` (role `primary` or `fallback`, status `ok` / `error` / `refusal`
  / `truncated` / `unparseable` / `empty` / `unavailable`). A price change
  never rewrites history. The ledger is off under test unless `LLM_LEDGER=on`.
  The admin page is `/:lang/dashboard/ai-costs` (Financial), fed by
  `GET /admin/ai-costs` (`routes/aiCostRoutes.ts`).
- **Live check**: `npx tsx scripts/llm-smoke.ts [task...]` runs every text task
  once on its primary route (about $0.05) and lists the ledger rows;
  `--compare [--routes=provider/model:effort,...]` compares release years;
  `--live` runs the release-year cases as production does, with a real Serper
  search and real Wikipedia pages (about $0.01 plus 16 Serper searches);
  `--web` runs them with one Anthropic web search instead (about $0.19).
- **Web search** (2026-10-12): a request with `webSearch: { maxUses }` gets
  Anthropic's basic `web_search_20250305` tool. Each search is $0.01
  (`webSearchPer1k` in `models.ts`, priced into `costUsd`) and the pages read
  count as input tokens; `usage.server_tool_use.web_search_requests` becomes
  `webSearchRequests` and the ledger's `webSearches` column, shown on the AI
  costs page. The answer is the text after the last search, the pages come
  back as `result.sources`, and a `pause_turn` is resumed up to three times.
  An OpenAI fallback answers without searching. Nothing in production uses
  it any more: `yearLookup` did from 2026-10-12 to 2026-10-24, see the next
  point. `llm-smoke.ts --web` still does, as the comparison.
- **Release-year lookup** (`music.ts` → `src/yearEvidence.ts`, 2026-10-24).
  When MusicBrainz, Discogs and Spotify disagree (about two thirds of new
  tracks), the lookup searches Google through Serper (`SERPER_API_KEY`, one
  10-result search, about $0.001), reads the Wikipedia pages Google found (one
  per language, at most two; Wikipedia's own English search when Google found
  none) with their Wikidata publication (P577) and inception (P571) dates, and
  pastes all of it into the Haiku prompt. Wikipedia and Wikidata are free but
  **refuse a generic User-Agent with a 403**: every call sends the `QRHit/1.0
  (…)` agent, as MusicBrainz and Discogs get. That 403 is probably why the
  free `wikipedia` package was swapped for RapidAPI's wikipedia-api2 in
  November 2025. Without a Serper key, or when Serper fails, it reads
  Wikipedia only. Google's results plus any Wikipedia page Google did not list
  go to `tracks.googleResults` for the admin year-check page.
  - Why: the Anthropic web search the lookup used from 2026-10-12 cost $0.0117
    a track ($0.01 of it the search fee). The production ledger for 13-24
    October showed ~12,300 lookups a month at ~$97, $82 of it search fees. On
    the 16 `--live` cases (2026-10-24) Serper + Wikipedia scored 15/16 at
    $0.00041 a track plus one Serper search, Wikipedia alone 15/16 at
    $0.00033, and the web search 14/16 at $0.0117. Every miss is a debatable
    truth year in the cases: "Het is een nacht" came out as a single in July
    1995 by Wikipedia and the Top 40, the case says 1994.
  - Serper costs are not in the `llm_calls` ledger or on the AI costs page;
    Serper's own dashboard shows the usage. Paid credits expire after six
    months.
  - Before 2026-10-12 the same design ran on RapidAPI (real-time-web-search
    and wikipedia-api2, every track).

**Anthropic rules the adapter follows** (all a 400 otherwise; Claude 5.5 models):

- No `temperature` / `top_p` / `top_k`, and no assistant prefill: the last
  message is a user turn, and a conversation that opens with an assistant turn
  gets a short user turn in front.
- Thinking per model: Opus 5.5 always thinks (effort is the only control),
  Sonnet 5.5 turns it off with `between_tools`, Haiku 5.5 with `disabled`
  (both only at effort high or below). The layer's `'none'` effort maps to
  exactly that. `max_tokens` is required and counts the thinking.
- Structured output is `output_config.format`; every object needs
  `additionalProperties: false`, and `minLength` / `maxLength` / `minimum` /
  `maximum` are not supported (`schema.ts` handles both, and rewrites
  `type: ['integer', 'null']` to `anyOf`).
- Opus and Sonnet ask for the server-side refusal fallback (`fallbacks:
  'default'`, beta `server-side-fallback-2026-07-01`); its runs are priced at
  their own model and recorded as fallback rows. Haiku has none.
- Haiku 5.5 bills a prompt over 100K tokens at 5x; the layer warns when one
  does. The largest prompt here is the catalogue matcher at about 45K.
- Prompt caching (`system` blocks with `cache: '5m' | '1h'`) is available but
  unused: no system prompt is both large and repeated within five minutes.

**OpenAI routes keep the GPT-5.6 rules** (verified 2026-09-16), which the
OpenAI adapter applies: `temperature` other than 1 only with
`reasoning_effort: 'none'`; function tools are a 400 with reasoning on, so
structured output is `response_format: { type: 'json_schema' }`;
`max_completion_tokens`, not `max_tokens`.

The customer-facing playlist generator runs with thinking off (`aiKeywords`,
`aiCurate`): a customer watches a progress bar and the curation batches are
sequential. On OpenAI (2026-09-17) terra + `'low'` took 26 s for keywords and
6.5 s per batch against 10 s and 1.5 s for luna + `'none'`; on Anthropic
(2026-10-08) Sonnet 5.5 took 2.9 s for keywords and Haiku 5.5 1.6 s per batch.

## AI playlist generator: artists and catalogue suggestions

`aiPlaylist.ts` turns a customer's description into a playlist in three
steps: an LLM names keywords (mostly artists), every keyword is a
`LIKE` search on `tracks` (50 random rows each), and an LLM picks from the
candidates in batches of 100. Two things sit on top of that since 2026-09-30.

**Who gets how many songs** (`aiPlaylistBalance.ts`). Nothing used to count
per artist, so whoever had the most songs in the catalogue dominated:
"klassik" delivered 13 Beethoven pieces out of 75, and a customer who wrote
"at most two songs per band" got 19 of one. A theme of only named artists
("Nur Harry Styles, Olivia Rodrigo, Taylor Swift ... Sonst nichts!") came back
padded with similar artists, and "Bruce Springsteen studio albums" stopped at
52 songs, because a keyword fetched 50 rows and an expansion round filled the
shortfall with other names.

- The keyword call also returns what the customer said about artists:
  `requestedArtists` (names they typed), `onlyRequestedArtists`,
  `maxPerArtist` and `requestedArtistsMayExceedLimit`.
- **A limit the customer states is hard.** It is never exceeded; the playlist
  comes out shorter and the summary page says so (`submit.aiUnderfillMessage`).
- **Named artists are what was asked for.** They are searched deeper (twice
  the playlist, at most 500 rows, their own songs ahead of names that merely
  contain theirs) and are not held to the fair share. Only named artists: no
  expansion round at all, and the playlist is divided evenly among them. Named
  next to a wider theme ("80s rock like Queen"): each may fill a quarter,
  together half.
- **Everyone else gets a fair share, from 90 candidates up**: the smallest cap
  that still leaves 1.5 times the playlist to choose from, never below 2. It
  is soft.
- **Release years get the same fair share** (`YearSpread`, per year, soft).
  The cards are played by guessing the year, and left alone the picks bunch
  up where the catalogue is thickest. It follows the years the theme has: a
  decade is spread over its ten years, a theme without a period over every
  year it has songs for (75 tracks came out as 39 different years, two per
  year at most), a single-year theme is left alone. A song without a known
  year is never held back. The LLM sees each candidate's year.
- A song whose artist or year is full is left out of later batches (the LLM
  cannot spend a pick on a song that would be dropped), so batches are cut as
  the run goes and each is asked for its share of what is still missing.
- **When the playlist comes up short**, in this order: up to three top-up
  batches inside the shares; then the shares are lifted and the songs the LLM
  chose for a full artist or year go in, least crowded first; then a top-up
  over the rest of the pool. The held-back songs are from exactly the artists
  and years that are full, so taking them first (the first version did)
  undid the spread for places the rest of the pool could have filled. A song
  is offered in a top-up once.
- The count is per first-listed artist ("A, B & C" counts for A), except that
  a song naming a requested artist anywhere counts for that artist.

**Existing playlists that match.** While a playlist is being put together,
the progress page shows existing ones the customer could take instead: up to
three of our featured playlists and up to three found on Spotify.

- **Nothing is looked up before the customer presses the button** (Rick,
  2026-09-30; a first version searched while they typed). Both lookups are
  asked by job id: `GET /ai-playlist/suggestions/:jobId` and
  `GET /ai-playlist/spotify-suggestions/:jobId`. `/generate` writes what the
  job was asked to Redis (`aiPlaylistJob:<id>`, 30 minutes) before it
  replies, so the page can ask at once. A job only exists behind the captcha
  and the daily limit, so there is no endpoint that makes an LLM or Spotify
  call for whoever sends it text. Do not add one.
- Both always answer with a list. A model that is down, a rate limit or an
  unknown job shows nothing, never an error.
- **A suggestion has at least as many tracks as the customer asked for**
  (the job's `trackCount`): a 42-song playlist is no answer to a request for
  100. Featured playlists are filtered on size after the model has matched,
  so its answer is cached once for every size. Spotify playlists are filtered
  before the model picks (it is told the size and prefers the nearest), so
  that cache is per size; the Spotify search itself is not repeated.
- A customer who takes a Spotify playlist goes into the order flow with it,
  the route a pasted link takes. The generated playlist is still finished
  and sits on our account until the three-day cleanup.

**Featured playlists** (`aiPlaylistSuggestions.ts`), in the shape of
`/featured/:locale`. Customers often describe something the catalogue
already has (Disney, Schlager, Eurovision, all Taylor Swift songs).

- One LLM call over the whole catalogue (task `aiSuggestFeatured`): about 600
  lines and 37k tokens (1.5 s on luna with reasoning off, 2026-09-30). Words
  cannot do it: requests come in any language and half the playlist names say
  nothing about the content. The catalogue is the first part of the prompt and
  the same all day (Redis, ordered by score then id), so OpenAI's prompt cache
  covers it on an OpenAI route; on Haiku it stays under the 100K-token line
  where the price goes up 5x.
- The catalogue line uses `description_en`, the page copy, not the customer's
  blurb that `/featured` serves for promotional lists: it names genre, years
  and artists. Descriptions are cut **by character**; half an emoji is a lone
  surrogate and OpenAI answers the whole request with a 400.
- Featured names say "Cartoon" where they mean Disney (`replaceBrandTerms`,
  and several were renamed in the database), so the prompt says so.
- **Market rule, in code.** The model also reports the language of the prompt
  and whether it asks for one country's music. A playlist with a
  `featuredLocale` is only offered when that locale is the visitor's, the
  prompt's or the one asked for. Left to the model, an English "80s hits" got
  three German lists.
- The model is asked for eight and three are shown, so the market rule and
  the size rule have something to drop. Made-up ids are ignored.
- Answers are cached for six hours per locale and prompt.

**Playlists found on Spotify** (`aiPlaylistSpotifySuggestions.ts`). Spotify
cannot be shown to the model, only asked, so this works the other way round:
the model writes a search query (the title a playlist with this music would
have), Spotify is searched, and the model picks from what came back. Most of
what a search returns is somebody's private mix with a lookalike name; the
picking is what makes it usable. About 3 to 5 seconds in all.

- **It must never cost the order flow its Spotify access.** A 429 on the
  official API parks it for five minutes and more (`RateLimitManager`) and
  sends playlist loading to the scraper. So `Spotify.searchPlaylists` sends
  one request per query, never retries, has no fallback provider, sends
  nothing while the official API is rate limited, pauses all playlist
  searches for Retry-After plus ten minutes after a 429 of its own, and lets
  at most 6 a minute and 400 a day out across all workers (Redis counters).
  A second query is only tried when the first found fewer than four usable
  playlists.
- **Two caches.** What a query found is kept for a day
  (`playlistsearch_<query>_<limit>`), and so are the playlists picked for a
  description (`aiPlaylistSpotifySuggest_v1_<hash>`). A description that
  comes back, or another one that leads to the same query, costs Spotify
  nothing. When Spotify could not be asked, "nothing" is remembered for five
  minutes only.
- Only playlists a customer could order as they are: from what they asked
  for up to 500 tracks (or twice what they asked, when that is more), with a
  cover. Spotify's own editorial playlists come back
  as `null` and cannot be loaded by id either. Playlists of our own account
  are left out (the search happily returns earlier `qrsong! AI —` playlists).
- The official API only (`spotify_api.ts`, `type=playlist`). The track count
  is `tracks.total`, or `items.total` in the 2026 format; both are read.

## Testing
- Vitest suites in `test/`, see TESTING.md
- Run tests with `npm test` (`npm run test:unit` for the unit suites only)

## Deployment
- **PM2** process manager for production
- **Git-based deployment** via `npm run start_pm2`
- **Database migrations** handled by Prisma
- **Multi-worker clustering** for scalability
- **Static file serving** for public assets

## Startup and deploys

Three things keep the API's downtime per deploy down to its own boot. None of
them is obvious from the code alone.

**The build runs before the restart, not during it.** pm2 runs
`npm run start`, and `pm2 restart` stops the old process first. `start` used to
build unconditionally, so every deploy and every crash restart was offline for
a full `prisma generate` + `tsc`. Now `deploy` / `deploy_api` run
`npm run build` while the old process still serves and only then restart; a
failed build aborts and leaves the old process running.
`_scripts/build.sh` compiles into `./.build-temp` and swaps it in with two
renames, so building under a running API is safe, and writes the commit it
built to `build/.build-commit`. `_scripts/start.sh` skips the build when that
stamp equals `HEAD` and `src`, `routes` and `prisma` have no uncommitted
changes (`_scripts/build-stamp.sh check`); in every other case, including "not
sure", it builds first as before. So a manual `git pull` + `pm2 restart` still
works, it is just slow. **Never put `pm2 restart qrsong` above the pull or the
build in a deploy script**: `start` would find the old build current and
relaunch the old code.

**The primary forks before it loads the application.** Loading the module
graph takes a second or more per process. `src/app.ts` is a deliberately tiny
entry point: it calls `startClusterWorkers()` (`src/clusterPrimary.ts`) and
only then does a dynamic `import('./bootstrap')`, which holds what `app.ts`
used to (`Server.init()`). Workers therefore load in parallel with the
primary instead of after it. Keep static imports out of `app.ts` and keep
`clusterPrimary.ts` light, or the fork is delayed again. The one-time legacy
background backfill stays ahead of the fork on purpose, see the next section.

**`Utils.isMainServer()` is memoised per process.** Some twenty singletons ask
at boot and each call was two IMDS round trips plus an EC2 `DescribeInstances`.
A failed lookup is not cached. Tests reset it with
`Utils.resetMainServerLookup()`.

## Default card artwork and the 2026 cutover

Order lines never store a background when the customer keeps the default; the
card templates in `src/views/pdf_*.ejs` fall back to
`assets/images/background_brand.png` (the cream brand artwork, same image the
frontend shows). `assets/images/background_new.png` still holds the old blue
artwork under its historical name.

Orders from before the switch must keep the blue artwork on every
regeneration or reprint, so `src/legacyBackground.ts` pins them explicitly:
at startup the blue artwork is copied to `public/background/legacy_default_blue.png`
(uploads are not in git), and the primary process runs a one-time UPDATE that
sets that filename on every line with no background and no solid colour. The
run is recorded in `app_settings` under `legacy_default_background_backfill`,
so it never repeats; delete that row to run it again. Nothing to do at deploy
beyond restarting the API.

When changing the default artwork again, give the new file a new name (a
warm Lambda keeps Chromium's image cache between renders) and repeat this
cutover rather than overwriting the file.

## Hitster detector: the designer's screen and finalCheck

A small model of our own (`src/hitsterDetector.ts`,
`assets/hitster/hitster.onnx`, 12 MB) judges whether a picture shows Hitster
material: about 70 ms per picture on one core, on `onnxruntime-node`, no paid
API. Built 2026-10-06; how it is trained, and the tool for labelling and
retraining, is `ml/hitster/README.md`. It is used twice:

- **While designing**: `POST /designer/screen` (`src/designScreen.ts`) tells
  the card and box designers whether a picture the customer just picked is
  Hitster, and they show a message. Ordering anyway is allowed.
- **Before printing**: `finalCheck.ts` runs the model on every picture that
  prints on a physical order (each design's front and back background, logo
  and QR logo; the box front, logo and back) plus a text search of the PDFs
  for the word (typed box text). A hit puts the order on hold and mails the
  customer the pictures with the reason (`handleFinalCheckFailure` in
  `generator.ts`, `sendDesignAlterMail`). This replaced, at Rick's request
  (2026-10-06), the GPT checks finalCheck used to do (design drift between
  the stored and a live-rendered PDF, Hitster on rendered pages, text
  readability): no language model is asked anything any more. The model
  runs on the uploads, not on rendered pages: it was trained on uploads, and
  every rendered card carries a QR code and track text it never saw.
- **Design drift, without GPT** (2026-10-07): finalCheck renders the first
  card of every design again from the live design route and compares it
  with the stored PDF in `src/designDrift.ts`: both small (64 px) and
  blurred, a page drifted only when more than `DRIFT_SHARE` (0.3) of it
  differs clearly and its colour mix moved more than `DRIFT_COLOURS` (0.25).
  That ignores compression, hinting, a card number and a QR code with
  another payload (about a quarter of a front, same colours), and catches a
  wrong or missing background, other artwork or a blank render. A drift
  holds the order as `design-mismatch` without a mail; a failing live render
  (Lambda) skips the comparison. Every comparison logs its two numbers, so
  the thresholds can be tuned from the logs. Readability is no longer
  checked after payment: the card designer gives a contrast tip instead.
- **The QR code on the print** (2026-10-07): finalCheck reads the code on
  the front of every design's first card from the stored PDF, rendered at
  3x and, when nothing reads there, once more at 2x (`src/qrRead.ts`,
  ZXing-C++ through `zxing-wasm`, light on dark tried too: the app scans
  inverted codes). A single-design sheet is read whole: twelve codes on
  one page. A code must lead to this order line (`/qr2/<track>/<php>`). If
  none does, the order is held as `qr-unreadable` without a mail (Rick:
  unusable cards never print). The designer warns first, with a scan in
  the browser (zxing's JS port, only for a code that is not black on
  white).
  - **Not jsQR.** The first version used it and held order 100009135 for
    a clean black on white code: jsQR misses some codes at some render
    sizes (that one read at 1x, 2x, 4x and 6x, not at 3x). On 13 recent
    printed orders it failed 4 at 3x, and both sheets at every size (it
    does not find one code among twelve). ZXing-C++ read all 14 at every
    size, in a few ms. zxing's JS port is no better: it failed an orange
    code at most sizes. `qr-logo.ts` still uses jsQR to check that a logo
    leaves the code readable; a miss there only makes the logo smaller.
  - The wasm binary is read from `node_modules`
    (`require.resolve('zxing-wasm/reader/zxing_reader.wasm')`): by default
    the package downloads it from jsDelivr. A decoder that fails to load
    throws, which holds the order like any other check that throws; it is
    never reported as an unreadable code.

- **What counts as Hitster** (Rick, 2026-10-06): the word in any lettering,
  near-spellings included ("HITSER", "Hitstor", "HITSTAR"), and the look on
  its own: the coloured rings of the back of their cards, the chrome speaker
  and the "THE MUSIC CARD GAME" pill of the box. Not Hitster: JITSTER, a name
  or word with "-ster" (Brittster, Swiftster, Sipster), HITSPEL.
- The model scores four classes per 16 x 16 cell; a picture is flagged when
  any class reaches the threshold (`src/hitsterThresholds.ts`). **Two
  thresholds** (Rick, 2026-10-07): the designer warns from
  `HITSTER_THRESHOLD` (0.5), finalCheck holds an order from
  `HITSTER_HOLD_THRESHOLD` (0.7). On v3's test set 0.7 catches 91% and holds
  about 1% of clean orders for nothing, against 95% and 1.7% at 0.5.
- **finalCheck fails closed.** Which pictures it checks is decided as the
  print templates decide what prints (a card background unless its type is
  `solid`, a box background when it is `image`, the filename rule
  `IMAGE_FILENAME` of `cardDesigns.ts`), so nothing prints unchecked. A
  printed picture that cannot be checked (not on disk, unreadable, too large)
  holds the order as `picture-unchecked`, without a mail to the customer.
- Pictures over 50 megapixels are refused from their header, before they are
  decoded (the screen is public, and a 1 MB PNG can unpack to hundreds of
  megapixels); everything else is shrunk to 1280 px first, as every
  training picture was.
- **The input must be prepared exactly as in training** (`prepareHitsterInput`
  mirrors `ml/hitster/preprocess.py`; `ml/hitster/node/parity.ts` proves they
  agree). In particular transparency goes onto a grey that contrasts with the
  artwork, never onto white: a white "HITSTER" on transparent flattened onto
  white is an empty picture. The designers' small copy uses the same rule.
- Verdicts are cached in Redis per picture content and model file (size +
  mtime), so a new model never answers from old verdicts.
- `DESIGN_SCREEN_MODE` (off / warn, default warn; block is reserved) travels
  with every answer. Anything that goes wrong answers "unchecked", which the
  designers treat as no opinion. 400 screens per address per day.
- **`.npmrc` has `onnxruntime-node-install=skip`.** Without it the package's
  postinstall downloads the CUDA 12 libraries (hundreds of MB) on every
  `npm install` on a Linux x64 box; we run on CPU.
- A new model: copy `ml/hitster/runs/<name>/hitster.onnx` over
  `assets/hitster/hitster.onnx`, run `test/unit/hitster-detector.test.ts`
  (it runs the shipped model on the Hitster box photo), deploy.

## Scan-app themes and the App Designer

The scan app (`qrhit-app`) themes itself from `GET /theme/:slug`: a ThemeConfig
with ~45 `--app-*` CSS variables, flags, a font block, help text and asset
URLs. `GET /qrlink2/:trackId/:php` tells it which slug a scanned card uses
(`t: {s, n}`), from the in-memory `php id → slug` map in `src/apptheme.ts`.
**All of this works with the released app; nothing here needs an app update.**

Three sources, tried in this order by `src/routes/themeRoutes.ts`, which
adds `source: 'business' | 'customer'` to the response:

1. Hand-made B2B themes **stored as data** (since 2026-10-22,
   `src/storedThemes.ts`, table `app_theme_versions`): pushed by Rick's
   qrsong toolkit (`qrsong theme check|push|pull|list|history`, source
   folders in the toolkit's `reference/app-themes/<slug>/`), so a new or
   changed business theme needs no deploy. Details below.
2. Hand-made B2B themes in folders: `src/_data/themes/<slug>/`, in git
   (`<slug>/<slug>.json` + optional `logo.png` / `background.png`). The seven
   from before (acme, ahaieee, cannock, default, derby, gebo, vanharen) are
   served from here exactly as before until one is pushed; don't add new
   ones here.
3. Customer designs (App Designer): `PUBLIC_DIR/customer-themes/<slug>/`, in
   the same layout as the folders, written by `src/appDesign.ts` on every
   save (atomically: temp file, then rename). The DB row in `app_designs`
   keeps what the file cannot: owner, scope, the editor state and the
   version.

Both kinds of business theme are assigned per order line by an admin
(`payment_has_playlist.theme`, POST `/php/:id`, `qrsong theme set`).

**Business themes stored as data** (`src/storedThemes.ts`, admin routes in
`src/routes/appThemeRoutes.ts`):

- `POST /admin/app-themes/:slug` (multipart: `manifest` = the folder's JSON,
  optional `note`, files `logo` and `background`, PNG only, 15 MB / 25 MP;
  `?check=1` checks and stores nothing) stores version N+1. Versions never
  change; the pictures are content-addressed under
  `PUBLIC_DIR/app-themes/<slug>/<sha>.png`. `GET /admin/app-themes`,
  `/:slug` (versions, order lines), `/:slug/:version` (`latest` works) and
  `/:slug/:version/logo|background` give it back for `qrsong theme pull`.
- The JSON is checked with the App Designer's grammar (`validateCssVariables`:
  only variables the app reads, no `url()`), a Google Fonts css2 URL only, and
  `sanitizeHelpText(…, { layoutStyles: true })`, which also keeps
  `text-align` and `margin-top/bottom` in px on p/h2/h3, as the folder help
  texts use. Every problem is named in one 400. The grammar accepts a unitless
  `0` in shadows and `drop-shadow()` in `--app-logo-filter` (2026-10-22): every
  folder theme passes as it is (`test/unit/stored-themes.test.ts`).
- **Slugs**: words of a-z 0-9 joined by single hyphens, at most 56; not
  `default` (the app never asks for it), not the customer shape. A scanned
  card of a stored theme gets `<slug>--v<version>` (`servedStoredSlug` in
  `apptheme.ts`), for the same reason customer themes carry their version: the
  app only reloads a theme when the slug changes, so a push reaches every card
  at its next scan. `GET /theme/<slug>--v<n>` answers any `n` with the newest
  version under the slug asked for; the bare slug works too (an app restoring
  its last theme, `qrsong theme show`). A push reloads the scan map in every
  worker (`AppTheme.reload`). A line on a folder theme keeps its plain slug.
- **Pushing a folder theme** makes the stored one win from then on; its first
  stored version is numbered above the folder JSON's `version`, so apps that
  cached the folder's theme take the new one.
- **Without the table everything works as before**: `forServe` and the scan
  map's `storedThemeVersions` treat a database error as "nothing stored", so a
  deploy that has not created `app_theme_versions` yet serves the folders and
  plain slugs. The table is the only schema change of this feature (`prisma db
  push`, or just its `CREATE TABLE` where the database has drift: the dev
  database did on 2026-10-22, where a push wanted to drop `broken_links`,
  `printer_invoices` and `payments.printApiInvoicePrice`).

**App Designer is an upgrade on the account.** `APP_DESIGN_PRICE` in
`src/config/constants.ts` is the only place the amount is written. A paid
`app_design_upgrade` webhook writes one `app_design_purchases` row, which is
both the entitlement and the ledger entry the financial reports read (gross,
ex-VAT and VAT stored, plus what Mollie charged in the customer's currency).
The dashboard's "App Design" switch on an order line (next to the QRGames
one, `POST /admin/playlist/:phpId/app-design-enabled`) sets
`users.appDesignEnabled`: null follows the purchases, true or false wins over
them for the whole account (`AppDesign.isEntitled`, and the same rule in SQL
in `loadAppThemes`). It never touches the ledger, and the next purchase puts
the account back on its purchases (`processUpgradePayment` clears it).
The account has one default design (`app_designs.paymentHasPlaylistId` null,
`scopeKey u<userId>`) and optional overrides per order line (`scopeKey
p<phpId>`, `mode` custom / standard / default).

Which theme a line gets (`resolveLineTheme` in `apptheme.ts`), first match:
an admin-assigned `php.theme`; the line's own override when the account owns
the upgrade (`standard` = none); the account default when it owns the
upgrade; otherwise none. So a design saved before paying is stored and even
published as a file, but no scan gets it until the purchase exists.

**Why the served slug carries the version.** The app only reloads a theme
when the scanned slug differs from the active theme's id, and only then
compares versions. A customer who edits the design under a fixed slug would
see nothing until an app restart. So a customer theme has a random base slug
(`c` + 10 characters; random because `/theme/:slug` is public and customer
photos must not be enumerable) and is served as `<base>-<version>`; every save
bumps the version, so the next scan is a new slug. `GET /theme/<base>-<n>`
answers any `n` with the current file and `id` set to the requested slug,
because the app caches a theme under its id. `/theme/debug/all` (the app's
dev-mode picker) leaves customer slugs out outside development.

**The API never derives a theme.** The frontend turns the guided editor
controls into the variable map (`app-design.utils.ts` in qrhit) because the
live preview needs that math anyway; `src/appDesign.ts` validates what the
client sends (key whitelist, value grammar that rejects `url(`) and builds the
font URL itself from `src/fonts.ts`. The one `url()` it accepts is
`--app-background` naming the photo bundled in the app, in exactly the form
the app's built-in theme uses (`APP_BUNDLED_BACKGROUND_URL`): the app paints
its own copy, so the default "QRSong! photo" design needs no asset file.
`helpText` is HTML from the site's help-text editor (Markdown, converted to
the same HTML the former Quill editor sent); `sanitizeHelpText` keeps
only the tags the app's help screen styles, forces links to open outside the
webview, and still escapes plain text into `<p>` blocks (the app renders it
with `[innerHTML]`).

Routes (`src/routes/appDesignRoutes.ts`, all logged in): `GET /api/app-design`
(entitlement, price, default, every paid card playlist and its mode),
`GET|PUT /api/app-design/playlist/:phpId`, `PUT /api/app-design/default`,
`PUT /api/app-design/playlist/:phpId/mode`, `POST /api/app-design/upload/:type`
(editor uploads, `PUBLIC_DIR/app-theme/`), `POST /api/app-design/upgrade-payment`
(Mollie, in the customer's currency; VAT from the country of their last paid
order) and `POST /api/app-design/ai-theme` (OpenAI vision via json_schema,
sharp dominant-colour fallback, per-IP daily counter in Redis). The paid
webhook mails `app_design_enabled_*` (how it works, where to design) and
issues an upgrade invoice, see the next section.

**Bought at checkout** (2026-09-22): `cart.appDesign` adds `APP_DESIGN_PRICE`
once per order (`addAppDesignFee` in `src/order.ts`, an add-on in the
discount base like box and games); `payments.appDesignFee` holds it, inside
`totalPrice`, the VAT columns and `profit`, and the order invoice gets an
`appDesign` line. The designs the site made from the cards wait in
`payments.appDesignRequest` (`validateCheckoutDesigns` checks them against the
cart: one per card playlist, only that card's own uploads, the usual theme
grammar) until `activateCheckoutPurchase` runs from the paid webhook, or right
after payment creation for a free order: the card uploads are copied into the
App Designer folder, the first design becomes the account default when there
is none (lines whose cards look the same follow it), every other one becomes
that line's own design, a plain design never overrides an existing default,
and `processUpgradePayment` writes the `app_design_purchases` row with
`paymentId` set. **The reports count every purchase but add money only for
rows without a `paymentId`** (day/month, country, tax and OSS, charts,
dashboard counters, `scripts/kpi.ts`); the tax report carries the checkout
rows' ex-VAT as `appDesignCheckoutExVat` so the MoneyBird invoice can move it
from the sales line to the App Designer line. `Order.calculateOrder` looks the
checkout e-mail up (`email` in the body, only with App Designer ticked) and
answers `appDesignOwned`, so an owner is shown it as free and never charged
again; payment creation does the same lookup itself. `GET
/app-design/card-palette/:filename` (public) gives the dominant and accent
colour of a card background for the design the site derives. `chat.json`
carries `{{appDesignPrice}}`, filled from the constant like the card limits.

## Gifting a set: gift vouchers and per-set ownership

A buyer gives one or more sets (order lines) of a paid order to someone else:
in My account they make a printable gift voucher, the recipient redeems it at
`qrsong.io/redeem/<code>` and the sets move into the recipient's account,
with their card design, PDF, QRGames, quizzes and app design. The order, the
invoice and the money stay the buyer's. Built 2026-10-24 (branch
`gift-vouchers` in both repos) because QRGames and App Designer only work in
the owner's account, which made a set bought for a friend useless to them.

| what | where |
|---|---|
| who holds a line, every ownership check | `src/lineOwner.ts` |
| vouchers, eligibility, redeem, admin return | `src/gift.ts` |
| routes (`/api/gift/*`, signed view, admin) | `src/routes/giftRoutes.ts` |
| the A5 voucher | `src/views/gift_voucher.ejs`, rendered by the PDF Lambda from the signed `/gift/voucher/view/:id`, kept under `PRIVATE_DIR/gift-vouchers/` |
| mails | `gift_received` (recipient), `gift_redeemed` (giver), `Mail.sendGiftReceivedMail` / `sendGiftRedeemedMail` |
| texts | `giftVoucher.*`, `gift_received.*`, `gift_redeemed.*`, `mail.giftHint` in `src/locales` |

**Ownership moved from the order to the line.** `payment_has_playlist.ownerUserId`
is null while the buyer (`payments.userId`) holds the set and is set once, by
a redeemed voucher (relation `onDelete: Restrict`: Cascade would delete a set
out of the giver's books, SetNull would hand it back). Every "may this user
touch this set" check goes through `lineOwner.ts`: `ownsLine`,
`ownedLinesWhere` (Prisma), `lineOwnerSql()` (`COALESCE(php.ownerUserId,
pm.userId)` for raw joins), `findLineByHash` (a mailed link: Mollie id,
playlist and the holder's hash) and `findOwnedLine`. Downloads, corrections,
the card designer, QRGames and quizzes, customer-purchases, order again and
the app designs all use it, so a giver's old links stop working at the
redeem and the recipient's work.

- `test/unit/line-owner-single-source.test.ts` greps for `p.userId = u.id`
  and friends: a new check that reads `payments.userId` directly fails it
  unless it is in the allowlist with a reason (order-wide things that stay
  the buyer's: invoice, order mails, ledger). A stale entry fails too.
- **What stays the order's**: the invoice, order confirmation, printing and
  tracking mails, box instructions, the finalized mail and the review request
  (scans of a given set do not count towards it, `review.ts`). Order-wide
  actions are the buyer's only (`Suggestion.verifyBuyer`: the print deadline,
  regenerate and mail). A given digital set is rebuilt on its own
  (`queueDigitalRedesign`), never through `queueGenerate`, which rebuilds and
  finalizes the whole order.
- **Refused on a given set**: box and extra-card upgrades (booked and
  invoiced on the giver's order, a box would ship to the giver) and giving it
  on again (no re-gifting: the voucher is the whole history).
- QRGames upgrades are billed to the purchaser (`purchaserBillingOrder` in
  `upgradeInvoice.ts`): the first playlist's order when they bought it, else
  their own latest, else their account. Otherwise a recipient's QRGames
  invoice went to the giver.
- The line mails (`digital`, the redesign mail) go to the holder
  (`Mail.giftedLineHolder`) without the order number. Order mails carry
  `mail.giftHint` ("give it as a gift from My account"), since checkout has
  no entry.
- `deleteUserById` refuses a user who gave or holds a given set: deleting
  either side would take it from the recipient. The dashboard warns before
  deleting or refunding an order with given sets.

**When a set can be given** (`giftEligibility`, checked at making and again
at redeeming): a digital set once its PDF exists, a printed one (and sheets)
once the order went to the printer, because until then the print job,
corrections, finalCheck and the deadline mails are the whole order's and
addressed to the buyer. Never a gift card, a company-list order, a line with
an admin theme, a refunded or blocked line, one with corrections pending, or
one that changed hands. My account shows why ("as soon as it has gone to the
printer").

**Vouchers.** `gift_vouchers` (status open / claimed / cancelled / returned,
names, message, locale, giver, recipient) and `gift_voucher_lines`, whose
`openLineId` is the line id while the voucher is open and NULL after: a
unique index, so a set sits on at most one open voucher without a partial
index. Codes are `GIFT-XXXX-XXXX-XXXX`, 12 characters from
`ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L), stored without dashes;
`normalizeGiftCode` accepts any case, spaces and dashes. A gift card code
(`XXXX-XXXX-XXXX-XXXX`) on `/redeem` answers `giftCardCode`, and checkout's
discount field sends a `GIFT-` code to `/redeem`. The public lookup
(`GET /api/gift/redeem/:code`) is limited to 30 per IP per hour (429
`tooManyAttempts`) and shows names, message and per set what it is, never a
price or order number. The voucher's QR code is
`<FRONTEND_URI>/<voucher locale>/redeem/<code>`. No expiry; the giver can
cancel (a lost voucher: cancel, make a new one), and cannot redeem their own.

**The redeem** (`claim`) is one transaction:

1. Lock the voucher (`FOR UPDATE`). The same user again is a success (a
   double click); claimed by someone else 409 `alreadyRedeemed`, cancelled
   410 `noLongerValid`, the giver 400 `ownVoucher`.
2. Lock the lines: each must still be the giver's and pass `giftEligibility`,
   or 409 `setsChanged` and nothing is written.
3. `ownerUserId = recipient`, checking the number of rows updated.
4. The app design per line (`planAppDesignTransfer`, pure): the line's own
   custom design moves to the recipient (same slug, nothing changes in the
   app); a line that followed the giver's default gets a copy of it as its
   own row with a new slug, so the giver's later edits never reach the
   recipient's cards; a draft moves along unserved. Moved and copied rows get
   `app_designs.keepActive`. Nothing is carried when the giver never owned
   App Designer: the cards never showed it, and gifting must not unlock it.
5. The giver's corrections for those playlists are copied to the recipient
   (`INSERT IGNORE`), not moved: the giver may own the same playlist on
   another set.
6. The voucher becomes `claimed`; after the commit, best effort, the themes
   reload and both mails go out.

**App Designer is not transferred**, the design is. `resolveLineTheme`
(`apptheme.ts`) serves a `keepActive` row whatever the holder owns, right
after the admin-theme branch, unless the dashboard switch
(`users.appDesignEnabled`) is explicitly off: the cards were printed for that
look. Saving such a row answers 403 `keptDesignReadOnly` unless the holder
owns App Designer, so for a recipient without it the design is read-only.

**Registration without a purchase**: `customer-register-request` takes an
optional `giftCode`. With no paid order but an open voucher, the user is found
by e-mail or created (`createGiftRecipient`); a bad code answers
`noPurchaseFound` like no code, so the endpoint never confirms codes. The
pincode and password steps are unchanged; the site then calls the claim.

**Secrecy.** The recipient's links carry the order's Mollie id, so two pages
that showed the giver's details by that id alone were closed:
`GET /invoice/:paymentId` (price, order number, address) is signed for the
PDF Lambda (`renderSignature.ts`, view `invoice`), and
`GET /progress/:playlistId/:paymentId` answers "Payment not found" once a set
of the order was given away.

**Admin**: `POST /admin/gift/vouchers/:id/cancel` and
`POST /admin/playlist/:id/gift/return` (`returnToBuyer`: the line, its app
design row back to the buyer, the voucher `returned` once none of its sets is
given any more). The order list shows a "Gift voucher" / "Given to …" pill and
both in the line's action menu.

Deploy needs `prisma db push` (`ownerUserId`, `keepActive`, the two tables)
and `prisma generate`, then a restart.

## Play rankings per order line (admin Analytics page)

The frontend's admin Analytics page (`/dashboard/map`) ranks the most played
order lines over the last 24 hours, the last 7 days and all time
(`GET /playlist-plays`, admin only, `getPlaylistPlayRanking` in
`data/misc.ts`). By default a row is a `payment_has_playlist` id: the same
playlist bought by two customers is two rows. The page's "Per playlist"
switch asks `?group=playlist`, which adds those rows up per playlist. Built
2026-10-03.

- **Redis only counts per order line.** The per-playlist ranking reads every
  line's count (`AnalyticsClient.getPlayCounts`), looks up the playlist of
  each line played in any window (`IN` chunks of 5000) and sums. There are no
  per-playlist keys: the scan path does not know the playlist without a
  database query, and both views come from the same counts, the seed
  included. A line deleted since it was played still counts in its window's
  total but in no playlist's row.

- **Counted in `getLink()`** (`data/musicLinks.ts`), next to
  `analytics:songs:played`, by `AnalyticsClient.recordPlaylistPlay`. Only
  scans that carry a php (`/qrlink2/:trackId/:php`) count; old `/qrlink`
  cards and the admin's track edit cannot be attributed. A Redis failure is
  logged and never fails the scan.
- **Kept with the dashboard counters, so nothing clears them**: the analytics
  client's own connection on **db 1**, unprefixed. `Cache` is db 0 and puts
  the package version in every key it reads through `get`/`set`, so a deploy
  orphans those. Keys: `plays:php:total` (sorted set, member = php id, no
  TTL), `plays:php:hour:<YYYYMMDDHH>` (UTC, one sorted set per hour, 8-day
  TTL; the day window reads 24 of them, the week 168), `plays:php:since`
  (when counting began) and `plays:php:seeded`.
- **Never put them under `analytics:`.** `getAllCounters()` runs
  `KEYS analytics:*` and `GET`s each key, and a sorted set answers WRONGTYPE:
  the dashboard's analytics call would fail.
- ioredis 6 speaks RESP3 by default with the "legacy" reply mapping, which
  answers `ZRANGE ... WITHSCORES` as the flat RESP2 list (checked 2026-10-03
  on Redis 7.2). `addScores` reads `[member, score]` pairs as well, in case
  the mapping ever changes.
- **Seeded once** from the scan log (`ipInfoList`, the last 1000 scans) by
  `npx tsx scripts/seed-playlist-plays.ts` (dry run; `--write` to add). It only
  adds scans from before `plays:php:since`, so nothing is counted twice, moves
  `since` back to the oldest scan, and refuses once `plays:php:seeded` exists.
  There is no older per-scan history anywhere: all time means "since".

## Turnover and profit: one set of sums

The day and month reports (`Mollie.getSalesReport`), the country report
(`getPaymentsByMonth`), the tax and OSS report (`getPaymentsByTaxRate`) and
the dashboard's Finance card (`/analytics` → `Mollie.getSalesTotals`, which
adds the sales report's rows up) agree by construction; `analytics.ts` no
longer sums payments itself. All of them take paid orders after 2024-12-05
only. There is no test-order flag: `payments.test` was dropped on 2026-10-07
(nothing had set it since February 2026). Turnover "Combined €" is gross with refunds netted:
playlists' `totalPrice` (boxes and checkout add-ons ride inside it) plus
games upgrades plus account App Designer. Profit "Profit €" is ex-VAT:
`payments.profit` of the orders whose print cost is known (a physical order
counts 0 until `printApiPrice` is set, hence the "Known %" column and the
Finance card's caption) plus `gamesExVat` plus `appDesignExVat`. A games
upgrade is charged VAT-inclusive at the rate its row stores, so the reports
carry `gamesTotal` (paid) next to `gamesExVat`/`gamesVAT`, and the tax and
OSS report add the games shares to `totalPriceWithoutTax` and `totalVAT` the
way they do App Designer's; a (zone, country, rate) with only a games upgrade
gets a row. Initial games rows (free with an order) are counted, never summed.

**Business sales** are company lists switched to "Sold" on a company's Lists
tab (`PUT /business/companies/:companyId/lists/:listId/sold`, admin only;
`company_lists.sold` + `soldAt`, stored at 12:00 UTC of the picked day).
`src/businessSales.ts` reads them. A sold list adds what the Lists table
shows: `sellPrice` (ex VAT, after discount) as turnover, gross at the VAT its
invoice carries (21% for a Dutch company, 0% for EU reverse charge and
export), and `sellPrice - buyPrice` as profit (0, and not "known", while the
buy price is empty). Every sold list counts: filtering on the old "Lead" flag
(`Company.test`, removed 2026-10-03) hid a real €20k sale on the first
deploy. A list without a sell price
cannot be switched on. The day, month and country reports take
`?segment=consumer|business|both` (default consumer, what they always
showed); every row carries the `business*` fields, zero outside the segment.
The country report keys business sales by `Company.countrycode`, and the
product filter applies to consumer orders only. The Finance card always
shows both: `turnover`/`profit` are the sum, `consumer` and `business` the
split. The tax and OSS reports stay consumer only; business VAT is on the
MoneyBird invoices.

**Upgrades paid after the order are booked in full when their webhook
lands** (`bookUpgradeOnPayment`): gross into `totalPrice`, the split into
`totalPriceWithoutTax` and `productVATPrice`, and ex-VAT minus the boxes'
wholesale cost into `profit`, at the rate the upgrade was sold at (extra
cards) or the order's (boxes). They used to bump `totalPrice` only, so the
tax report and the profit missed them until a "Calculate profit" pass. That
pass (`setPaymentInfo`) recomputes from `totalPrice`, the printer's price and
the box count and lands on the same figures. It backs the VAT out at the rate
the payment was charged (`payments.taxRate`, `src/printers/paymentTaxRate.ts`),
never the country's standard rate: until 2026-10-24 it took the country rate,
so a reverse-charge order (0%, an EU business with a valid VAT ID) lost the
country's VAT from its turnover (order 100009253: €42.02 booked as €35.31 on
the tax report and the MoneyBird invoice). Note that checkout's own
`totalPrice − totalVATPrice` is not the better figure for consumer orders:
`totalVATPrice` often leaves out part of the charge (33 consumer orders in
October 2026 alone), and this recompute is what corrects their turnover when
they go to the printer; a box shipped on its own is a
separate printer order whose ex-VAT price `createBoxUpgradeOrder` books as
`payments.extraPrintCost` (off the profit at once, and again in every
recompute).

Purchases made after an order get their own invoice, mailed on its own with
the PDF attached: App Designer and QRGames (on the account), extra cards and
gift boxes (on an order). `src/upgradeInvoice.ts` does all of it; the
webhook branches in `mollie.ts` (`app_design_upgrade`, `bingo_upgrade`,
`box_upgrade`, `tracks_upgrade`) only call `issue()`, through
`invoiceSafely`.

- **Numbers are `U<year>-<00001>`**, a yearly sequence in `upgrade_invoices`
  (unique on `year, sequence`). Order invoices keep the order id as their
  number, so neither range has gaps from the other. Two webhooks racing for
  the same number: the unique index refuses one, which takes the next.
- **The row is a snapshot**: billing details, the lines (ex-VAT, VAT and
  incl. per line), totals in EUR, and what Mollie charged in the customer's
  currency. The PDF is `src/views/invoice.ejs`, the order invoice template,
  rendered by `GET /invoice/upgrade/:molliePaymentId` from that snapshot and
  kept under `PRIVATE_DIR/invoice/upgrade/<number>.pdf`. Like the order
  invoice route it is public by Mollie payment id, because the PDF Lambda has
  no session.
- **Idempotent on the Mollie payment, and never throws.** A replayed webhook
  finds the invoice and only retries the mail when `mailedAt` is empty (the
  mail throws on an SES failure for exactly that reason). An invoice problem
  never fails the webhook: Mollie would retry a purchase that was recorded
  fine.
- **Billing details**: extra cards and gift boxes use the order's invoice
  address (falling back to the delivery address). App Designer has no order,
  so it uses the account's latest paid card order, the same one whose country
  set the VAT. QRGames uses the order of the first playlist it unlocked, and
  its amount, count and rate come from the `games_purchases` row.
- **The order invoice leaves booked upgrades out.** The extra-cards and
  gift-box webhooks add what was charged to the order's `totalPrice` (the
  books, which the reports read), and the order invoice takes its total from
  that column. `GET /invoice/:paymentId` therefore subtracts
  `amountBookedOnOrder()`, the sum of the order's `extra_tracks` and `box`
  upgrade invoices (`ORDER_BOOKED_UPGRADE_TYPES`), before it renders or
  derives the display rate; otherwise a regenerated order invoice would bill
  those again. It only works if the webhook books exactly the invoice total:
  the box webhook books boxes + shipping as charged (it used to add VAT on
  top of the VAT-inclusive box price), and the extra-cards webhook books the
  metadata's `totalEur` (for older payments: the EUR charge or Mollie's
  settlement). Upgrades from before the U range have no invoice to subtract,
  so their orders' invoices still show the inflated total.
- **Extra-card lines** come from the price breakdown the payment carries in
  its Mollie metadata (`extraTracksCostEur`, `handlingFeeEur`,
  `boxesCostEur`, `totalEur`, `taxRate`, written by the tracks
  `upgrade-payment` route): cards, handling and gift boxes, with the cards
  line absorbing the rounding so the lines add up to what was charged.
  Payments created before those fields existed get one line of the EUR
  charge.
- **Gift-box lines** (`box`): the boxes and any shipping, rebuilt from the
  payment's metadata (`boxPrice` × `quantity`, `shippingCost`), so a replay
  after the box is already enabled issues the same invoice.

## Company list invoices (MoneyBird, 30/70/100%)

The dashboard's Lists tab invoices a company list in MoneyBird, in full or as
a 30% down payment plus the rest. **The invoice never recalculates the
price.** The admin calculators (in the frontend) work out the client price
from the printer cost, the profit table, the reseller toggle and forced
prices, and the API cannot redo that: it only knows the printer cost. Until
2026-09-22 `buildInvoiceLineItems` recomputed from the stored calculator
inputs and billed Tromp and Schneider lists at roughly the printer's price,
so no invoice matched the quotation or the Sell column.

- Lists are printed by Tromp (`printer = 'qrsong'`) or Schneider.
  `listPrinterVariant` reads any other value (or none) as Schneider, and the
  list update refuses any other printer. Quotations are `qrsong` (Tromp) or
  `schneider`; the quotation routes refuse any other type.
  `Company.calculation` is only read for the old company-wide discount that
  Tromp and Schneider calculations saved before the discount moved onto the
  list fall back to; nothing writes it any more.
- Every calculator save carries a `pricing` snapshot inside the variant's
  calculation JSON (`calculationTromp` / `calculationSchneider`): quantity,
  unit price, one-off extras, app and portal fees, discount %. `src/listPricing.ts` parses it and does the sums;
  the frontend mirrors it in `shared/list-pricing.util.ts` with the same
  rounding. The save endpoints set `sellPrice` from it (excl. VAT, after
  discount), and `buildInvoiceLineItems` builds the lines from it. A list
  without a snapshot cannot be invoiced; opening its calculator saves one.
- **Tromp license fee.** When Tromp finds the client and handles the sale,
  the design and the printing, "Tromp sold this" in the Tromp calculator
  prices the list at our license fee per set (the table is
  `shared/tromp-license-fee.util.ts` in the frontend) and the snapshot
  carries `trompSold` and `licenseCards`. The quotation and the invoice
  then name the license instead of a box (`invoice_lines.licenseFee`,
  `quotation.licenseProduct*`), and the quotation is a single page: it
  leaves out the signature block, the down payment notice, the product
  information page and the terms and conditions, which are all written for
  a client ordering boxes. Nothing else is
  special: such a list is kept under the Tromp company, so the quotation,
  the invoice, the VAT and the MoneyBird contact are Tromp's like any
  company's. Its buy price is 0, Tromp prints on its own account.
- The discount belongs to the list. Tromp and Schneider used to write it to
  `company.calculation` (company-wide), where the quotation read it and the
  invoice did not. Lists saved before the move still fall back to the
  company value, on the quotation and in the calculator.
- The remaining payment is the list total minus the down payment **as
  invoiced** (its `total_price_excl_tax` in MoneyBird), not 70% recomputed.
- Invoices are recorded by MoneyBird id in `company_list_invoices` and found
  by id (`src/listInvoices.ts`). The reference (the list name) is only the
  fallback for invoices from before the table, and only exact matches on
  the company's own contact (`qrhit-<companyId>`). Searching by name alone
  showed another company's invoice for a list of the same name and lost
  invoices when a list was renamed. The POST refuses a payment that is
  already covered (409), and a MoneyBird outage fails the lookup instead of
  reading as "nothing invoiced".
- `createInvoice` sends `prices_are_incl_tax: false`; every caller passes
  excl. VAT prices, and leaving it out lets the workflow default decide.
- MoneyBird contacts are keyed on the company id, and the dev database has
  its own ids, so a company in `qrhit_dev` can resolve to a real customer's
  contact in the shared administration (dev company 53 finds contact
  `qrhit-53`). An invoice created from a local API is a real invoice.
- **Schneider shipping abroad** (added 2026-10-06, `src/businessShipping.ts`).
  Schneiders ships with DHL; within the Netherlands it is in the box price.
  The calculator sends `deliveryCountry` (ISO code, absent = NL) and
  `forceShippingPrice` (excl. VAT, null = estimate, 0 = free), stores both
  in `calculationSchneider`, and gets `calculation.shipping` back (cartons,
  pallets, parcel and pallet totals, mode, estimate, price). A price above 0
  is the one-off extra `key: 'shipping'`, counted in the Schneider cost and
  the client price, so the snapshot, quotation and invoice carry it like the
  cutting die; the quotation and invoice name it "Versand nach Deutschland
  (34 Umkartons auf 1 Palette)" (`extras.shipping*` in the business bundle,
  with `extras.shippingTo.<ISO>` for countries that need an article). The
  rates are InTime's 2026 DHL list prices, an estimate: Schneiders' own
  rates are unknown, and the only pallet rate is DE.
  **The discount never applies to shipping** (Rick, 2026-10-06): the
  list's discount % is taken of the subtotal without the shipping extra(s),
  and shipping is added after it. `listPricingTotals`:
  `discountAmount = round2((subtotal − shippingTotal) × pct / 100)`,
  `total = round2(subtotal − discountAmount)`; `subtotal` still sums
  everything and `shippingTotal` is returned too (the frontend's
  `list-pricing.util.ts` mirrors it). Without shipping nothing changed. The
  invoice puts the shipping line after the discount line; the quotation,
  when there is a discount, shows subtotal (without shipping), discount,
  shipping, total excl. VAT, and without one keeps shipping as the last
  item row.

## Order status board (company lists from interest to delivered)

The admin's Order status board (frontend `src/app/admin-order-status/`, see
its CLAUDE.md) shows every company list as a sticky in one of six columns,
with a Someday section under it. `src/orderBoard.ts` builds the cards and
validates changes; built 2026-10-13.

- Columns are `CompanyList.orderStatus`: `interest | contact | offer_sent |
  agreed | in_production | delivered`, plus `someday` (out of the process
  for now, not archived; Rick's ask) (default `interest`). Not `status`,
  which the old voting wizard owns and the API rewrites by itself (every
  `new` list becomes `company` when its company is saved; `finalizeList`).
  Agreed does not touch `sold`.
- Also on the list: `orderStatusAt` (last move; null = never moved by
  hand), `orderPosition` (order in the column), `orderNote` (500 chars,
  not `internalNotes`, which qquote fills with where a request came from),
  `orderArchived`, `contactUserId` (a user of the list's company, checked
  on every save; `SetNull` when the user goes).
- `GET /business/order-board` returns all cards (archived ones too).
  `POST /business/order-board/move` is a drop: `listIds` (the board sends
  one), `orderStatus`, and `orderIds`, the target column's ids in their new
  order, which renumbers that column. `PATCH /business/order-board/lists/:listId`
  is the sticky's edit (`orderStatus`, `contactUserId`, `orderNote`,
  `desiredDeliveryDate`, `deliveryAsap`, `orderArchived`); a changed column
  puts the list on top of its new column. `PUT .../lists/:listId/info`
  accepts `orderStatus`, `contactUserId` and `orderNote` too. Every change
  of column stamps `orderStatusAt` and writes a `status_change`
  CompanyEvent (the Timeline).
- A card's reseller flag, box type and cards per box come from the
  calculator JSON of the list's printer (`listCalculationState`, next to
  `listBoxes` in `listPricing.ts`); profit is `sellPrice − buyPrice` when
  both are known.
- `GET /business/state/:listId` adds the board fields for admins only: the
  note is internal and `companyadmin` users can call that route.
- **One-time backfill** after the first deploy:
  `npx tsx scripts/backfill-order-status.ts` (report) and `--write`: a sold
  list goes to Agreed, a list with a quotation to Sent offer, the rest stays
  Interest; only lists never moved by hand.
- The deadline warnings (Schneider's 15/20 business days) are worked out
  by the page; the API only stores the delivery date.

## Business quote requests and the company asset store

The /business form, the private file store behind a company's Assets tab and
mailing files to a contact all live in `src/routes/businessRoutes.ts`
(`quoteRequests.ts`, `companyFiles.ts`). The frontend CLAUDE.md, "Business
quote requests", explains the flow and its rules. Things to know here:

- **The three-size quotation (48, 96 and 192 cards side by side) was removed
  on 2026-10-06 at Rick's request**: `POST /business/quotation/:companyId/box-options`,
  the Lambda view `GET /business/quotation-options/:number`, the quote request's
  `POST /business/quote-requests/:id/quotation`, `boxOptionsQuotation.ts`,
  `box_options_quotation.ejs` and its `quotation.options*` keys. Quotations
  are made per box size (`qquote quote`). Rows with variant
  `schneider-options` and their archived PDFs stay, and a request's
  `quotationId` still points at one made before. The shared pricing
  (`priceFromCost`, `PROFIT_TIERS`, the profit table) moved to
  `src/services/boxPricing.ts` for the price-list brochure.

- boxd and qquote call these routes with the admin bearer token
  (`QRSONG_API_TOKEN` in their `.env`), like the dashboard.
- The AI asset generator (`assetQueue.ts`, Gemini) is gone; `company_assets`
  is kept unread as the rollback path. After `db push` on production, run
  `npx tsx scripts/migrate-company-assets.ts` (report) and then with
  `--write` to copy its images into the store.
- **Company files and list files** (2026-10-03). `CompanyFile.companyListId`
  puts a file on one of the company's lists (designs, track list, printer
  files); null keeps it on the company (logos, brand kit).
  `GET .../files` without `listId` is the company's own, `?listId=<id>` that
  list's, `?listId=all` both; uploads take a `listId` field and `PATCH` a
  `companyListId` to move a file. A list that is deleted hands its files
  back to the company (`SetNull`). The list's old Files tab
  (`company_list_files`, cards/box, never used in production) is gone with
  its routes; the table stays unread. The printer order mail
  (`getOrderEmail`) and Live orders count the list's assets in the Design
  category.
- **Thumbnails** (`companyFilePreviews.ts`, cached next to the file as
  `.thumb.webp` / `.thumb.svg`, two renders at a time per process): images
  with sharp; PDF and Illustrator (an `.ai` is a PDF inside) the first page
  through pdf-parse/pdf.js; PSD our own reader of the merged image
  (ag-psd refuses CMYK, and print files are CMYK), wrapped in a TIFF with
  the file's ICC profile so sharp converts the colours, falling back to
  Photoshop's stored JPEG preview; xlsx/csv the top-left corner as an SVG
  the browser renders with its own fonts (the servers have none). exceljs
  cannot read workbooks with namespace-prefixed XML (some .NET exports);
  those keep the icon.
- **Previews are bounded** because PSD and PDF brand kits come from the public
  /business form without login: a PSD header is only believed when its
  image data is in the file (sides up to 300,000), a PDF page is scaled by
  its longer side, a CSV is read for its first 256 KB, an xlsx over 10 MB or
  that really unpacks past 64 MB is refused before exceljs sees it
  (`xlsxUnpacksWithin` streams every entry through the JSZip copy exceljs
  itself loads and stops at the limit: a zip parser of our own would see
  other entries than exceljs, and the declared sizes are not believed),
  sharp stops at 100 megapixels, and a failed preview (`.thumb.failed`) is
  not retried for a day. Keep any new renderer inside such limits.

## EmailOctopus business lists (company contacts)

Every company's contact address and its users go on an EmailOctopus business
list in the company's language, next to the consumer lists that
`Mail.uploadContacts()` fills. `src/businessContacts.ts`, run nightly at 03:30
from `Mail.startCron()` and on demand from the dashboard (Bulk actions →
System → "Sync business lists", `POST /admin/mail-octopus/business-sync`,
`dryRun` for a preview). Built 2026-10-03.

- **Lists:** `QRSong! business (NL|EN|DE) (LIVE|DEVELOPMENT)`, made by
  `scripts/create-business-octopus-lists.ts`, ids in
  `MAIL_OCTOPUS_BUSINESS_LIST_ID_NL/EN/DE` (LIVE on the servers, DEVELOPMENT
  locally, like the consumer lists). Fields `FirstName`/`LastName` (the name
  split at the first space), `CompanyName`, `Country`. Every company is
  mailable; there is no lead/customer split.
- **Language:** `company.locale`, nl → NL, de → DE, anything else → EN, NULL
  → NL (the column default; every NULL company was Dutch or Belgian). An
  address on several companies goes with the latest updated company. Users
  in `admin` are left out.
- **Excluding a company:** "Exclude from business mailings" on the company's
  details (`Company.excludeFromMailing`). Its contacts are left out and the
  next run takes them off, unless they are also a contact of a company that
  is not excluded. These removals do not count towards the guard below; an
  unsubscribed contact still stays on the list.
- **A reconcile, not an upload.** It reads the three lists and diffs them
  with the database: add, update what differs, move between lists when the
  language changes, remove who is no longer a company contact. So no `sync`
  flag and no hooks in the company code.
- **Nobody is subscribed again.** The upsert is sent without `status` (new
  contacts are created subscribed, existing ones keep theirs); a move carries
  `unsubscribed` to the new list; an unsubscribed contact who left a company
  stays on the list. Never add a `status` to the upsert.
- A run that would remove more than 20% of the lists (and more than 10)
  removes nobody and sends a Pushover: a broken query or the wrong database
  must not empty them.

## The qrsong toolkit's routes (admin only)

Rick's `qrsong` CLI (`~/Sites/skills/skill-qrsong`) drives business orders with the
admin bearer token. Its routes live in `src/routes/toolkitRoutes.ts`, all
`getAuthHandler(['admin'])`, none behind a dashboard screen:

- `POST /admin/playlist-from-excel` takes `createPlaylist=false` to only
  match, and every job now reports `matches` per row (track id, database or
  Spotify, `exact` or `loose`, the matched name and artist, `duplicateOfRow`).
  Loose matches deserve a look: the prefix rule took BLØF "Hier" for "Hier
  Aan De Kust", and "Grease" as an artist matched the 2016 Grease Live cast.
  The database lookup only takes Spotify tracks (`trackId` of 22 base62
  characters, `SPOTIFY_TRACK_ID_SQL`): `tracks` also holds Apple Music,
  Deezer, Tidal and YouTube ids (about 9% in October 2026), and one of those
  in the list made Spotify refuse the whole playlist with a bare 400 (Asito,
  "Walking on Sunshine" as 723501674, 2026-10-15). A song we only know under
  another service goes to the Spotify search like any unknown row.
- `POST /admin/toolkit/playlist` makes or refills a playlist from exact track
  ids. Without `playlistId` it refills a playlist with the same name among the
  account's first 50 (or makes one); with `playlistId` it refills exactly that
  playlist (PUT the first 100 tracks, POST the rest) and renames it to `name`,
  but only when our account owns it (403 otherwise, 404 when Spotify does not
  know it). `description` sets the public description (`PUT /v1/playlists/{id}`,
  line breaks removed, cut to Spotify's 300 characters); without it a new
  playlist still says "Created automatically.". Both were added for the
  default playlists (2026-10-16), whose ~90 playlists push older ones out of
  the first 50. `GET /admin/toolkit/playlist/:id/items` reads one back exactly as
  Spotify holds it (`src/playlistItems.ts`; `Spotify.getTracks` merges and
  filters, which is right for printing and wrong for verifying);
  `POST /admin/toolkit/tracks` gives metadata for ids.
- `POST /admin/toolkit/playlist/:playlistId/replace-spotify` (`src/playlistReplace.ts`,
  2026-10-21) points an existing playlist row at another Spotify playlist
  (`spotifyPlaylistId`), fetches its tracks through the music provider and
  stores them on the row the way an order does (`storeTracks`, which drops the
  ones not in it; fetching alone, as `/spotify/playlists/tracks` does, stores
  nothing). The same id twice only stores the tracks again. Songs new to the
  database come in without a checked year. Slug, product page, featured state, texts,
  translations, image, ranking and the Merchant Center product stay; caches of
  both ids and the slug are cleared and the row is marked for Merchant Center.
  For a featured list on someone else's Spotify account that needs fixing: the
  toolkit makes a cleaned copy in our account (`qrsong playlist copy`) and this
  puts it in place (first: "Russian Hits", row 5740). Without `apply: true` it
  only checks. Orders keep the row, so a regenerate or "order again" of an
  older order uses the new list; it refuses (409) while an order of the row is
  paid but not finalized, or a Print&Bind physical line is not sent to the
  printer yet (`openOrders`, test/unit/playlist-replace.test.ts), and when the
  new Spotify playlist already has a row of its own.
- `POST /admin/toolkit/order` (`src/toolkitOrder.ts`) writes a Schneiders or
  Tromp order directly, like the reseller API: status `paid`, totals 0, no
  Mollie, no invoice, no mail, `marketingEmails` off, generation with
  `skipMainMail`, no printer hold (see "Only printnbind goes to Print&Bind").
  Print&Bind and the reseller type are refused; `expectedTracks` refuses a
  playlist whose track count differs. Approved by Rick on 2026-10-03.
- `GET /admin/toolkit/order/:paymentId` (design, print files, every card with
  its year check), `PUT .../design`, `POST .../regenerate` (forced finalize,
  no mail; not once at a printer, and a Print&Bind order only while on hold).
  `template` on the order and its design is a `pdf_*.ejs` file or a stored
  template (see "Card templates stored as data"), with optional
  `templateVersion`.

### Only printnbind goes to Print&Bind

`Generator.sendToPrinter` sends a payment's physical lines whose
`printerType` is `printnbind` and nothing else, whoever calls it (the hourly
pass, the customer's approval, the dashboard); a payment without one is
refused with `No Print&Bind playlists`. The hourly pass only selects payments
with such a line, and the dashboard's "not sent to printer" attention flag
only counts them. Until 2026-10-07 nothing looked at the printer type:
Schneiders orders 8194 and 8237 went to Print&Bind once their 36-hour timer
ran out, and toolkit orders were created on printer hold to keep them out.
That hold is no longer set.
- The dashboard's "Send to printer" (`POST /create_order`,
  `Generator.sendToPrinterFromAdmin`) refuses such a payment before
  `setupForPrinter`, which would otherwise set its status to `Submitted` and
  clear its tracking link first (2026-10-24; the menu offers the action on
  every physical order).
- Finishing the year check (`POST /yearcheck`) still finalizes the order with
  the "finalized" mail to the order's address, as for any order; toolkit
  orders are booked on Rick's account.
- `POST /admin/toolkit/share` (multipart `file`, zip or pdf, up to 100 MB,
  optional `label` and `notify`) stores a file under
  `PRIVATE_DIR/share/<128-bit hex token>/` and returns the secret download link
  `/share/<token>/<name>`: for print files too large to mail (Rick,
  2026-10-03). That public route serves the file, logs every request in the
  share's `downloads.jsonl` and mails `notify` (default `INFO_EMAIL`) on a GET
  (not a HEAD), at most once per 10 minutes, in the standard `custom_email`
  template (`Mail.sendCustomMail`). Mail scanners such as Microsoft Safe Links open links
  themselves, so the mail shows the browser. `GET /admin/toolkit/share` lists
  shares with their download counts, `DELETE .../:token` removes one.

## Default playlists (Companies → Default playlists)

About 30 curated themes ("80s Hits", "Rock Classics", "Christmas" …), each in
the three box sizes (48, 96, 192 cards): ~90 playlists in our own Spotify
account that we offer companies and resellers as standard lists. Built
2026-10-16; they replace the playlist suggestions brochure (every featured
playlist by market, genre and box size), which Rick dropped: "We gaan nu uit
van deze 30x3 lijsten."

- **Model** `DefaultPlaylist` (`default_playlists`): one row per theme and
  size, unique on (`themeKey`, `cardCount`) and on `spotifyPlaylistId`;
  `category` is `decades` | `genres` | `themes` | `local` (Dutch and German
  language hits), names and descriptions in en/nl/de, `yearFrom`/`yearTo`,
  `decades` ([{ decade, count }] ascending), up to 8 `artists`, `sortOrder`.
  Logic in `src/defaultPlaylists.ts`, routes in
  `src/routes/defaultPlaylistRoutes.ts`.
- **Who fills it:** Rick's toolkit (`qrsong default-playlists …`, in
  `~/Sites/skills/skill-qrsong`) builds the playlists with
  `POST /admin/toolkit/playlist` (`playlistId` + `description`, see the
  toolkit routes) and writes the rows with `PUT /business/default-playlists`.
  The dashboard (Companies → Default playlists, frontend repo) lists them,
  filters, and downloads the brochure of the checked ones; the toolkit can
  download it too.

| route | |
|---|---|
| `GET /business/default-playlists` | admin: every row, by sortOrder, themeKey, cardCount |
| `PUT /business/default-playlists` | admin: `{ playlists: [...] }`, upsert on theme and size, up to 300; answers the saved rows in the order sent |
| `DELETE /business/default-playlists/:id` | admin: one row; the Spotify playlist is left alone |
| `POST /business/default-playlists/pdf` | admin: `{ locale, ids }` → the brochure PDF; name in `Content-Disposition` (`QRSong_Default_playlists_<date>.pdf`, Dutch `QRSong_Standaard_playlists_…`) |
| `GET /business/default-playlists/view?locale=&ids=` | **public**: the HTML the PDF Lambda prints |

A row as answered: `{ id, themeKey, cardCount, category, name: { en, nl, de },
description: { en, nl, de } (null allowed), spotifyPlaylistId, spotifyUrl,
trackCount, yearFrom, yearTo, decades, artists, sortOrder, updatedAt }`. The PUT
takes the same without `id`/`spotifyUrl`/`updatedAt` (sent back unchanged they
are ignored) and is strict: unknown fields, a decade outside the year range,
more songs in `decades` than `trackCount`, or a Spotify playlist that already
belongs to another theme or size are a 400 that names the row and the field,
and nothing of the call is stored.

- **The view is public on purpose**, like the suggestions view before it: the
  Lambda has no session, and the brochure shows no prices, only playlists that
  are public on Spotify. Ids and locale are validated (1–300 whole numbers;
  any other language is English); unknown ids are left out, none known is a
  404 (the PDF route answers 400 before it calls the Lambda).
- **The brochure** (`views/default_playlists.ejs`, formal copy under
  `defaultPlaylists.*`): the shared cover (`partials/front_page`, the
  categories as its contents), an introduction page (the three box sizes, how
  the lists are made, listen first, your own music is always possible), the
  themes grouped by category, and the shared closing page. One row per theme:
  number, name, year range, description, a decade chart (one axis for the
  whole brochure, the busiest decade in POP when there is a single one), a few
  artists (whole names only) and a tile per **selected** size with a QR code
  of its Spotify link (an inline SVG from `qrcode`, the code itself 16.5 mm
  plus a four-module quiet zone) that is also a link in the PDF. The size
  tiles are columns down the page; a size nobody selected gets no column.
- **Pages never overflow by construction:** `buildDefaultPlaylistsView` cuts
  the pages from fixed heights (`BROCHURE_LAYOUT`: 245 mm of body, 13 mm a
  section title, 43.5 mm a theme; five themes a page) and the view uses the
  same numbers. A section that runs on repeats its title. It takes rows and a
  translator and touches no database, so it can be proofed from a fixture.
- **Proof** after any change to the view, the copy or the layout numbers:
  `npx tsx scripts/default-playlists/render.ts` renders
  `scripts/default-playlists/fixture.json` (30 themes x 3 sizes, fake ids) in
  nl, en and de with the local Chrome, printed like the Lambda, and checks in
  the page that nothing overflows a sheet, a row or its text, that artist
  names are not cut, that every QR code is at least 16 mm and that the PDF
  has the planned pages (`--themes`, `--sizes`, `--ids` for other
  selections; `--png 60` writes PNGs to look at). Exit code 1 on a problem.
- **Removed with the suggestions brochure:** `GET /business/playlist-suggestions`,
  `GET /business/playlist-suggestions/art/:playlistId`,
  `POST /business/playlist-suggestions/pdf`, `GET /admin/playlist-suggestions/count`,
  `GET /admin/genres` (only its modal used it), `src/playlistSuggestions.ts`,
  `views/playlist_suggestions.ejs`, the suggestion filter in
  `data/featuredPlaylists.ts` and its `Data` wrappers, and the `suggestions.*`
  copy. `src/playlistArtwork.ts` stays (the product page cover); the old
  thumbnail cache `PUBLIC_DIR/suggestion_art` is unused and can be deleted on
  the servers.

## Card templates stored as data (no deploy)

A company card layout used to be a `views/pdf_<name>.ejs` file: JavaScript on
the API server, so a new one needed a deploy and a restart, and uploading one
would have been remote code execution behind the admin token. Since
2026-10-15 a layout can be **stored as data** instead (`src/cardTemplates.ts`,
routes in `src/routes/cardTemplateRoutes.ts`, table `card_templates`): Liquid
(LiquidJS) for one card front, one card back and the CSS, plus its own
pictures and fonts. Rick's qrsong toolkit pushes them
(`qrsong template …`); the format and how to write one is
`~/Sites/skills/skill-qrsong/reference/card-templates/README.md`.

- **Versions never change.** Every push is version N+1. An order line pins the
  version it is given (`payment_has_playlist.templateVersion`): POST `/php/:id`
  and the toolkit order routes take `template` plus optional `templateVersion`
  (a number or `'latest'`). Without a version, a line that already has that
  stored template **keeps its pin**: the dashboard's production settings send
  the template on every save and must not move an order to a newer version.
  A file template has no version (null). `resolveForLine` /
  `resolveAssignment` refuse a name that is neither a file nor stored.
- **Card size = printer.** A version is drawn for 56 mm (Schneiders) or 60 mm
  (Tromp, Print&Bind), or `cardSizeMm` null follows the printer. Assigning a
  template, or changing a line's printer, refuses a mismatch
  (`checkCardSize`). `pdf.ts` takes the page size from the pinned version
  (`printerPageSize`); the 3 mm bleed is added after as before.
- **Rendering.** The PDF route (`/qr/pdf/...`) renders a stored template when
  the name is not a `pdf_*.ejs` file (files win; a stored template cannot take
  a file's name). Liquid renders `stored.css` once and each card's front and
  back; `views/stored_card_page.ejs` (deliberately not `pdf_*`, so it is not a
  template name) writes the page: the order's design font unless the template
  says `designFont: false`, the how-to card, the page breaks, the `@font-face`
  rules of its `fonts`, and the fit script. Compiled templates are cached per
  name and version, so a push works at once in every worker.
- **What Liquid gets** is a plain JSON copy: `track`, `qrUrl`, `qr` (module
  grid of the QR picture, for exact placement), `card`, `design` (the card's
  design columns plus `backgroundUrl`, `backgroundBackUrl`, `logoUrl`,
  `yearFontSize`), `order` (`lineId`, `printerType`, `doubleSided`), `eco`,
  `batchNumber`, `template`, `data`. No e-mail, address or payment. The engine:
  no file system (`templates: {}`), own properties only, strict variables and
  filters, output HTML-escaped like `<%=` (`| raw` opts out), JavaScript
  truthiness (`jsTruthy`, so `| default` is `||`), LiquidJS's parse, render and
  memory limits (a loop over 1..1e8 stops in ms).
- **The page runs under a Content-Security-Policy** (`cardTemplateCsp`): no
  default source, pictures and fonts from this API and Google Fonts, inline
  styles, and only the script with the response's nonce (the fit script).
  That is the enforcement in the PDF Lambda's Chromium; `checkSource` refuses
  `<script>`, `on…=`, `javascript:`, `<iframe>`, `<link>`, URLs outside the
  template and `include`/`render` at push, with the line, so the author sees
  why instead of a silently blocked element.
- **Assets** (`PUBLIC_DIR/card-templates/<name>/<sha256>.<ext>`,
  content-addressed): PNG, JPEG, WebP and the fonts TTF, OTF, WOFF, WOFF2,
  known by their bytes, never their name; SVG (can carry script) and font
  collections are refused, pictures over 50 MP, files over 15 MB, more than 40
  assets or 60 MB per push. Fonts are read with fontkit at push (a broken file
  is an error, not a fallback font on the cards) and the push answers each
  font's family, weight and style.
- **Fit building block** (`FIT_SCRIPT`): an element with `data-fit` gets the
  largest size at which its child boxes stay inside it, measured by Chromium
  after `document.fonts.ready` (the Lambda waits for that plus 500 ms). It sets
  `font-size`, `--fit-size` and `data-fit-size`. It replaces the text-size
  estimates of the Bird and Facta templates for new work.
- **Push** (`POST /admin/card-templates/:name`, multipart `manifest` +
  `asset` files) checks the source, every asset, every literally named asset
  and a trial render on the sample cards in three designs (an error in one
  design is caught here, not at the printer). `?check=1` does all of it and
  stores nothing.
- **Proof**: `POST /admin/card-templates/:name/:version/proof` (sample cards
  with real QR pictures in `qrColor`, or an order's own cards) prints the
  signed page `GET /card-templates/proof/:name/:version` (HMAC on
  `JWT_SECRET`, an hour; the Lambda has no session) through the PDF Lambda.
  In development the Lambda reaches the local API through the ngrok
  `API_URI`.
- **The PDF route read the wrong template column until 2026-10-15.**
  `getPlaylistsByPaymentId` selects the line's template as `orderTemplate`;
  `template` there is the playlist's legacy column. The route forced
  `php[0].template`, so a request for the plain `printer` layout (finalCheck's
  design-drift render) got the printer layout, not the company template. It
  now reads `orderTemplate` and `orderTemplateVersion`, and refuses a template
  name that is neither a file nor stored (404) instead of rendering
  `pdf_<anything>.ejs`.
- **Checking a conversion**: `npx tsx scripts/card-templates/compare.ts --dir
  <templates> [name …]` renders a `pdf_*.ejs` and its stored conversion with
  the same fixture cards in three designs, prints both like the Lambda (local
  Chrome via `puppeteer-core`), rasterises with pdftoppm and compares every
  page pixel by pixel. All 18 company templates were converted (in the
  toolkit's `reference/card-templates/`) and came out identical: 57 cases,
  950 pages. `scripts/card-templates/render.ts` prints one folder with given
  cards and QR colour, as a local proof.
- The 18 conversions are not pushed: the `pdf_*.ejs` files still serve those
  orders. A stored template cannot take a file's name, so moving a company
  over means a new name (and setting it on their orders) or removing the file
  in a deploy first.

## Printer card previews and die lines (dashboard and toolkit)

The dashboard's per-line card preview (`app-deck-designs`) draws a card from
the design columns in the browser and knows nothing about card templates, so
a template order showed another card than the one printed. For a line with a
template the dashboard shows pictures the API makes instead
(`src/cardPreview.ts`, built 2026-10-15):

- `GET /admin/playlist/:phpId/card-preview` (admin): the first card's front
  and back as cut (`front`, `back`, 720 px) and as printed with the 3 mm bleed
  and the printer's guides (`frontDie`, `backDie`, 900 px): the die line
  (magenta, corners 4.35 mm on the 56 mm card, Schneiders' measured die, the
  same ratio for 60 mm), the bleed edge (grey, dashed) and the safe zone
  (cyan, 3 mm inside). Paths under `/public/card-previews/`.
- **Source**: the line's stored printer PDF while its `pdfFingerprint` still
  matches, or when it has none (`source: 'pdf'`; the first card is after the
  how-to card). A PDF without a fingerprint predates them and is what was
  printed, legacy layouts such as Kramp's included; a render would draw
  today's layout. Otherwise one card rendered now through the PDF Lambda from
  `/qr/pdf`, the way the generator asks for item 1 (`source: 'render'`).
  `pdf.ts` addBleed scales the content up to fill page plus bleed, so a fresh
  render (taken as exactly the card, as resizePDFPages does) is scaled the
  same way before the 3 mm come off; `test/unit/card-preview.test.ts` checks
  that against addBleed itself.
- The dashboard shows these for every line whose cards a template draws: its
  own card template, or the Schneiders layout of every Schneiders line.
- **The fingerprint now includes the line's template and pinned version**
  (`orderTemplate@orderTemplateVersion`, only when there is one, so lines
  without keep their hash). `template` in its field list is the playlist's
  legacy column; until 2026-10-15 a new template on a line left its PDF
  looking current, also for `regenerateStalePrinterPdfs`.
- Pictures are named `<phpId>-<HMAC on JWT_SECRET of everything they show>`
  (source, template and version, a file template's mtime, the card size, the
  design and the first card's track and year, the PDF's mtime): any change is
  a new name, the files are public but not guessable, a line keeps only its
  newest set.
- **Nothing waits for the Lambda** (Rick, 2026-10-15). Pictures that are
  there answer 200 `ready`. Otherwise the route starts the render in the
  background (one per line: in the worker, plus a Redis lock across
  workers), waits `inlineWaitMs` (1.5 s, enough for a stored PDF) and else
  answers 202 `generating`; the dashboard says so and asks again. A render
  that fails answers 502 `failed` and is remembered for 10 minutes
  (`card-preview-failed:<name>`), so polling does not start one per request;
  `?retry=1` clears that. A stored PDF that does not render is passed over
  for a day (`card-preview-unreadable:<file>:<mtime>`).
- `POST /admin/card-preview/die-lines` (admin, multipart) is what the qrsong
  toolkit's `design cut-check` uses (Rick: the toolkit gets its die line
  pictures from the API): `file` (PDF, taken as it is, or a PNG/JPEG canvas of
  `pageMm`, default card + 6) or `paymentHasPlaylistId`, plus `pages`,
  `cardMm` (56) and `views`, a JSON list of `{ px, x, y, sizeMm, guides }`
  parts in page mm (up to 12, 3000 px). The card sits in the middle of the
  page. Answers base64 PNGs.
- PDF pages are rasterised by `src/pdfRaster.ts` (PDFium, shared with the
  Merchant Center's AI images). It sizes the bitmap from the page's exact
  size: pdfium itself floors the size in points, which read a 62 mm page as
  61.74 mm.

## Card order: service, year mix, hand order

Cards print in `playlist_has_tracks.order` (`getTracks`; QR colours, the PDF
chunks and the corrections page all number cards that way). It is one order
per playlist, shared by every order of it, and three things can set it, the
first that applies wins:

1. **A hand order.** Drag and drop on the dashboard's track-order page sets
   `Playlist.manualTrackOrder`. Regeneration then keeps every card where it is
   and adds new tracks at the end.
2. **The year mix.** Business clients often build their list from old to new,
   and Schneiders delivers the deck in that order: the first box compartment
   was all sixties. `storePlaylistData` gives a business deck (`isBusinessDeck`:
   printer Schneiders or Tromp) a `Playlist.trackMixSeed`, and
   `storeTracks` then orders the cards with `src/trackMix.ts` after the years
   are known: every stack of 48 gets its share of every era, shuffled, with no
   two neighbours sharing a year or an artist where the deck allows it. The
   mix is seeded, so a regeneration reproduces the same deck and print
   fingerprint until a track or a year changes; once set, the seed stays,
   whichever order triggers the next regeneration. "Mix years" on the
   track-order page (`POST /admin/playlist/:phpId/track-order/mix`) draws a new
   seed and clears the hand order.
3. **The streaming service's order**, for everything else (consumer decks).

`Payment.isBusinessOrder` (a company on the invoice at checkout) does not make
a business deck: those are ordinary Print&Bind orders. The Excel QR-link supplement keeps
its row order (a new playlist, no seed).

## Featured playlist covers

`playlists.image` is a URL on the music service's CDN, stored once when the
row is created. When a playlist's owner replaces the cover, Spotify deletes the
old file and the stored URL answers 404. `/featured` (the playlist list) reads
that column, while the product page shows the cover from a live lookup, so the
symptom is a broken image in the list for a playlist whose product page looks
fine. `src/data/playlistCovers.ts` keeps the column honest in two ways:

- Every uncached lookup of a featured playlist in `spotify.getPlaylist` writes
  the live cover back when it differs and drops the featured list cache.
- A 03:30 cron on the main server (`repairFeaturedPlaylistCovers`, also the
  "Repair Playlist Covers" bulk action, `POST /admin/repair-playlist-covers`)
  sends a HEAD to every stored cover and re-fetches only the dead ones with
  `cache=false`. That flag matters: the cached lookup of a featured playlist
  never expires, so it can hold the same dead URL. A 5xx or a timeout counts
  as alive, so a CDN hiccup cannot trigger hundreds of Spotify calls.

Rows with a `customImage` are skipped, it wins everywhere. Only Spotify is
re-fetched; a dead cover on another service (Apple Music's signed artwork URLs
expire) is reported as unresolved and needs a custom image uploaded.

When the re-fetch says the playlist itself is gone (`playlistNotFound`), the
sweep unfeatures it, see the next section.

## Removing a featured playlist ("unfeature")

`featuredHidden` only drops a playlist from the list; its product page stays
up. For a playlist that no longer exists on Spotify that is the wrong tool, so
`unfeaturePlaylist` (`POST /admin/playlist/:playlistId/unfeature`, the trash
button on the Featured page, and the cover sweep above) sets `featured = false`,
which takes the list entry, the product page, the sitemap entry and, through
the Merchant Center cleanup pass, the Google product with it. It flushes the
playlist caches by id and slug (the product page lookup of a featured playlist
is cached forever) and rebuilds the sitemap, which otherwise only happens at
boot.

The row is never deleted: orders and tracks reference it. `unfeaturedAt` marks
it as deliberately removed rather than never featured, which is what keeps it
in the admin overview (badge "Removed", restore button →
`POST /admin/playlist/:playlistId/refeature`, which clears the stamp). The
`/admin/featured/search` query is `featured = true OR unfeaturedAt IS NOT NULL`
for that reason.

## Product page descriptions (SEO)

`description_<locale>` on a featured playlist is the product page's intro,
meta description, share text and Product/MusicPlaylist description, and the
Merchant Center/Channable description. It used to hold the customer's own
submission text translated as-is, or nothing (the frontend then fell back to
the raw Spotify description). `src/seoDescriptions.ts` replaces both:

- `generateForPlaylist` builds a brief from the stored tracks (count, year
  span, decade split, most frequent artists, an evenly spread sample of at
  most 120 "artist - title (year)" lines) plus the customer's text and the
  Spotify description as intent, has `AiTasks.writeSeoPlaylistDescription`
  write English copy whose first sentence is a standalone meta description,
  then `translateSeoDescription` localises it (playlist name and "QRSong!"
  untouched, "QR music cards" rendered as the market's search term). A
  locale the translator skips gets the English text, never nothing.
- `seoDescriptionGenerated` records that this has happened. Promotional
  approval (`promotional.acceptPromotionalPlaylist`) calls it after the
  name/slug update; if the writer fails the old translate-as-is path runs as
  a fallback and the flag stays false.
- The "SEO Descriptions" bulk action (`POST /admin/seo-descriptions/run`,
  polled through `GET /admin/seo-descriptions/status`) visits every featured
  row with the flag still false. It runs in the worker that took the request
  and keeps its status and a refreshed lock in Redis, so any worker can answer
  the poll and a dead worker frees the run within 15 minutes.
  `POST /admin/playlist/:playlistId/seo-description` rewrites one playlist
  regardless of the flag.
- **"Keep this description"** (`preserveDescription`, a switch in the Edit
  modal on the Featured page) is for a customer text that beats anything the
  writer makes of it (playlist 2650, "Symphony!", is the example). While it
  is on, approval and "Translate description" skip the writer:
  `AiTasks.translateLiterally` names the language `promotionalDescription` is
  written in and translates it word for word, and that locale gets the text
  itself. The bulk action skips the row; "Write SEO description" on it
  switches keeping off. The Edit form's description is always
  `promotionalDescription`, so saving it never touches the page copy of a
  kept row, and otherwise only when the text was actually changed (a new
  name or slug used to put the raw customer text over the English SEO copy).

## Product page locale, cover and design

- `featuredLocale` (null, `"de"` or a list like `"de,nl"`) decides where a
  product page is **indexable**, never where it renders.
  `data/productPageLocales.ts` is the one rule: an international list is
  indexable everywhere, a market-specific one in its own locales plus always
  `en`. The sitemap lists it in those locales only (and leaves out
  promotional submissions that are not approved yet), and
  `GET /product-page/:slug` gives the SSR server the same list, which narrows
  the hreflang cluster to it and sends `X-Robots-Tag: noindex, follow` on the
  other locales. **Do not redirect those locales.** That was tried: a German
  visitor browsing the English site opens German lists from `/en/playlists`
  (that page filters by country, not by UI language), and a 301 to `/de/`
  switched the whole site's language under them. Changing the locale
  (`updateFeaturedLocale`, `updatePromotionalPlaylist`) drops the gate cache
  and rebuilds the sitemap.
- `playlists.design` is the card design of whoever first ordered the
  playlist (checkout sends it along, `data/playlists.ts` stores it on
  creation). Once that playlist is featured, its product page shows every
  visitor that design, which can carry personal photos or messages.
  Two columns gate it, and `productPageDesign()` (`data/productPageDesign.ts`)
  is where `spotify.getPlaylist` combines them into `design` or `null`:
  - `promotionalShareDesign` is the customer's answer on the featured
    playlist form (own design is preselected; the API only shares on an
    explicit `true`). The form previews both options from the design and a
    sample track that `getPromotionalSetup` returns to the verified owner.
    Defaults to true so curated lists and older submissions keep what they
    show today.
  - `featuredDesignHidden` is the admin's veto, the "Own design" switch on
    the Featured page (`POST /admin/playlist/:playlistId/design-hidden`),
    which draws each row's front and back from the design the search
    returns. A column of its own, because `savePromotionalSetup` writes the
    customer's answer on every save and would switch a vetoed design back
    on; an admin also cannot show a design the customer kept private.
  The design is never deleted.
- `GET /product-cover/:slug.jpg` (`src/playlistArtwork.ts`) serves a 640x640
  JPEG of the cover from our own domain, built from the admin upload or the
  live Spotify file and cached under `public/product_covers/` keyed on the
  source URL. The frontend uses it for the deck, og:image, twitter:image and
  Product.image, because Spotify deletes the old file when an owner changes
  the cover and that used to break the cached rich result and every earlier
  share. (The playlist suggestions brochure shared the loader and its SSRF
  guards for its thumbnails until it was removed on 2026-10-16.)

## Customer reviews: a committed JSON file

`src/reviews.ts` serves `/reviews/:locale/:amount/:landingPage` and
`/reviews_details` from `src/_data/reviews/reviews.json`. It only reads. The
file is written by the growth-oracle `reviews` pillar, run from the frontend
repo (`npm run growth -- reviews fetch`), and holds every Trustpilot, App Store
and Google Play review in its original language plus all site locales, with each
platform's score. See the frontend's CLAUDE.md for the workflow.

This replaced a RapidAPI Trustpilot reseller that was called when the API
booted and a ChatGPT pass that translated the results in batches of five with a
pause in between, which is what made startup take minutes. Nothing review
related runs at boot or on a cron any more. `RAPID_API_KEY` is still needed: the
Spotify RapidAPI clients and scraper (`spotify_rapidapi*.ts`, `spotify_scraper.ts`)
use it. The year lookup's Google and Wikipedia searches went through RapidAPI
too until 2026-10-12; they now go to Serper and Wikipedia directly (see
"Release-year lookup" under the LLM layer).

- Like the blog, the file reaches production through `ncp ./src ./build` at the
  end of `npm run build`, and `CONTENT_FILES` in `reviews.ts` has the same
  `tsc -w` fallback as the blog's `CONTENT_DIRS`.
- The parsed file is held in memory and its mtime re-checked at most once a
  minute, so a `growth reviews fetch` under a running dev API shows up without a
  restart. There is no Redis layer to flush.
- Filtering lives here, not in the frontend: hidden reviews never leave the
  API, app store reviews are only returned with `?apps=1` and only at 4 stars
  and up.
- The `trustpilot` table (`TrustPilot` model) is left in place and unread, so
  rolling back is a deploy.

## Product feeds: Merchant Center and Channable

Two modules publish the same catalogue:

- `src/merchantcenter.ts` pushes products straight into Google via the Merchant
  API, and generates the AI product images (1 AM cron). Its 4 AM sync cron was
  switched off on 2026-10-19 at Rick's request; the push now only runs from
  `POST /admin/merchant-center/upload-featured`.
- `src/channable.ts` writes a CSV feed for Channable to import (5 AM cron).
  This is how products reach Merchant Center now.

The agency running the Merchant Center asked for the feed to go through
Channable first. The 1 AM image cron stays on: the Channable feed reads its
images (see below).

**Channable has no API to push products into.** Its API only covers orders,
offers, returns and shipments — `POST .../offers` can update stock and price on
offers that already exist, but cannot create them. Projects and imports are
web-app only. Product data enters exclusively through an import, so we host a
CSV and Channable fetches it about once a day:

```
https://api.qrsong.io/channable/feed.csv?token=<CHANNABLE_FEED_TOKEN>
        # add &country=DE for a single market's slice
```

`CHANNABLE_FEED_TOKEN` is the only new env var; a wrong or missing token 404s.
`npx tsx test-channable.ts` builds the feed locally and prints a summary, and
`POST /admin/channable/generate-feed` rebuilds it on demand.

Anything both feeds have to agree on — the locale/country markets, the
"localised + international" gating, product ids, PMax custom labels, shipping
tiers — lives in `src/productFeed.ts` so the two cannot drift apart. Put new
shared logic there rather than in either module.

Two things `channable.ts` deliberately does NOT do:

- It never touches `markedForMerchantCenter`. That flag is written by
  `promotional.ts` / `adminRoutes.ts` and cleared only by the Google sync; a
  second consumer would race with it. A feed is a full snapshot anyway.
- It never generates product images, only reads what `merchantcenter.ts` has
  already written under `public/products/`. **When `merchantcenter.ts` is
  retired, its image-generation half has to move into `channable.ts` or a
  shared module, or the feed will slowly lose images.**

## Mollie payment methods: pay later, Riverty and the dead ones

Which methods a customer sees comes from `src/data/shared/markets.json` (per
country, checkout order) filtered by `currencies.json` (what each currency
takes), in `resolveMollieMethods`. Mollie then silently hides any method in
that list whose requirements the payment does not meet. Reworked on
2026-10-24 after two years of 0 Klarna and in3 payments.

- **Klarna and in3 only show with order lines and a billing address.**
  Without them Klarna answers 422 "A billing address is required"
  when asked alone and is left out without a word in a method list.
  `payLaterDetails` (`src/services/pay-later.ts`) builds both from the cart
  and `/order/calculate`'s sums: a line per playlist (products split
  proportionally, they absorb the currency snap), the gift box, QRGames, App
  Designer, shipping and the discount at the goods' and the shipping's VAT
  rate, in minor units so the lines add up to the charged amount exactly.
  It gives nothing (and the payment goes out as before) for a cart with a
  gift card, an order without a complete postal address (every digital
  order), a one-word name or no e-mail, or when the products would have to
  absorb more than rounding. A 4xx on the create with lines creates the
  payment again without them, and an error while building them sends it
  without them: pay later must never cost a sale. Both go to PostHog, since
  a refusal on every payment would hide pay later again without a sound.
- **Riverty is not offered, although it is activated.** Mollie only takes it
  on a held payment (`captureMode: manual`, 422 otherwise, and in a method
  list it is just left out), and a held payment holds every method in it
  that can be held: cards, Apple Pay, Klarna and PayPal are then only
  `authorized`, and the order waits for our capture. With Riverty in the
  NL/BE/DE/AT lists that is every physical order there. It was built on
  2026-10-24 (787dbb9a: capture in the webhook, a nightly backstop) and
  worked in test mode, and taken out on 2026-10-25 at Rick's request: a
  missed capture leaves the money untaken until the hold lapses (Visa 7
  days), card and Apple Pay could not be tried in test mode, and Mollie
  calls manual capture for PayPal beta. Klarna and in3 cover pay later
  there. Adding `riverty` to a market's list changes nothing (Mollie drops
  it from an unheld payment); bringing it back means that commit.
- **The claim never moves a paid row back** (`processWebhook`): a webhook
  still holding an earlier status, handled next to the paid one, would
  otherwise write it over `paid`, and the order job checks the stored status.
- **Not offered, on purpose:** SEPA direct debit (rejected for the account),
  Trustly (withdrawn by Mollie, last payment 2026-04-24), paysafecard (off in
  the website profile), Vipps and MobilePay (need a Norwegian or Danish /
  Finnish business), Bizum (needs a Spanish bank). `GET /v2/methods/all`
  shows the account's state per method.
- **Local currency unlocks the local method.** BLIK only takes PLN and TWINT
  only CHF, so visitors in Poland pay in PLN (the market's currency) and a
  Swiss visitor on `/de`, `/fr` or `/it` in francs (`getCurrencyForPage` in
  the site's `currency-map.ts`: a euro page gives way to a country that reads
  its language, a language pinned to its own currency keeps it everywhere,
  so Googlebot from the US still sees euros on `/de`). **A currency decides
  methods**, since most local ones are EUR-only: a PLN pin on `/pl` took
  iDEAL, Bancontact and EPS from Poles living in NL, BE and AT, and the
  country rule applied to `/sv` took Swish from Swedes in Norway, so `/pl` has
  no pin and non-euro pins stay put (both caught by an old-against-new
  checkout comparison in Mollie test mode, 2026-10-25, before any deploy).
- Pay by Bank is in `notOnBadges`: the homepage strip leaves it out (no
  brand anyone looks for).

## Error tracking (PostHog)

API errors go to the same PostHog project as the site's
(`src/errorTracking.ts`, `posthog-node`). Every exception carries
`app: 'backend'` (the site sends `app: 'frontend'`) and `service: 'api'` or
`'worker'`. **Production only** (`ENVIRONMENT=production`): development and
tests never send anything, and no credentials are needed, the project key is
public.

Sentry was removed because 100% tracing and profiling pegged the cluster
primary (`dded4cec`), so nothing here instruments anything. Errors are captured
in four places:

- **Crashes.** An `uncaughtException` handler reports, prints, flushes (3s) and
  exits 1, which is what Node did without one; pm2 restarts as before.
  Unhandled rejections arrive there too (Node's default `throw` mode). Do not
  add an `unhandledRejection` listener: that would stop them from crashing.
- **`console.error(…, error)`.** Most failures are caught where they happen
  (hundreds of catch blocks that log and answer 500), so `console.error` is
  wrapped: any call handed an Error reports it, with the text logged next to
  it as `log_message`. String-only logs and the custom `Logger` are not
  reported.
- **The Fastify error handler**, except errors with a 4xx `statusCode`. It
  sends the route pattern, never the URL: paths carry ids and download hashes.
- **Queue jobs**: failed jobs (`worker.on('failed')`, the generator's catch
  with its `payment_id`) and queue worker errors.

Each error is sent once (`ignore()` marks one that is logged but not worth
reporting) and at most 10 of one kind per minute, 100 in total, because
posthog-node's own rate limiter does not cover `captureException`. Frames point
at the compiled `build/src/*.js` (no source maps; tsc output is readable).

## Key Security Considerations
- **Input validation** on all endpoints
- **SQL injection protection** via Prisma ORM
- **CSRF protection** with proper headers
- **Rate limiting** and IP tracking
- **Secure file uploads** with size limits
- **Environment-based security** (development vs production)

## Scrape protection on the qrlink endpoints

`src/abuse_guard.ts` guards `/qrlink/:trackId` and `/qrlink2/:trackId/:php`,
the only public endpoints that turn an enumerable id into the data a
competitor wants. It exists because one competitor scraped them twice: first
in May 2026 at ~20 req/s announcing itself as `Hitify-QRSong-Sync`, then in
September 2026 with that user-agent layer defeated, at ~1 req/s behind a
spoofed Chrome string, walking track ids upwards one at a time.

Four layers, in order, all env-tunable:

| layer | default | env |
|---|---|---|
| whitelist, skips everything below | the `allowed_ips` table | admin UI |
| permanent denylist | empty | `QRLINK_DENY_IPS` |
| decoy (wrong track, not a block) | `2a06:98c0:3600::103` | `QRLINK_DECOY_IPS` |
| scraper user-agents | `Hitify-QRSong-Sync` | `QRLINK_BLOCKED_USER_AGENTS` |
| rate limit | 30 per 60s | `QRLINK_RATE_MAX`, `QRLINK_RATE_WINDOW_SECONDS` |
| sequential track ids | 25 ascending, steps of ≤5, inside 60s | `QRLINK_SEQ_STREAK`, `QRLINK_SEQ_MAX_STEP`, `QRLINK_SEQ_MAX_SECONDS`, `QRLINK_SEQ_WINDOW_SECONDS` |

A ban lasts 7 days (`QRLINK_BAN_SECONDS`) and is enforced on **every** API
route by `ipPlugin`, not just these two, minus the checkout paths in
`BAN_EXEMPT_PATHS`.

Things here that cost something to learn:

- **`2a06:98c0:3600::103` is Cloudflare's shared Workers egress**, and it gets
  a decoy rather than a block. Every Worker on the platform makes its outbound
  `fetch` from that one address, so it is what renting Workers to proxy a
  scrape looks like. We are behind CloudFront, not Cloudflare, so no customer
  scan, app request or SSR render can come from it, and it is fixed platform
  infrastructure the scraper cannot rotate off without leaving the platform.
- **A decoy beats a 403.** A block tells a scraper it has been spotted and it
  comes back adapted, which this one already did once after the user-agent
  layer caught it. A decoyed caller gets Rick Astley's "Never Gonna Give You
  Up" on every service instead of the track they asked for (`DECOY_LINKS` in
  `musicRoutes.ts`). Every link there was resolved through our own MusicFetch
  pipeline from the Spotify URL, so the id formats match a genuinely enriched
  track; `yt` is a bare video id because that is what the column stores, and a
  full URL there would give the game away. **A decoyed caller is never banned**
  (2026-10-24, Rick: let it ingest all the decoys). The routes serve the decoy
  before the guard runs, `check()` skips the detectors for it, `ban()` ignores
  it, and `isBanned()` lets it through even while Redis still holds a ban for
  it. Before this the detectors ran for it too, and the sequential-id check
  banned it after 25 ascending ids, after which `ipPlugin` answered it 403 and
  the decoys stopped. The permanent denylist still beats a decoy. The serve is
  logged at most once a minute per address, since the whole point is that the
  caller keeps going; the Blocked IPs page no longer shows it.
- **Sequential-id detection is what catches a patient scraper.** A rate limit
  alone is a speed limit: 29 requests a minute is invisible forever and still
  drains the database. The detector is safe because `Track.trackId` is unique,
  so a playlist reuses the existing row for any track already known and a real
  deck holds ids scattered across the whole range. The exception is a playlist
  of entirely unknown tracks, which gets one contiguous block; that customer
  scanning their deck in printed order used to be the one false positive. So
  since 2026-09-29 a run has to be long (25) **and** faster than anyone scans
  cards: the last 25 ascending ids inside 60 seconds, a card every 2.4 s while
  each scan plays a song. The September scraper did ~1 req/s. The window
  slides (the Redis value keeps the run's last 25 request times), so a run
  that starts slowly and then speeds up is still caught. The price: a scraper
  slower than one id per ~2.5 s now gets through this layer (and the 30/min
  rate limit), which at that pace is still ~35,000 ids a day. If one shows
  up, lower `QRLINK_SEQ_STREAK` or raise `QRLINK_SEQ_MAX_SECONDS` in `.env`;
  the whitelist remains the answer for a customer caught anyway.
- **A failed Redis write used to un-ban silently.** `ban()` writes the mirror
  first and persists after; `refreshBannedIps()` rebuilds the mirror from
  Redis wholesale every 20s. A failed `zadd` therefore vanished within 20
  seconds with only a yellow warning. `pendingBans` now survives the refresh
  and retries the write. The refresh also keeps bans added while it was
  reading Redis, which needs a **copy** of the mirror's keys: holding the map
  itself makes every new ban look pre-existing, since `ban()` mutates it.
- **Both detectors fail open** when Redis is unreachable, deliberately, so a
  cache outage never breaks real card scans. It also means a degraded Redis
  turns the protection off; `AbuseGuard check failed` in the log is how you
  find that.
- **The block is logged once per address**, not per refused request, because a
  blocked scraper keeps hammering. `ban()` logs when the ban is created,
  `logBlockedOnce` when requests start being refused.
- Blocks are recorded in `blocked_ips` for the dashboard (Data → Blocked IPs),
  written by the worker that issued the ban, which is the only one that knows
  why. Other workers only learn the address is banned, so leaving it to them
  would add a vaguer duplicate row each. Each row keeps the `trackId` they had
  reached and, when the request carried one, the `php`, which is resolved to
  the order, playlist and customer on read. `/qrlink2` carries a `php`, the
  legacy `/qrlink` does not.
- **Unblocking must clear both counters**, not just the ban: an address let
  back in on a counter that is already over the limit, or mid-run, is banned
  again on its next request.
- The whitelist (`allowed_ips`) beats every other layer including the
  denylist, is mirrored into each worker within `QRLINK_BAN_REFRESH_SECONDS`,
  and survives a restart. `QRLINK_DENY_IPS` is config and needs a deploy to
  change, which is why the dashboard refuses to unblock a denylisted address
  and says so instead.

## Spotify quota protection on the playlist endpoints

`src/plugins/playlistGuardPlugin.ts` guards `/<service>/playlists` and
`/<service>/playlists/tracks` (all six services). These load a playlist from
the service itself, and a client loading playlists in bulk can get our Spotify
access rate limited for 24 hours. It is separate from AbuseGuard: it refuses
or downgrades requests and bans nobody.

- **Forbidden user agents** (`FORBIDDEN_PLAYLIST_USER_AGENTS`,
  case-insensitive substrings, so `okhttp` covers every version) get a 403 on
  these routes only, logged once per IP per worker. `okhttp` went on the list
  on 2026-10-01 after one IP loaded ~50 playlists in two minutes, up to seven
  at a time. The QRSong app sends its WebView's agent, never okhttp. **Never
  add `node`**: our own SSR server loads playlists with it.
- **A missing `cache` flag used to skip the cache.** The routes read it with
  `parseBoolean`, which turns `undefined` into `false`, so any client that
  left it out forced a fresh fetch of the playlist and its tracks. The guard
  now sets a missing flag to 1 (the frontend always sends it). An explicit
  reload (`cache: 0`: the summary step's refresh and every language switch)
  is honoured 20 times per IP per hour (`playlist_reload:<ip>` in Redis) and
  then quietly served from the cache, logged once per IP per window. It fails
  open when Redis is down. A playlist that is not cached yet is always fetched.
- **"Require reCAPTCHA for playlists"** (dashboard, Bulk actions → Abuse
  protection; setting `captcha_required`, off by default, added 2026-10-08)
  is for when someone loads playlists in bulk. While it is on, a request
  without a solved reCAPTCHA gets 403 `captchaRequired`; the site's
  `captcha-retry.interceptor.ts` then solves an invisible reCAPTCHA v3 and
  sends `captchaToken` along, once. A solved one covers the address for 30
  minutes (`playlist_captcha_ok:<ip>`). Featured playlists (which our SSR
  also loads) and `TRUSTED_IPS` are exempt, and the check is skipped when
  the setting cannot be read. The site loads Google's script only when asked.

## Common Development Tasks
- Adding new routes: Add to appropriate route file in `src/routes/` directory
  - Account/auth routes → `accountRoutes.ts`
  - Admin functionality → `adminRoutes.ts`
  - Company/business features → `companyRoutes.ts` (`/business/*`)
  - Music/Spotify features → `musicRoutes.ts`
  - Payment/order processing → `paymentRoutes.ts`
  - Public/general routes → `publicRoutes.ts`
- Database changes: Modify `prisma/schema.prisma` and run `npx prisma db push`
- Adding new services: Create singleton class following existing patterns
- Email templates: Add EJS templates in `src/templates/`
- Static assets: Place in `public/` directory
- New translations: Add to `src/locales/` JSON files

## Route Organization
The server routes have been refactored into logical modules for better maintainability:
- **Modular structure**: Routes are organized by feature/domain
- **Reusable auth middleware**: Common authentication logic shared across route modules
- **Clear separation of concerns**: Each route file handles a specific business domain
- **Consistent patterns**: All route modules follow the same structure and conventions

## API Integration Points
- **Spotify Web API** - Primary music data source
- **Mollie API** - Payment processing
- **Print API** - Physical card production
- **AWS APIs** - Email, storage, compute
- **OpenAI API** - AI-powered features

## Related Projects

### Frontend Applications

#### QRSong! Main Application
- **Location**: `/users/rick/sites/qrhit` (Angular 18 frontend)
- **CLAUDE.md**: `/users/rick/sites/qrhit/CLAUDE.md`
- **Description**: Angular 18 application with SSR, multi-language support (12 languages), and Spotify integration
- **Purpose**: Public-facing QR code generation service for Spotify playlists
- **Development Server**: `npm start` (localhost:4200)
- **Build Command**: `npm run build` (builds into `dist/qrhit-build` and publishes into `dist/qrhit`; `deploy_frontend` then restarts and runs `npm run invalidate-cloudfront`, see "Deploys" in the frontend's CLAUDE.md)

The business platform (companies, company lists, voting, quotations,
calculators, invoices, quote requests, company files) is `src/business.ts`
(class `Business`) behind `/business/*` (`src/routes/companyRoutes.ts` and
`src/routes/businessRoutes.ts`); the frontend's admin dashboard and the
qquote, boxd and qrsong toolkits call it. Until 2026-10-07 the file was
`vibe.ts` and the prefix `/vibe/`, after the OnzeVibe brand, which is gone
with everything only it used: its portal and self sign-up
(`/vibe/companylist/create`), its order generation (`/vibe/generate`, orders
flagged `payments.vibe`), the HappiBox calculator and quotation, the poster
and countdown views, the portal welcome mails and the `vibeadmin` group.

The voting page lives on the site since 2026-10-06: `https://www.qrsong.io/v/<slug>`
(`/:lang/v/:slug`, see "Voting page" in the frontend's CLAUDE.md), on the
`/hitlist/*` routes. Every link the API builds to it uses `FRONTEND_URI`
(the verification mail, `/:lang/v/:slug/verify/:hash`, always QRSong!-branded).
`FRONTEND_VOTING_URI` is read by nothing any more.

- **The list cache is per visitor**: `companyListByDomain:<slug>:<hash>`
  (`Hitlist.getCompanyListByDomain`, 24 hours). `Business.clearCompanyListCache`
  deletes the pattern; until 2026-10-06 it deleted the key without a hash,
  which matched nothing, so a returning voter saw a changed list up to a day
  late. `/business/companies/:id/lists/:id/info` clears it too now.
- `processAndSaveImage` keeps only `.png .jpg .jpeg .webp .gif`: the file
  lands in the public folder as uploaded.

### Frontend-Backend Integration
The frontend consumes this API through the following key endpoints:

#### Authentication & User Management
- **POST** `/validate` - JWT token validation
- **POST** `/api/account/customer-register-request`, `customer-verify-pincode`, `customer-set-password` - Customer sign-up by pincode
- **POST** `/api/account/forgot-password-request` - Password reset by pincode

#### Spotify & Music Features
- **GET** `/spotify/auth` - Spotify OAuth initiation
- **POST** `/spotify/callback` - OAuth callback handling
- **GET** `/spotify/playlists` - User playlist retrieval
- **POST** `/generate/:paymentId` - QR code generation

#### Payment & Order Processing
- **POST** `/mollie/payment` - Payment creation
- **POST** `/mollie/check` - Payment status verification
- **GET** `/progress/:playlistId/:paymentId` - Order progress tracking
- **GET** `/download/:paymentId/:userHash/:playlistId/:type` - File downloads

#### Public Endpoints
- **POST** `/contact` - Contact form submissions
- **GET** `/reviews/:locale/:amount/:landingPage` - Customer reviews

#### Company/Business Features
- **GET** `/business/companies` - List available companies for admin management
- **GET** `/company-lists/:companyId` - Get company voting lists
- **GET** `/list/:listId` - Get individual list details with submissions
- **POST** `/business/submit` - Submit track suggestions to company voting lists
- **GET** `/business/submissions/:companyId` - Get company submission data
- **GET/PUT** `/business/default-playlists`, **DELETE** `/:id`, **POST** `/pdf` - The default playlists and their brochure (see "Default playlists")

### Development Workflow
1. **Frontend Development**: Use Angular dev server (port 4200)
2. **Backend Development**: Use `npm run start:dev` (port 3004)
3. **Full Stack Testing**: Both servers running simultaneously
4. **API Testing**: Frontend makes requests to localhost:3004
5. **Production**: Frontend builds to static files, backend serves API
## Testing

See [TESTING.md](TESTING.md) for the full guide. Quick reference:
- `npm run test:unit` (fast) · `npm test` (full) · `npm run test:coverage` (+thresholds)
- After schema changes: `npm run test:db:push`
- Integration tests: `buildTestApp()` + helpers in `test/helpers/` — never hit dev/prod DB (harness rewrites DATABASE_URL to qrhit_test)
- Mail/pushover/push/printer are globally mocked; assert via `outbound.calls()`
- When you change or add backend logic, add/update the matching tests (or run `/write-tests`)
- Coverage thresholds in vitest.config.mts only ever go up
