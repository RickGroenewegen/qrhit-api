# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development Commands
- `npm run start:dev` - Start development server with TypeScript watch mode and nodemon
- `npm run start:dev2` - Alternative development server using tsx watch
- `npm run build` - Build TypeScript to JavaScript (outputs to ./build)
- `npm run start` - Start the production server; builds first only when `./build` is stale (see "Startup and deploys")
- `npm run test` - Run tests (builds first, then runs test.js)

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
   - Removes translation keys from translated.cache files (src/locales, build/locales, assets/i18n)
   - Usage: `./_scripts/remove-from-cache.sh key1 key2 key3 ...`
   - Example: `./_scripts/remove-from-cache.sh mail.promotionalCtaSubtitle mail.promotionalSaleSubject`
   - Use this after modifying translation keys in en.json to ensure translations are regenerated

2. **rebuild-locales.sh**
   - Rebuilds the API to update locale files in the build folder
   - Usage: `./_scripts/rebuild-locales.sh [key1 key2 ...]`
   - Keys are optional and just logged for documentation purposes

### Translation Files
- Translations are stored in `src/locales/*.json` (en.json, nl.json, de.json, etc.)
- Translation cache files exist at: `src/locales/translated.cache`, `build/locales/translated.cache`, `assets/i18n/translated.cache`
- After modifying translation keys, run `remove-from-cache.sh` with the changed keys to ensure they get regenerated
- `translate.js` runs both bundles; `node translate.js business` limits it to one

### Business document copy (`src/locales/business/`)

Quotations, technical instruction PDFs and MoneyBird invoice lines are B2B
correspondence and must read as **formal** (German `Sie`, Dutch `u`). The main
`src/locales/*.json` bundle is deliberately informal (`translate.js` prompts for
German `du`), so that copy must never be reused for these documents. They read
from a separate bundle instead:

- `src/locales/business/{en,nl,de}.json` — flat dotted keys under the
  `quotation.*`, `instructions.*`, `invoice_lines.*`, `pricing.*` and
  `suggestions.*` prefixes (`pricing.*` covers the retail/reseller price lists
  and the brochure partials `front_page`, `product_info` and `closing_page`
  they share; `suggestions.*` is the playlist suggestions brochure, which
  reuses those partials through a translator that falls back to `pricing.*`
  for any key it does not define itself).
- Only these three languages are produced. `Translation.resolveBusinessLocale()`
  is the single fallback point: any other `Company.locale` becomes `en`. Missing
  keys fall back to the English string, never to `undefined`.
- `nl.json` is the original hand-written Dutch (it is the source these documents
  were written in) and `de.json` is hand-written German. Both are pre-seeded in
  `src/locales/business/translated.cache`, so `translate.js` will not overwrite
  them; only newly added keys get generated, using the bundle's formal prompt.
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
  uses `https://www.printenbind.nl/api/rest`. The live token also works on
  the REST endpoint.
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
  a year earlier. Older ones are now closed without a mail or a TrackingMore
  shipment.

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
- **OpenAI/ChatGPT** - AI-powered features
- **Trustpilot** - Customer reviews

#### 4. Business Logic Modules
- **Music Processing** (`src/music.ts`, `src/spotify.ts`) - Spotify integration, track management
- **Order Management** (`src/order.ts`, `src/mollie.ts`) - Payment processing, order fulfillment
- **QR Code Generation** (`src/qr.ts`) - QR code creation for tracks
- **PDF Generation** (`src/pdf.ts`, `src/generator.ts`) - Document generation for physical orders
- **Email System** (`src/mail.ts`) - Transactional and marketing emails
- **Analytics** (`src/analytics.ts`) - Usage tracking and reporting

#### 5. User Features
- **Authentication System** - JWT-based with multiple user roles (admin, vibeadmin, companyadmin, users)
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
- **Multi-source year detection** - Spotify, MusicBrainz, Discogs, OpenAI
- **YouTube link association** - Automatic YouTube link finding
- **Manual verification system** - Admin interface for data quality

### Important Technical Details

