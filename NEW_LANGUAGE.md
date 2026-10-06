# Adding a language (and a country or a currency)

What it takes to add a language to QRSong!: the website (`/Users/rick/Sites/qrhit`),
this API, and the scan app (`/Users/rick/Sites/qrhit-app`). Written while adding
Danish (`da`) and Hungarian (`hu`) with the forint in October 2026, after which
the language, country and currency tables of all three repos were folded into
one source.

Use the 2-letter ISO 639-1 code unless the site already spells the language
otherwise: `jp` (Japanese), `cn` (Chinese) and `no` (Norwegian) are route
codes, not language tags; `htmlLang` maps them to `ja`, `zh` and `nb`, and
`aliases` to what browsers and devices send (`nb`, `nn`, `ja`, `zh`).

## The source: `src/data/shared/` in this repo

| file | holds | read by |
|---|---|---|
| `locales.json` | every language: English and native name, flag, html/og tags, mail greeting, Apple storefront, the market it buys from (`country`) and its occasion market, the currency its pages pin, shipping suggestions, Mollie locale, hyphenation package, playlist-prompt description, feed number, `site` / `app` | `LOCALE_DATA`, Mollie, occasions, hyphenation, the playlist prompt, product feeds, all three `translate.js`; the site's `SUPPORTED_LANGUAGES`, og:locale, currency pins, payment badges, shipping page, i18n tooling; the app's languages, device mapping and website links |
| `markets.json` | every country: its automatic currency, the playlist languages /playlists shows there, the Mollie methods in checkout order (and the ones the homepage badges leave out), occasion market, product feed language | Mollie, currency detection, occasion prefill, product feeds; the site's country locales, payment badges, admin calendar |
| `currencies.json` | every currency in switcher order: decimals, snap step, the Mollie methods that take it | currency maps and rounding on both sides, Mollie's method filter, price formatting |

Edit only these three, here, then:

```bash
node scripts/sync-shared-data.mjs
```

It copies the JSON into `qrhit/src/data/shared/` and
`qrhit-app/src/app/shared-data/` and writes `shared-data.generated.ts` in all
three repos: the typed accessors (`LOCALES`, `SITE_LOCALES`, `APP_LOCALES`,
`MARKETS`, `CURRENCIES`) and the code unions (`LocaleCode`, `MarketCode`,
`CurrencyCode`, so `SupportedCurrency` stays a literal type). Never edit a copy.
`--check` changes nothing and fails on drift; `test/unit/shared-data.test.ts`
runs it (and checks every site language has its database columns, every
reference resolves and feed numbers are unique). It also fails when
`qrhit/growth.config.json` lacks a site language in `pillars.blog.locales` or
`pillars.ux.locales`.

Commit all three repos together: a copy that differs from the source fails the
API's tests.

## Order of work

1. The entry in `locales.json` (and `markets.json` for its country), sync.
2. Start the translation runs: they take the longest.
3. The few hand-written pieces below, in all three repos.
4. Content that lives in files (blog, reviews) before the deploy.
5. Deploy the API (its `prisma db push` adds the columns), then the frontend,
   then publish the CloudFront function.
6. Database content after the deploy (Translate Fields, calendar prefill).
7. App release once the site serves the new language.

## 1. The entry

A language for site and app sets `site` and `app` to true. Copy a similar
entry and check every field; the generated interface documents them. Notes:

- `name` is English: the LLM prompts and `translate.js` use it, and the site
  shows the `langs.<name in lower case>` key from the core `en.json`. Add that
  key there (`"danish": "Danish"`).
- `currency` pins the currency of the language's pages whoever crawls them
  (Googlebot fetches from US IPs). Give one when the language has one market;
  leave it null for English (GB/US/AU/CA) and Polish (Mollie takes no cards in
  PLN).
- `country` drives the payment methods a speaker sees; `occasionCountry` only
  when the occasion pages should follow another market (English → US for
  Thanksgiving).
