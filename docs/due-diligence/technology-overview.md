# QRSong! Technology Overview

<!-- Source of the branded PDF (qrhit/_scripts/build-tech-overview-pdf.mjs).
     Mirror of the Claude Doc "QRSong! Technology Overview"
     (https://claude.ai/code/artifact/b0c45aee-9b2c-458d-b490-239466ee73bb):
     change both together. The cover takes its date from `as-of` below. -->
<!-- as-of: 2026-10-09 -->

## About QRSong!

QRSong! sells printed music cards: every card carries a QR code that plays one song, so a playlist becomes a card game. The customer picks or pastes a playlist from Spotify, Apple Music, Deezer, YouTube Music or Tidal, designs the cards and an optional gift box, and pays online. Print partners produce and ship the order, and the free QRSong! app plays the song when a card is scanned.

| Part | What it is | Size |
| --- | --- | --- |
| Web shop and admin | Angular 22, server-side rendered, 12 languages, prices in the visitor's currency | 79k lines of TypeScript, 210 components |
| API | Node.js with Fastify 5, Prisma 7 on MySQL, Redis | 106k lines of TypeScript, about 446 endpoints, 65 data models |
| Scan app | Ionic/Capacitor app for iOS and Android | version 2.0.2 |
| Rendering | AWS Lambda functions for print PDFs and QR codes | 2 functions |
| Automated tests | Vitest (API), Karma/Jasmine (web), Playwright (end to end) | about 7,900 tests, about 80% statement coverage |

Development started in April 2024; the two main repositories hold about 9,300 commits.

<!-- stats: 185k | lines of TypeScript ; 7,900 | automated tests ; 12 | site languages ; 20 | scheduled jobs -->


## Architecture

<!-- diagram:architecture -->

The web server renders pages by calling the API, and only the API reaches the database and outside services. Print PDFs and QR codes are rendered on Lambda, so order volume does not load the web servers.

## What the platform does

One code base runs the consumer shop, the business sales channel, the scan app's back end and the admin that operates all three.

| Area | What it does |
| --- | --- |
| Consumer order flow | Playlist, card overview, card designer, extras, checkout. Shipping is quoted before checkout by the same calculation checkout uses. Payments through Mollie. |
| Music services | Reads playlists from Spotify, Apple Music, Deezer, YouTube Music and Tidal. Release years are checked against MusicBrainz, Discogs and other sources. |
| Describe your playlist | The customer describes a playlist in words and the API assembles it. |
| Card designer | Front and back designs, photo uploads resized in the browser, contrast and QR-scan checks before print, autosave across reloads. |
| Box designer | Designs the gift box lid and inlay, with the same image handling as the card designer. |
| Rights screening | A self-trained image model spots customer uploads that copy a competitor's protected card artwork or brand: once while the customer designs, and again on every picture before printing, where a hit holds the order. MobileNetV3, 3.1 million parameters, about 70 ms per picture on one CPU core, no paid API. Typed box text is checked against protected brand names in the browser. |
| Print checks | Before printing, every design is rendered again and compared with the stored print file, and the QR code on the print file is read back to confirm it leads to the right order line. |
| Fulfilment | Paid orders go to the print partners automatically (Print&Bind for consumers, Schneider for business orders), with tracking and PostNL shipping labels. |
| Scan app | Plays each card through Spotify's official App Remote SDK or embed. QR codes point at QRSong! links, so a printed card can be re-pointed later. |
| App Designer | A paid account upgrade that gives the scan app the customer's own look, delivered without an app update. |
| QRGames | A paid add-on: live quiz and bingo, hosted over websockets. |
| Business | Quote requests answered with a box design and quotation, company accounts and lists, voting pages for events, invoices in Moneybird. |
| Content and SEO | Blog in 12 languages, customer reviews, landing pages, Google Merchant product feeds. |
| Admin | Orders, companies, pricing tables, sales charts, AI cost ledger and printer settings, in one dashboard. |

## Engineering practice

About 7,900 automated tests cover both code bases at roughly 80% of statements, and coverage is held by a ratchet that only goes up.

| Practice | In place |
| --- | --- |
| API tests | 206 Vitest files, about 4,375 tests: unit tests plus integration tests against a real MySQL test database and Redis. Coverage gate: 79% statements, 80% functions. |
| Web tests | 212 spec files, about 3,550 tests, plus Playwright end-to-end runs of the digital and physical order flows on desktop and phone. |
| Type safety | Strict TypeScript with strict template checking in the web app; strict mode in the API. |
| Translations | A static checker verifies every page declares the translation bundles it uses and that all 12 languages stay in step; a crawler renders every route to catch untranslated text. |
| Supply chain | Dependency updates only take versions at least 7 days old, checked by a lockfile-age script. |
| Releases | A build is assembled next to the live one and swapped in whole; files from the previous release stay available for 7 days so open browser tabs keep working. |
| Documentation | Design rationale per feature for both code bases, plus guides for adding a music service and adding a language. |

A cleanup in October 2026 removed 58 unused API routes, 16 npm packages and 329 unused translation keys.

## Security and privacy

QRSong! never handles card data: payment runs on Mollie's hosted checkout, and the API trusts only what it fetches back from Mollie.

| Area | In place |
| --- | --- |
| Payments | The Mollie webhook re-fetches each payment from Mollie, is idempotent, and changes order status in one atomic step. |
| Accounts | Passwords hashed with PBKDF2-SHA512 at 600,000 iterations; older hashes are upgraded at the next login. Login and reset are rate-limited with lockout, and password reset does not reveal which addresses have accounts. |
| Sessions | The session cookie is HttpOnly and Secure; every admin endpoint checks the caller's role. |
| Secrets | No secret, key or token has ever been committed to git (checked across about 9,300 commits). |
| Abuse protection | reCAPTCHA v3 on public forms (it refuses when the check fails), a playlist guard against scraping, and the visitor's IP taken from CloudFront. |
| Files | Upload filenames are generated by the server. Business clients' files are private and only served to admins, with headers that stop a browser from running them. |
| Web headers | HSTS, nosniff, Referrer-Policy and X-Frame-Options on every page. |
| Consent and analytics | Analytics and session replay load only after cookie consent; error tracking removes payment ids, e-mail addresses and tokens from URLs, and admin sessions are never recorded. |
| Database access | Reporting uses a read-only database user. |

## Third-party services

Six services are essential to taking and fulfilling an order: Mollie, the two print partners, AWS hosting, Amazon SES for e-mail and the Spotify Web API.

| Service | Used for | Criticality |
| --- | --- | --- |
| Mollie | Payments and refunds | Essential |
| Print&Bind | Printing and shipping consumer orders | Essential |
| Schneider | Printing business orders and boxes | Essential |
| AWS | Hosting (CloudFront, an EC2 auto scaling group, RDS MySQL), PDF and QR rendering (Lambda), file storage (S3) | Essential |
| Amazon SES | All e-mail the platform sends: order confirmations, sign-in codes, shipping and review mails, business mail | Essential |
| Spotify Web API | Reading playlists and track data | Essential |
| Apple Music, Deezer, YouTube Music, Tidal | Playlists from the other music services | Important |
| MusicBrainz, Discogs, MusicFetch | Release years and links to other services | Important |
| OpenAI, Anthropic | Assembling described playlists, checking release years, translations, support replies | Important |
| PostNL, TrackingMore | Shipping labels and parcel tracking | Important |
| Moneybird | Bookkeeping and business invoices | Important |
| ConvertAPI | Merging print PDFs | Important |
| PostHog | Error tracking, and analytics with consent | Supporting |
| Google | reCAPTCHA, Merchant Center feeds, Analytics and Ads through Tag Manager | Supporting |
| EmailOctopus | Newsletters | Supporting |
| Crisp, CookieFirst | Support chat, cookie consent | Supporting |
| Firebase, Pushover | App push messages, operator alerts | Supporting |

## Operations

The platform runs on AWS in Ireland (eu-west-1), with CloudFront in front of everything and the heavy rendering on Lambda.

| Area | How it runs |
| --- | --- |
| Serving | CloudFront with a web application firewall, an application load balancer, and an EC2 auto scaling group running the API and the server-side rendering under pm2. The API runs one worker per CPU core. |
| Data | MySQL on Amazon RDS; Redis for caching and job queues. |
| Releases | Each release is built next to the live one and swapped in whole, then the processes restart and the CDN cache is cleared. A failed build changes nothing. |
| Scheduled work | Twenty scheduled jobs, listed in the next section. Generating an order's QR codes and PDFs runs through a BullMQ job queue with three attempts and backoff. |
| Monitoring | Errors from the web app and the API go to PostHog, with source maps per release; operational alerts go to the operator by Pushover. |
| Performance | Route chunks are preloaded on idle, critical CSS is inlined, and the tag manager starts after page load, which lifted the mobile Lighthouse score from 62 to 80. |

Open question: backup retention and point-in-time recovery for RDS, to be filled in from the AWS console.

## Scheduled work

Twenty jobs run on a schedule, most of them hourly; the printer hand-off is the one the business depends on most. Jobs that must run once run only on a designated main server. Times are server time unless marked.

| When | Job | What it does |
| --- | --- | --- |
| Every 15 minutes | Game rooms | Ends quiz and bingo rooms that have been idle for 4 hours. |
| Hourly at :00 (Amsterdam time) | Printer hand-off | Sends paid physical orders to Print&Bind after the pre-print checks. An order that fails a check is held; an order waiting on the customer's corrections gets one reminder. |
| Hourly at :00 | Parcel tracking | Reads the PostNL status of shipped parcels through TrackingMore and marks them delivered. |
| Hourly at :00 | Review eligibility | Marks an order eligible for a review request once 25 or more of its songs have been scanned. |
| Hourly at :00 | Scan link cache | Rebuilds the cache of streaming links that every QR scan is redirected through. |
| Hourly at :05 | Review requests | Mails a review request 10 days after the order, only to customers who opted in, never twice to one address. |
| Hourly from :07 | Track corrections | Each server process picks up the release years, titles and artists corrected since its previous run, one process per minute, for all music services. A full reload runs nightly from 02:10. |
| Hourly at :15 | Shipping updates | Polls Print&Bind for shipped orders, stores the tracking link, mails the customer and registers the parcel for tracking. Closes orders older than 30 days. |
| Hourly at :35 | Box instructions | Mails the gift box folding instructions 24 hours after shipping. |
| Every 6 hours | Chat cleanup | Deletes empty support chats older than 24 hours. |
| Daily 01:00 | Payment cleanup | Releases expired discount-code reservations and deletes expired or canceled payments. |
| Daily 01:30 | Genre translations | Translates new genre names into every site language. |
| Daily 02:00 | Card set import | Re-imports the external card sets the scan app recognises and fills in missing music-service links. |
| Daily 03:00 | Playlist ranking | Recalculates the ranking and decade mix of the featured playlists. |
| Daily 03:00 | Newsletter sync | Syncs customers' consent, language and country to the EmailOctopus list. |
| Daily 03:30 | Cover check | Replaces dead playlist covers and unfeatures playlists that are gone from Spotify. |
| Daily 03:30 | Described playlist cleanup | Deletes playlists assembled from a description that were not bought within 3 days. |
| Daily 03:30 | Business contacts sync | Syncs company contacts to the business newsletter lists, never resubscribing anyone. |
| Daily 16:30 | Exchange rates | Fetches the ECB daily rates used for prices in local currencies. |
| Monthly, 1st at 04:00 | Event calendar | Prefills holidays and gift occasions per country for the next three years. |

## Improvement log

Each hardening step is added here when it ships, newest first.

| Date | Change | What it does |
| --- | --- | --- |
| 2026-10-09 | Lighter track refresh | The hourly refresh of corrected track data reads only the tracks that changed since the previous run, one server process at a time, instead of every process reloading all 423,000 tracks at once. |
| 2026-10-09 | Help-text editor replaced | The App Designer's rich-text editor (Quill, an open vulnerability with no fixed release) became a Markdown editor that stores exactly the same HTML, so nothing downstream changed. |
| 2026-10-09 | Session hardening | Only the site's own addresses may call the API with a login session, and the session cookie no longer travels with requests that other sites start. |
| 2026-10-09 | Sign-in codes | Registration and reset codes come from a cryptographic source, are voided after five wrong tries, and requests for them are rate-limited. |
| 2026-10-09 | Input checks | Report dates are validated before they reach the database; the playlist link resolvers only follow the music services' own short-link domains. |
| 2026-10-09 | Dependency updates | Security releases of handlebars, sharp, fastify, mysql2, proxy-addr and dompurify, and a smaller maximum request size. |
| 2026-10-08 | Unused code removed | 58 API routes, 16 npm packages and 329 translation keys that nothing used. |
| 2026-10-06 | Currency choice kept out of shared caches | Pages rendered in a visitor's chosen currency are marked private, so a CDN never hands one visitor's currency to another. |
| 2026-09-23 | Analytics privacy | Admin sessions are never recorded; payment ids, e-mail addresses and tokens are removed from recorded URLs. |
| 2026-09-22 | Safe releases | Builds are assembled next to the live site and swapped in whole, so a release never serves pages whose scripts are missing. |
| 2026-09-21 | Error tracking | Errors from the web app and the API are reported to PostHog with source maps per release. |
| 2026-06-15 | Test harness and authorization fixes | About 7,900 tests written; two public admin routes closed and ownership checks added to the quiz endpoints. |