#### Authentication & Authorization
- **JWT tokens** with role-based access control
- **User groups**: admin, vibeadmin, companyadmin, users
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
  - `vibeRoutes.ts` - Company/business voting portal routes
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

## OpenAI models and structured output

Every OpenAI model name lives in `src/llmModels.ts` (sol / terra / luna text
tiers, the image model, the TTS model); prices per 1M tokens are in
`src/aiPricing.ts`. Bump the constants there, nowhere else. The root
`translate.js` scripts in each repo are the exception: they are standalone and
name the model inline.

The GPT-5.6 family changed two Chat Completions rules, verified against the
live API on 2026-09-16:

- `temperature` other than 1 returns 400 unless `reasoning_effort: 'none'`.
- Function tools (`tools` / legacy `functions`) return 400 whenever reasoning
  is on. OpenAI's answer is the Responses API; ours is
  `response_format: { type: 'json_schema' }`, which works with every
  reasoning level. Structured calls read `message.content` and parse it.
- `max_tokens` is rejected; use `max_completion_tokens`.

Pick `reasoning_effort` per call, not globally: `'none'` for translation,
classification and copy (fast, allows a temperature), `'low'` where the answer
has to be right (release years, quiz alternatives, order extraction),
`'medium'` for year audits, trivia facts and blog generation.

The AI playlist generator (`aiPlaylist.ts`) is the exception to "structured
work runs on terra": it uses luna with reasoning `'none'`, because a customer
watches a progress bar while it runs and the curation batches are sequential.
Measured on 2026-09-17, terra + `'low'` took 26s for the keyword call and 6.5s
per 100-candidate batch against 10s and 1.5s for luna + `'none'`, with the same
tracks picked. Most of the gap is terra's token speed, not the reasoning.
`chat.ts` and `mail.ts` still use legacy `functions` on the luna tier with
reasoning off, which the API accepts.

## Testing
- Basic test setup in `test.js`
- Run tests with `npm test`
- Tests require build step before execution

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

## Scan-app themes and the App Designer

The scan app (`qrhit-app`) themes itself from `GET /theme/:slug`: a ThemeConfig
with ~45 `--app-*` CSS variables, flags, a font block, help text and asset
URLs. `GET /qrlink2/:trackId/:php` tells it which slug a scanned card uses
(`t: {s, n}`), from the in-memory `php id → slug` map in `src/apptheme.ts`.
**All of this works with the released app; nothing here needs an app update.**

Two sources, same file layout (`<slug>/<slug>.json` + optional `logo.png` /
`background.png`), tried in this order by `src/routes/themeRoutes.ts`, which
adds `source: 'business' | 'customer'` to the response:

1. Hand-made B2B themes: `src/_data/themes/<slug>/`, in git, assigned per
   order line by an admin (`payment_has_playlist.theme`).
2. Customer designs (App Designer): `PUBLIC_DIR/customer-themes/<slug>/`,
   written by `src/appDesign.ts` on every save (atomically: temp file, then
   rename). The DB row in `app_designs` keeps what the file cannot: owner,
   scope, the editor state and the version.