- `hyphenation`: an npm `hyphenation.<lang>` package for card titles; install
  it with `npm i <pkg> --before=<a week ago>` and check the lockfile.
- `feedNumber` only for a language with a product feed; it is part of the
  offer id, so never renumber one.
- A new country in `markets.json`: `currency` only when visitors from there
  should pay in it automatically; `locales` (its own language first, then
  neighbours it reads, then `en`); `paymentMethods` most popular first, and
  `notOnBadges` for niche ones the homepage strip leaves out; `occasions` for
  an occasion-calendar market (its Father's Day may need a rule in
  `src/data/giftOccasions.ts` `FATHERS_DAY` when `date-holidays` has none:
  check with `new Holidays('DK', { languages: ['en'] }).getHolidays(2026)`);
  `feed` for a Merchant Center / Channable feed.

## 2. Translations

- **Website** (`qrhit`): `translate.js` reads the languages from the shared
  file; do not create empty files, it writes each bundle's `<lang>.json`.
  A new language is the whole catalogue (about 4,500 keys in 58 bundles, three
  per call): hours in one run. Split it with `--only=<bundle,...>` over
  disjoint bundle sets and run those in parallel (`node translate.js --dry-run`
  lists the work per bundle). Two runs must never share a bundle. Stopping a
  run is safe: the cache is written at the end of a bundle. A batch that fails
  leaves its keys untranslated; a rerun of that bundle fills them in.
  Done when `--dry-run` says 0 to translate, 0 stranded, and `node cache.js`
  and `node _scripts/i18n-check.mjs` pass. For a new language the check prints
  `fatal: path ... exists on disk, but not in 'main'` per new file: its
  lossless comparison finding nothing on `main`, not a failure.
- **API**: `node translate.js` writes `src/locales/<lang>.json` (about 700
  keys, minutes). It must be complete before the deploy: `/qr/:trackId` takes
  the locale from the phone's Accept-Language.
- **App**: `node translate.js` writes `src/assets/i18n/<lang>.json` (about
  150 keys).
- The core `<lang>.json` of the website must exist before the language goes
  live: `server.ts` caches an empty catalogue for a missing core file.

## 3. Still by hand

| where | what | guarded by |
|---|---|---|
| `prisma/schema.prisma` | `genre.name_<lang>`, `Playlist.description_<lang>`, `CompanyList.description_<lang>`, `EventBase.name_/description_/body_<lang>` (copy the `_no` lines). Not `Blog` or `TrustPilot`: unread. | `shared-data.test.ts` |
| `qrhit/_scripts/cloudfront/root-locale-redirect.js` | the `SUPPORTED` list (CloudFront cannot import); after the frontend deploy the function is **published by hand in AWS**, verify with `--live` | its test asserts it equals the site languages |
| `qrhit/growth.config.json` | `pillars.blog.locales`, `pillars.ux.locales` | `sync-shared-data.mjs --check` |
| growl (`/Users/rick/Sites/growl`) | `src/pillars/blog/translate.ts` `LANGUAGE_NAMES`, `html-to-markdown.ts` `KNOWN_LOCALES`, `opportunities.ts` `LOCALE_MARKETS` (Search Console country, DataForSEO location) | - |
| `qrhit/src/app/shared/box-presets.util.ts` | `LOCAL_SONGS_BY_LANGUAGE`: three current local hits for the homepage box, each verified on Spotify (id, artist, title, release year) | its spec (exactly three) |
| `src/productFeed.ts` `getTracksLabel`, `src/_data/chat.json` | copy in the language / the language list the chat widget names | - |
| `qrhit-app/src/app/app.component.ts` `LANGUAGES_ONCE_UNMATCHED` | add the language, so users who got English as the fallback before it existed switch once | - |
| `qrhit/public/llms.txt`, `music-quiz/en.json` `multiLanguageDesc` | the number of languages in copy (`remove-from-cache.sh` after changing the latter) | - |
| `qrhit/src/app/config/language-specific-routes.json` | optional localized landing slugs (add them to `_scripts/routes/i18n.txt` for the crawl); the Norway lander's copy is about Norway and NOK, so a lander on that component needs hand-edited copy | - |

