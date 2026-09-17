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
has to be right (release years, quiz alternatives, order extraction, playlist
curation), `'medium'` for year audits, trivia facts and blog generation.
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
used to (Sentry, `Server.init()`). Workers therefore load in parallel with the
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

## Key Security Considerations
- **Input validation** on all endpoints
- **SQL injection protection** via Prisma ORM
- **CSRF protection** with proper headers
- **Rate limiting** and IP tracking
- **Secure file uploads** with size limits
- **Environment-based security** (development vs production)

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
- **Build Command**: `npm run build` (includes CloudFront invalidation)

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