**App Designer is an upgrade on the account.** `APP_DESIGN_PRICE` in
`src/config/constants.ts` is the only place the amount is written. A paid
`app_design_upgrade` webhook writes one `app_design_purchases` row, which is
both the entitlement and the ledger entry the financial reports read (gross,
ex-VAT and VAT stored, plus what Mollie charged in the customer's currency).
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
`helpText` is HTML from the site's Quill editor; `sanitizeHelpText` keeps
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

## Upgrade invoices (the U range)

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
  Spotify description as intent, has `ChatGPT.writeSeoPlaylistDescription`
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
  `promotionalShareDesign` gates it: `spotify.getPlaylist` returns
  `design: null` when it is false. The customer chooses on the featured
  playlist form (own design is preselected; the API only shares on an
  explicit `true`), the form previews both options from the design and a
  sample track that `getPromotionalSetup` returns to the verified owner, and
  an admin can flip it per row on the Featured page
  (`POST /admin/playlist/:playlistId/share-design`). The design is never
  deleted. The column defaults to true so curated lists and older
  submissions keep what they show today.
- `GET /product-cover/:slug.jpg` (`src/playlistArtwork.ts`) serves a 640x640
  JPEG of the cover from our own domain, built from the admin upload or the
  live Spotify file and cached under `public/product_covers/` keyed on the
  source URL. The frontend uses it for the deck, og:image, twitter:image and
  Product.image, because Spotify deletes the old file when an owner changes
  the cover and that used to break the cached rich result and every earlier
  share. The brochure thumbnails in `playlistSuggestions.ts` share the
  loader and its SSRF guards.

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
Spotify scrapers, `music.ts` and `data/musicLinks.ts` use it.

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

Two modules publish the same catalogue and currently run side by side:

- `src/merchantcenter.ts` pushes products straight into Google via the Merchant
  API (4 AM cron), and generates the AI product images (1 AM cron).
- `src/channable.ts` writes a CSV feed for Channable to import (5 AM cron).

The agency running the Merchant Center asked for the feed to go through
Channable first; once they have Channable wired to Merchant Center, the Google
push can be retired.

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
| sequential track ids | a run of 10, steps of ≤5, within an hour | `QRLINK_SEQ_STREAK`, `QRLINK_SEQ_MAX_STEP`, `QRLINK_SEQ_WINDOW_SECONDS` |

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
  full URL there would give the game away. The detectors still run for a
  decoyed caller, so the rate limit, the sequential-id check and the dashboard
  record all still happen, and the decoy is served in place of the verdict.
  The serve is logged at most once a minute per address, since the whole point
  is that the caller keeps going.
- **Sequential-id detection is what catches a patient scraper.** A rate limit
  alone is a speed limit: 29 requests a minute is invisible forever and still
  drains the database. The detector is safe because `Track.trackId` is unique,
  so a playlist reuses the existing row for any track already known and a real
  deck holds ids scattered across the whole range. The exception is a playlist
  of entirely unknown tracks, which gets one contiguous block; that customer
  scanning their deck in printed order is the one false positive, and the
  whitelist is the answer to it.
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

## Common Development Tasks
- Adding new routes: Add to appropriate route file in `src/routes/` directory
  - Account/auth routes → `accountRoutes.ts`
  - Admin functionality → `adminRoutes.ts`
  - Company/business features → `vibeRoutes.ts`
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

#### OnzeVibe Company Portal
- **Location**: `/users/rick/sites/qrhit-vibe` (Angular 19 portal)
- **CLAUDE.md**: `/users/rick/sites/qrhit-vibe/CLAUDE.md`
- **Description**: Angular 19.2.10 portal for OnzeVibe that connects to this QRSong! API
- **Purpose**: Company playlist management and voting system where users can create lists, submit songs, and vote on tracks
- **Development Server**: `npm start` (localhost:4200)
- **Production Server**: `npm run start:prod` (localhost:5000)
- **Build Command**: `npm run build` (includes CloudFront invalidation)

### Frontend-Backend Integration
Both Angular frontends consume this API through the following key endpoints:

#### Authentication & User Management
- **POST** `/validate` - JWT token validation
- **POST** `/account/register` - User registration
- **POST** `/account/verify` - Email verification
- **POST** `/account/reset-password-request` - Password reset

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
- **POST** `/newsletter_subscribe` - Newsletter subscriptions
- **GET** `/reviews/:locale/:amount/:landingPage` - Customer reviews

#### Company/Business Features (OnzeVibe Portal)
- **GET** `/vibe/companies` - List available companies for admin management
- **GET** `/company-lists/:companyId` - Get company voting lists
- **GET** `/list/:listId` - Get individual list details with submissions
- **POST** `/vibe/submit` - Submit track suggestions to company voting lists
- **GET** `/vibe/submissions/:companyId` - Get company submission data
- **PUT** `/account/voting-portal/:id` - Update voting portal settings
- **DELETE** `/account/voting-portal/:id` - Delete voting portals

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
- Coverage thresholds in vitest.config.ts only ever go up