Needs nothing: fonts (Google Fonts serves latin-ext; the app bundles it),
locale data (formatting uses `Intl`), flags (flagcdn.com), the countries
bundle, VAT rates, sitemaps, hreflang, the language menu.

## 4. Content

Before the deploy (files in this repo):

- **Blog**: `npm run growth -- blog keywords` in the website (per-market briefs
  from Search Console; thin for a new market), `npm run growth -- blog
  translate`, `npm run growth -- blog lint`.
- **Reviews**: `npm run growth -- reviews translate`, then `reviews lint`,
  which fails until every visible review has the new locale.

After the deploy (production database; ask first):

- **Admin › Bulk actions › Translate Fields**, the new languages ticked. It
  fills every empty language column from English: genre names (the genre
  translator), playlist descriptions (the SEO translator for SEO copy, word
  for word for a kept description, plain translation otherwise; the row is
  marked for Merchant Center and its product page cache cleared), company list
  descriptions and occasion names, descriptions and pages. One call per row for
  all ticked languages; progress is in the API log. Genre names also fill
  themselves overnight.
- **Admin › Bulk actions › Prefill Event Calendar** for new occasion markets
  (or wait for the monthly run).

## 5. Verification

- API: `node scripts/sync-shared-data.mjs --check`, `npx tsc --noEmit`,
  `npx vitest run test/unit`. Never the integration tests against the live
  database host.
- Website: `node translate.js --dry-run`, `node cache.js`,
  `node _scripts/i18n-check.mjs`, `node _scripts/cloudfront/root-locale-redirect.test.mjs`,
  `npx ng test --watch=false`, `npx ng build --configuration=development`
  (never `npm run build`), serve it (`PORT=4311 node dist/<out>/server/server.mjs`)
  and run `node _scripts/i18n-crawl.mjs` (it runs without the API; routes that
  need a slug from it are skipped), plus the `ng serve` pass (see the website's
  CLAUDE.md). A development build has unhashed file names served with a
  one-year cache, so a browser that saw an earlier build keeps its old
  `main.js` and `styles.css` until they are fetched with `cache: 'reload'`.
  Open `/<lang>` home, a product page, pricing and checkout; the language menu
  on a phone.
- App: `npx ng test --watch=false`, `npx ng build`, then the app in a browser
  with the device language set.

## 6. A new currency

One entry in `currencies.json` (and `currency` on the markets that should get
it automatically, `currency` on a language that should pin it): `decimals` (0
for a currency without cents in practice, like HUF), `snap` (every converted
amount rounds to a multiple of it; pick a step worth about €0.20-0.50) and
`methods`, the Mollie methods that take it, from
https://docs.mollie.com/docs/multicurrency (a method no currency lists is
EUR-only). Then sync.

In code, nothing to add, but keep to the rules that made HUF work:

- Format money with `formatPrice` / `CurrencyService.formatEur` / `PricePipe`,
  never a local `Intl.NumberFormat` with fixed digits. A unit price (per card)
  goes through `convertEurUnit`, which does not snap.
- Amounts go to Mollie as `toFixed(2)` whatever the currency's decimals
  ("13000.00"); a partial refund is a proportional share and has cents, so
  `createRefund` rounds it for a currency without them (HUF: down to whole
  forints).
- ECB rates (`services/fx.ts`) cover every currency ECB publishes. Currency
  names come from `Intl.DisplayNames`: no translation key.
- Nothing in Prisma (currency is a string), MoneyBird or the reports (they book
  EUR), or the invoice (its formatter takes the currency's own decimals).
- Fixtures: `qrhit/src/testing/mock-services.ts` (`supported`) and
  `qrhit/e2e/fixtures/data/currency-rates.json`.

**Mollie dashboard**: enable the currency for each method on the profile before
the deploy, or payments in it are refused.
