# QRSong/QRHit Backend API - Complete Feature Inventory
## Acquisition & Technical Assessment Document

**Document Generated:** 2025-11-06
**API Codebase Location:** /users/rick/sites/qrhit-api
**Framework:** Fastify (Node.js/TypeScript)
**Database:** MySQL (Prisma ORM)
**Queue System:** BullMQ (Redis-based)

---

## 1. CORE INFRASTRUCTURE & ARCHITECTURE

### 1.1 Server Framework
- **Framework:** Fastify 5.6.1 - High-performance HTTP server
- **Language:** TypeScript
- **Database ORM:** Prisma 6.18.0
- **Message Queue:** BullMQ 5.61.2 (Redis-based job queue)
- **Real-time Communication:** WebSocket (native & WebSocket-Native implementation)
- **Cache Layer:** Redis (via ioredis 5.8.2)

### 1.2 Database Models (MySQL via Prisma)
**Core Tables:**
- `users` - User authentication & profiles
- `payments` - Payment/order records with comprehensive tracking
- `playlists` - Music playlist definitions
- `playlist_has_tracks` - Track relationships
- `tracks` - Music track database
- `payment_has_playlist` - Order line items with design preferences
- `payment_has_playlist_item` - Batch processing for large orders
- `order_types` - Product catalog (digital/physical/sheets)
- `user_suggestions` - Track corrections from users
- `trackextrainfo` - Extended track metadata
- `discount_codes` & `discount_codes_uses` - Promotional discounts
- `reviews` - Customer reviews/ratings
- `push_tokens` & `push_messages` - Push notification registry
- `companies` - B2B company accounts
- `company_lists` - Voting/submission systems
- `company_list_submissions` - User submissions
- `company_list_answers` - Survey responses
- `shipping_costs` & `shipping_costs_new` - Shipping rate tables
- `genres` - Genre taxonomy (11+ languages)
- `isrc` - Track release year lookup
- `taxrates` - Tax configuration
- `printer_invoices` - Print partner billing
- `trustpilot` - Review aggregation
- `user_groups` & `user_in_groups` - Role-based access control
- `blogs` - CMS content (11+ languages)
- `settings` - Global application settings
- `app_settings` - Key-value configuration storage

---

## 2. AUTHENTICATION & AUTHORIZATION SYSTEM

### 2.1 Authentication Methods
- **JWT-based:** Token generation & verification
- **Email/Password:** User account system with salt+hash (PBKDF2)
- **Email Verification:** Hash-based verification with expiry
- **Password Reset:** Secure token flow with expiry validation
- **Admin Authentication:** Role-based (admin, vibeadmin, companyadmin, qrvoteadmin, users)
- **OAuth Integration:** Spotify authorization (for playlist linking)

### 2.2 Authorization & User Roles
- **Admin:** Full system access
- **VibeAdmin:** Admin for voting/submission system
- **CompanyAdmin:** Restricted to company data
- **QRVoteAdmin:** Voting/survey management
- **Users:** Regular customers & guest accounts

### 2.3 Authentication Endpoints
- `POST /validate` - Login/email validation
- `POST /account/register` - User registration with CAPTCHA
- `POST /account/verify` - Email verification
- `POST /account/reset-password-request` - Request password reset
- `POST /account/reset-password` - Complete password reset
- `GET /account/reset-password-check/:hash` - Validate reset token
- `POST /api/account/games-request-activation` - Games activation code request
- `POST /api/account/games-validate-activation` - Games activation validation

---

## 3. PAYMENT PROCESSING SYSTEM

### 3.1 Payment Provider Integration - Mollie
- **Provider:** Mollie Payments (European payment gateway)
- **Payment Methods Supported:** 
  - Credit cards (Visa, Mastercard, AmEx)
  - iDEAL (Dutch banking)
  - PayPal
  - SEPA bank transfers
  - Apple Pay
  - Google Pay
- **Features:**
  - Multi-currency support (EUR, USD, GBP, etc.)
  - Tax handling (VAT calculation & reporting)
  - Webhook integration for payment status updates
  - Recurring payments/subscriptions
  - Test mode & production mode

### 3.2 Payment Management Endpoints
- `POST /mollie/payment` - Create payment
- `POST /mollie/check` - Check payment status
- `POST /mollie/webhook` - Payment status webhook
- `GET /progress/:playlistId/:paymentId` - Order progress tracking
- `GET /ordertype/:numberOfTracks/:digital/:subType/:playlistId` - Product pricing
- `GET /ordertypes` - List all available products
- `POST /order/calculate` - Calculate order totals
- `POST /order/volume-discount` - Volume discount calculation
- `POST /discount/:code/:digital` - Discount code validation

### 3.3 Payment Webhooks
- Status updates: paid, failed, expired, canceled, authorized
- Automatic invoice generation
- Notification emails
- Integration with order processing pipeline

### 3.4 Admin Payment Management
- `GET /admin/orders` (with search) - Paginated order list
- `DELETE /admin/payment/:paymentId` - Permanent payment deletion
- `POST /admin/payment/:paymentId/duplicate` - Clone & regenerate order
- `POST /admin/payment/:paymentId/printer-hold` - Hold order from printing
- `GET /admin/payment/:paymentId/info` - Payment details
- `PUT /admin/payment/:paymentId/info` - Update customer info
- `GET /admin/month_report/:yearMonth` - Sales reporting
- `GET /admin/tax_report/:yearMonth` - Tax accounting report
- `GET /admin/day_report` - Daily sales summary

---

## 4. PRODUCT & ORDER MANAGEMENT

### 4.1 Order Types (Products)
- **Physical Cards:** Printed QR code cards with customization
- **Digital Cards:** PDF downloads
- **Sheets:** Bulk printed sheets
- Configurable pricing per product
- Quantity-based pricing tiers
- Print API integration capability

### 4.2 Order Processing
- Order creation → Payment → Generation → Printing → Shipping
- Multiple playlist support per order
- Batch processing for large orders (items split across PDFs)
- Design customization (fonts, colors, backgrounds, QR codes)
- Eco-friendly options (double-sided printing)

### 4.3 Order Status Tracking
- open, pending, authorized, paid, failed, canceled, expired
- Finalization status for accounting
- Printer readiness checks
- Track all transaction history

---

## 5. PRINTING & PRODUCTION SYSTEM

### 5.1 Print Partner Integration

#### A. Print & Bind API (printenbind.ts)
- **Integration:** Mollie Print API
- **Features:**
  - Order submission to print partner
  - Tracking number assignment
  - Print status monitoring
  - Shipping updates
  - Invoice reconciliation
- **Endpoints:**
  - `POST /admin/printenbind/update-payments` - Sync print API statuses
  - Automatic hourly status polling

#### B. Google Merchant Center Integration (merchantcenter.ts)
- Featured playlist syndication
- Product listing management
- Automated upload scheduling (4am daily)
- Inventory management

### 5.2 Print-Related Endpoints
- `GET /admin/printerinvoices` - List supplier invoices
- `POST /admin/printerinvoices` - Create supplier invoice
- `PUT /admin/printerinvoices/:id` - Update invoice
- `DELETE /admin/printerinvoices/:id` - Delete invoice
- `POST /admin/printerinvoices/:id/process` - Process invoice data
- `POST /admin/supplement-excel` - Async Excel processing for bulk ops
- `GET /admin/supplement-excel/status/:jobId` - Check job status
- `GET /admin/supplement-excel/download/:filename` - Download result

### 5.3 Designer/Card Customization
- Background image upload & selection
- Logo upload
- Front/back side design
- QR code styling (color, background, circle hide)
- Font selection & sizing
- Gradient backgrounds
- Opacity control
- Eco/double-sided options

---

## 6. MUSIC DATA & INTEGRATION

### 6.1 Spotify Integration (spotify.ts)
- **OAuth Flow:** User authorization for playlist access
- **Features:**
  - Playlist fetching (tracks, metadata, images)
  - Album art caching
  - User playlist linking
  - Spotify URI parsing
  - Search integration
  - Authorization token management
  - Rate limiting via Bottleneck library

### 6.2 Music Data Services
- **Spotify API Integration:** Track metadata, images, URIs
- **Spotify Scraper:** Alternative web scraping method
- **RapidAPI Integration:** Multiple Spotify data providers
- **YouTube Music API:** Music link resolution
- **Deezer, Apple Music, Amazon Music, Tidal:** Link resolution

### 6.3 Track Database Management
- **ISRC Lookup:** International Standard Recording Code for release year verification
- **Year Detection:** Multi-source year detection:
  - Spotify release year
  - Discogs year
  - AI/ChatGPT analysis (OpenPerplex)
  - Google search results analysis
  - MusicBrainz year
- **Music Link Fetching:** Background job to find links across platforms
- **Track Search:** Full-text search on artist/name

### 6.4 Music-Related Endpoints
- `POST /spotify/playlists/tracks` - Get playlist tracks
- `POST /spotify/playlists` - Get playlist metadata
- `POST /resolve_shortlink` - Resolve Spotify short URLs
- `POST /qrlink_unknown` - Resolve unknown URLs to Spotify URI
- `GET /featured/:locale` - Get featured playlists
- `POST /hitlist/search` - Search track database
- `POST /hitlist/search-musicfetch` - Search with music fetching
- `POST /hitlist/tracks` - Get track details by IDs
- `GET /qrlink/:trackId` - Get music links (Spotify, YouTube, Apple Music, etc.)
- `GET /qrlink2/:trackId/:php` - Extended link format with multiple platforms
- `GET /qr/:trackId` - QR code landing page
- `POST /admin/tracks/missing-music-links` - Find tracks needing links
- `POST /admin/tracks/fetch-music-links` - Bulk fetch music links
- `POST /admin/tracks/search` - Search for tracks
- `POST /admin/tracks/update` - Update track data
- `GET /admin/yearcheck` - Find unchecked tracks
- `POST /admin/yearcheck` - Update track year
- `GET /admin/add_spotify` - Add Spotify links to tracks

---

## 7. PDF & FILE GENERATION

### 7.1 PDF Generation Pipeline
- **Template Engine:** EJS for dynamic HTML→PDF conversion
- **PDF Library:** pdf-lib for manipulation
- **Conversion:** ConvertAPI for HTML→PDF transformation
- **Image Processing:** Sharp for image optimization

### 7.2 Document Types Generated
- **Physical QR Cards:** Full-page layouts with customization
- **Digital Card PDFs:** User-downloadable versions
- **Invoices:** Customer-facing and merchant receipts
- **Quotations:** Business proposal templates (Vibe/QRSong)
- **Gamesets:** ZIP archives with QR codes

### 7.3 Customization Features
- Multiple templates (standard, printer-specific, white-label)
- Front/back side designs
- Eco printing modes
- Empty page padding
- Batch numbering
- Color/gradient backgrounds

### 7.4 Download/View Endpoints
- `GET /download/:paymentId/:userHash/:playlistId/:type` - User download
- `GET /qr/pdf/:playlistId/:paymentId/:template/:startIndex/:endIndex/:subdir/:eco/:emptyPages/:itemIndex` - PDF generation
- `GET /invoice/:paymentId` - Invoice HTML view
- `GET /admin/download_invoice/:invoiceId` - Admin invoice download
- `GET /admin/playlist-excel/:paymentId/:paymentHasPlaylistId` - Export playlist

---

## 8. SHIPPING & FULFILLMENT

### 8.1 TrackingMore Integration
- **Provider:** TrackingMore (international shipping tracker)
- **Features:**
  - Shipment creation
  - Tracking number management
  - Multi-carrier support
  - Real-time tracking status updates
  - Delivery notifications
  - Country-specific shipping rates

### 8.2 Shipping Management
- Calculate shipping costs per country
- Volume-based pricing
- Handling fees
- VAT calculation
- Automatic status updates (cron job)

### 8.3 Shipping Endpoints
- `POST /admin/shipping/create-all` - Bulk create shipments
- `POST /admin/tracking/in-transit` - Get shipped orders (paginated)
- `POST /admin/tracking/delivered` - Get delivered orders (paginated)
- `GET /admin/tracking/country-codes` - Available shipping countries
- `POST /admin/tracking/export` - Export tracking data to Excel
- `POST /admin/tracking/toggle-ignore` - Mark shipment as manually reviewed
- `GET /api/tracking/average-delivery-times` - Public delivery statistics
- `GET /api/shipping/info-by-country` - Public shipping rates by country

---

## 9. NOTIFICATION SYSTEMS

### 9.1 Email System (Mail Service)
- **Provider:** AWS SES (Simple Email Service)
- **Features:**
  - Template-based HTML emails
  - Attachment support (PDFs, images)
  - Unsubscribe links
  - MIME encoding
  - Bulk sending capability
  - Multi-language support

### 9.2 Email Types
- Order confirmation
- Payment received
- PDF ready for download
- Shipping notification
- Tracking updates
- Review request
- Password reset
- Newsletter
- Admin notifications
- QRSong game activation codes

### 9.3 Push Notifications
- **Provider:** Firebase Admin SDK
- **Features:**
  - Device token management
  - Broadcast notifications
  - Test mode capability
  - Dry run capability
  - Message history

### 9.4 Notification Endpoints
- `POST /push/register` - Register device token
- `GET /push/messages` - Get notification history
- `POST /admin/push/broadcast` - Send broadcast notification
- `POST /newsletter_subscribe` - Newsletter signup
- `GET /unsubscribe/:hash` - Newsletter unsubscribe
- `POST /contact` - Contact form emails

---

## 10. ANALYTICS & REPORTING

### 10.1 Analytics Client
- **System:** Custom analytics counter
- **Tracks:**
  - Page views
  - Download counts
  - Payment events
  - Order status changes
  - User actions
  - Track selections

### 10.2 Reporting Endpoints
- `GET /admin/analytics` - All counters
- `GET /admin/charts/moving-average` - 30-day moving average chart
- `GET /admin/day_report` - Daily sales
- `GET /admin/month_report/:yearMonth` - Monthly sales
- `GET /admin/tax_report/:yearMonth` - Tax by rate
- `GET /reviews/:locale/:amount/:landingPage` - Trustpilot reviews

---

## 11. QUEUE & JOB PROCESSING SYSTEM

### 11.1 Job Queue Architecture
- **Queue System:** BullMQ with Redis backend
- **Workers:** Background job processors
- **Status Tracking:** Job state management (waiting, active, completed, failed, delayed)

### 11.2 Job Types

#### A. Generator Queue (generatorQueue.ts)
- PDF generation for orders
- Track checking
- Email sending
- Supplier notifications
- Retry logic with exponential backoff
- Failed job recovery

#### B. Excel Processing Queue (excelQueue.ts)
- Bulk Excel file processing
- QRSong link injection
- Progress tracking
- Download link generation

#### C. MusicFetch Queue (musicfetchQueue.ts)
- Background music link fetching
- Multi-platform link resolution
- Rate-limited API calls

### 11.3 Queue Management Endpoints
- `GET /admin/queue/status` - Queue health
- `GET /admin/queue/detailed` - Full queue details with jobs
- `GET /admin/queue/jobs/:status` - Jobs by status (with pagination)
- `GET /admin/queue/job/:jobId` - Individual job details
- `POST /admin/queue/job/:jobId/retry` - Reprocess failed job
- `DELETE /admin/queue/job/:jobId` - Remove job
- `POST /admin/queue/pause` - Pause all processing
- `POST /admin/queue/resume` - Resume processing
- `POST /admin/queue/retry-failed` - Retry all failed jobs
- `POST /admin/queue/clear` - Clear entire queue

---

## 12. BACKGROUND JOBS & SCHEDULED TASKS (CronJobs)

### 12.1 Scheduled Tasks
- **Hourly:** Spotify playlist sync, shipping status updates, track blocking sync
- **Daily (1am):** Payment finalization check
- **Daily (2am):** Mollie payment sync, Order cron, Trustpilot fetching, Review email processing
- **Daily (4am):** Google Merchant Center upload
- **Weekly:** Invoice reconciliation
- **Monthly:** Tax report generation
- **Every 30 days:** Genre translation updates

### 12.2 Cron Job Types
- Payment reconciliation
- Shipping status updates
- Spotify playlist caching
- Trustpilot review fetching
- Genre translations
- Review email distribution
- Track blocking lists
- Print tracking updates
- Automatic finalization

---

## 13. REVIEW & RATING SYSTEM

### 13.1 Review Management
- Customer ratings & text reviews
- Star ratings (1-5)
- Trustpilot integration
- Review eligibility tracking
- Playback-based review unlocking

### 13.2 Review Endpoints
- `GET /review/:paymentId` - Check review status
- `POST /review/:paymentId` - Submit review
- `GET /reviews/:locale/:amount/:landingPage` - Get Trustpilot reviews
- `GET /reviews_details` - Company Trustpilot details
- `GET /unsent_reviews` - Find unsent review emails
- `POST /admin/process_playback_counts` - Update review eligibility

---

## 14. DISCOUNT & PROMOTIONS SYSTEM

### 14.1 Discount Code Management
- **Types:** General, digital-only, playlist-specific
- **Features:**
  - Date-based activation
  - Expiration dates
  - Maximum usage per code
  - Per-code usage tracking
  - Custom messages
  - Custom descriptions

### 14.2 Discount Features
- Fixed amount discounts
- Volume-based discounts
- CAPTCHA-protected code entry

### 14.3 Admin Discount Endpoints
- `POST /admin/discount/create` - Create discount code
- `GET /admin/discount/all` - List all codes
- `DELETE /admin/discount/:id` - Delete code
- `PUT /admin/discount/:id` - Update code

---

## 15. USER SUGGESTIONS & CROWDSOURCING

### 15.1 User Suggestion System
- Users can suggest corrections to track data
- Suggestion storage & management
- Admin review & approval
- Batch apply corrections

### 15.2 Suggestion Endpoints
- `GET /usersuggestions/:paymentId/:userHash/:playlistId` - Get suggestions
- `POST /usersuggestions/:paymentId/:userHash/:playlistId` - Save suggestion
- `POST /usersuggestions/:paymentId/:userHash/:playlistId/submit` - Submit all
- `POST /usersuggestions/:paymentId/:userHash/:playlistId/extend` - Extend deadline
- `POST /usersuggestions/:paymentId/:userHash/:playlistId/reload` - Reload playlist
- `DELETE /usersuggestions/:paymentId/:userHash/:playlistId/:trackId` - Delete suggestion
- `GET /admin/corrections` - Get pending corrections
- `POST /admin/correction/:paymentId/:userHash/:playlistId/:andSend` - Apply correction

---

## 16. CARD DESIGNER & CUSTOMIZATION

### 16.1 Designer Features
- Image uploads for backgrounds
- Logo placement
- QR code styling
- Font selection
- Color customization
- Gradient support
- Opacity control
- Front/back side design

### 16.2 Designer Endpoints
- `POST /designer/upload/:type` - Upload design assets
- `GET /usersuggestions/:paymentId/:userHash/:playlistId/design` - Get design
- `POST /usersuggestions/:paymentId/:userHash/:playlistId/design` - Save design

---

## 17. BLOG & CMS SYSTEM

### 17.1 Blog Features
- Multi-language support (11 languages)
- Rich text content
- Featured images with AI prompt descriptions
- SEO slugs per language
- Draft/publish status
- Landing page flag

### 17.2 Blog Data
- Multilingual slugs: en, nl, de, fr, es, it, pt, pl, jp, cn, sv
- Title, content, summary per language
- Active/inactive status
- Timestamps

---

## 18. VOTING & SUBMISSION SYSTEM (OnzeVibe)

### 18.1 Company Voting System
- **Purpose:** Employee or customer voting on music
- **Features:**
  - Company-managed voting lists
  - Individual submissions
  - Email verification
  - CAPTCHA protection
  - Survey questions
  - Result tracking

### 18.2 Voting Data Models
- Companies (B2B accounts)
- Company lists (voting campaigns)
- Company list questions
- Submissions (individual votes)
- Submission tracks (linked music)
- Survey answers

### 18.3 Voting Endpoints
- `POST /vibe/companylist/create` - Create public voting list
- `GET /vibe/companies` - List companies (admin)
- `POST /vibe/companies` - Create company
- `PUT /vibe/companies/:companyId` - Update company
- `DELETE /vibe/companies/:companyId` - Delete company
- `POST /vibe/companies/:companyId/lists` - Create voting list
- `DELETE /vibe/companies/:companyId/lists/:listId` - Delete list
- `PUT /vibe/companies/:companyId/lists/:listId` - Update list
- `GET /vibe/company/:companyId` - Get company lists
- `GET /vibe/state/:listId` - Get voting state
- `POST /vibe/finalize` - Finalize voting
- `POST /vibe/generate/:listId` - Generate PDF from votes
- `PUT /vibe/submissions/:submissionId` - Update submission
- `DELETE /vibe/submissions/:submissionId` - Delete submission
- `POST /vibe/lists/:companyListId/replace-track` - Replace track in votes

### 18.4 Pricing Calculation
- `POST /vibe/calculate` - OnzeVibe pricing
- `POST /vibe/calculate-tromp` - Tromp (QRSong) pricing
- `POST /vibe/quotation/:companyId` - Generate quotation PDF
- `GET /vibe/quotation/:type/:companyId/:quotationNumber` - View quotation

---

## 19. GAMES SYSTEM

### 19.1 Game Features
- QRSong card games
- Playlist-based game content
- Remote & local play modes
- Multiple round types
- Player scoring
- Game state management

### 19.2 Game Data Models
- Games (instances)
- Players (participants)
- Playlists (game content)
- Track selection
- Scoring

### 19.3 Game Endpoints
- `POST /api/games/create` - Create new game
- `POST /api/games/join` - Join existing game
- `GET /api/games/:gameId` - Get game info
- `GET /api/games/random-track` - Get random track
- `GET /api/games/playlists` - Get basic playlists
- `GET /api/games/playlists/:userHash` - Get user playlists

### 19.4 Games Activation
- Activation codes tied to purchases
- Email delivery of codes
- Time-limited code validation (1 hour expiry)
- User identification via hash

---

## 20. HITLIST VOTING SYSTEM

### 20.1 Hitlist Features
- Company/employee voting on tracks
- Pre-defined track database
- Multiple voting methods
- Email verification

### 20.2 Hitlist Endpoints
- `POST /hitlist` - Get voting list
- `POST /hitlist/search` - Search available tracks
- `POST /hitlist/search-musicfetch` - Advanced music search
- `POST /hitlist/tracks` - Get tracks by IDs
- `POST /hitlist/submit` - Submit voting results
- `POST /hitlist/verify` - Verify submission
- `POST /hitlist/spotify-auth-complete` - Complete Spotify OAuth
- `GET /spotify_callback` - Spotify OAuth callback

---

## 21. SECURITY & PROTECTION

### 21.1 Security Features
- CAPTCHA verification (reCAPTCHA integration)
- Email verification hashes
- Password reset token validation
- Rate limiting
- IP tracking
- User agent logging
- Input sanitization (sanitize-html)
- CORS configuration
- JWT token expiry

### 21.2 Security Headers
- Apple App Site Association (AASA) support
- robots.txt generation
- CAPTCHA validation on forms
- Secure token handling

---

## 22. INTEGRATIONS & THIRD-PARTY SERVICES

### 22.1 Payment & Commerce
- Mollie Payments (primary payment gateway)
- Print & Bind API (print partner)
- Print tracking integration

### 22.2 Music & Media
- Spotify API & OAuth
- YouTube Music API
- Deezer API
- Apple Music links
- Amazon Music links
- Tidal links
- MusicBrainz (year verification)
- Discogs (year verification)
- ISRC database (year verification)

### 22.3 Cloud Services
- AWS SES (email)
- AWS EC2 (deployment)
- AWS Lambda (likely serverless functions)
- Google APIs (Merchant Center, OAuth)
- Firebase Admin SDK (push notifications)

### 22.4 Content & SEO
- Google Merchant Center
- Trustpilot reviews API
- ConvertAPI (document conversion)
- RapidAPI (data providers)

### 22.5 Data & Analytics
- MaxMind (GeoIP lookup)
- Sentry (error tracking)
- Custom analytics counter

---

## 23. MULTILINGUAL SUPPORT

### 23.1 Supported Languages
- English (en)
- Dutch (nl)
- German (de)
- French (fr)
- Spanish (es)
- Italian (it)
- Portuguese (pt)
- Polish (pl)
- Japanese (jp)
- Chinese/Simplified (cn)
- Swedish (sv)

### 23.2 Localization Features
- User locale preference
- Automatic language detection
- Email templates in user's language
- Content translations in database
- Language-specific slug generation

---

## 24. ACCOUNT MANAGEMENT

### 24.1 User Account Features
- Profile management
- Payment history
- Order tracking
- Preference settings
- Marketing email opt-in/out
- Account verification
- Password management

### 24.2 Account Endpoints
- `GET /account/overview` - User profile data
- `PUT /account/voting-portal/:id` - Update voting portal
- `DELETE /account/voting-portal/:id` - Delete voting portal

---

## 25. SYSTEM ADMINISTRATION

### 25.1 Admin Dashboard Features
- Order search & filtering
- Payment management
- User management
- Analytics viewing
- Queue monitoring
- Settings management

### 25.2 Admin Settings
- Production days configuration
- Production message customization
- Tax rate configuration
- Shipping rates

### 25.3 Admin Endpoints
- `GET /admin/settings` - Get settings
- `PUT /admin/settings` - Update settings
- `POST /admin/admin/create` - Create/update admin user
- `DELETE /admin/admin/user/:id` - Delete user
- `GET /admin/verify/:paymentId` - Verify payment
- `POST /admin/openperplex` - AI year query
- `GET /admin/lastplays` - Recent orders
- `GET /admin/regenerate/:paymentId/:email` - Regenerate PDF
- `POST /admin/finalize` - Finalize order
- `POST /admin/playlist/:playlistId/blocked` - Block playlist
- `POST /admin/playlist/:playlistId/featured` - Feature playlist
- `POST /admin/generate-playlist-json` - Create playlist mapping

---

## 26. FILE STORAGE & MANAGEMENT

### 26.1 File Types
- PDF documents (orders, invoices, quotations)
- Images (backgrounds, logos, album art)
- Excel files (reports, bulk data)
- ZIP archives (gamesets)

### 26.2 Storage System
- Public directory for downloads
- PDF directory structure
- Excel output directory
- Temporary file management

---

## 27. DEVELOPMENT & TESTING

### 27.1 Development Endpoints (Dev Mode Only)
- `POST /test_audio` - Test audio generation
- `POST /push` - Test push notifications
- `POST /qrtest` - Test QR code generation
- `GET /testorder` - Test order flow
- `GET /calculate_shipping` - Recalculate shipping
- `GET /generate/:paymentId` - Manual generation
- `GET /mail/:paymentId` - Manual email
- `GET /release/:query` - AI year detection
- `GET /yearv2/:id/:isrc/:artist/:title/:spotifyReleaseYear` - Year detection
- `GET /dev/translate_genres` - Translate genres
- `GET /test_shipping/:paymentId` - Test shipping integration
- `GET /test_tracking/:paymentId` - Test tracking
- `GET /dev_update_shipping_statuses` - Manual shipping update
- `GET /youtube/:artist/:title` - Get YouTube link

### 27.2 Utility Endpoints
- `GET /ip` - Get client IP
- `GET /test` - Server health check
- `GET /cache` - Cache management
- `GET /upload_contacts` - Manual contact upload

---

## 28. DATA MODELS & RELATIONSHIPS

### 28.1 Core Relationships
- User → Payment (1:many)
- User → User Suggestions (1:many)
- Payment → PaymentHasPlaylist (1:many)
- PaymentHasPlaylist → PaymentHasPlaylistItem (1:many)
- PaymentHasPlaylist → OrderType (many:1)
- Playlist → PlaylistHasTrack (1:many)
- Track → PlaylistHasTrack (1:many)
- Company → CompanyList (1:many)
- CompanyList → CompanyListSubmission (1:many)
- CompanyListSubmission → CompanyListSubmissionTrack (1:many)
- Discount Code → DiscountCodedUses (1:many)

### 28.2 Key Fields for Business Logic
- Payment.status: Determines order lifecycle
- Payment.finalized: Accounting flag
- Payment.sentToPrinter: Production status
- PaymentHasPlaylist.eligible ForPrinter: Readiness check
- Track.year: Release date (from multiple sources)
- Track.manuallyChecked: Data quality flag
- Payment.totalPrice/totalPriceWithoutTax: Revenue calculation
- Payment.shippingStatus: Fulfillment tracking

---

## 29. MONITORING & LOGGING

### 29.1 Logging Systems
- Console logging with colors
- Request/response logging
- Error logging
- Track processing logging
- Payment processing logging
- User action logging
- IP logging

### 29.2 Error Tracking
- Sentry integration for production errors
- Error context preservation
- User identification in errors
- Stack trace collection

---

## 30. DEPLOYMENT & INFRASTRUCTURE

### 30.1 Build & Deployment
- TypeScript compilation
- Docker-ready structure
- PM2 process management
- Git-based deployment
- Database migration (Prisma)
- Environment-based configuration

### 30.2 Environment Variables
- DATABASE_URL - MySQL connection
- REDIS_URL - Redis connection
- JWT_SECRET - Token signing
- API_URI, FRONTEND_URI - Domain configuration
- AWS credentials (SES, Lambda, EC2)
- Mollie API key
- Spotify API credentials
- Firebase service account
- Google API keys
- CAPTCHA keys
- Third-party API keys

---

## 31. PERFORMANCE OPTIMIZATIONS

### 31.1 Caching Strategy
- Redis for session/token caching
- Playlist metadata caching
- Spotify track caching
- Analytics counter caching

### 31.2 Rate Limiting
- Bottleneck library for API rate limiting
- Queue-based rate limiting
- CAPTCHA for form protection

### 31.3 Database Optimization
- Composite indexes for common queries
- Full-text search indexes
- Column-specific indexes for filtering
- Query result pagination

---

## 32. KNOWN BUSINESS RULES

### 32.1 Order Processing
1. User creates order with playlist & products
2. Payment initiated via Mollie
3. On payment success: Order queued for generation
4. Generation: PDF creation for each design variant
5. Printer readiness check
6. Eligible orders sent to print partner
7. Tracking number assignment
8. Shipment status updates
9. Delivery confirmation
10. Review request sent

### 32.2 Track Year Resolution
- Try Spotify year first
- Fall back to Discogs
- Use AI/ChatGPT analysis
- Check MusicBrainz
- Search Google
- Allow manual correction
- Track certainty/confidence level

### 32.3 User Suggestion Flow
- User suggests track correction
- Correction held for review deadline
- Admin approves/rejects
- Approved corrections applied to affected orders
- Affected orders finalized and PDF regenerated

### 32.4 Discount Application
- User enters code at checkout
- Code validated against:
  - Current date range
  - Usage count
  - Playlist restrictions
  - Digital/physical restrictions
- Amount applied to order total
- Tracked in discount_codes_uses

---

## 33. API RESPONSE PATTERNS

### 33.1 Success Response
```json
{
  "success": true,
  "data": {},
  "message": "Operation successful"
}
```

### 33.2 Error Response
```json
{
  "success": false,
  "error": "Error description",
  "statusCode": 400
}
```

### 33.3 Pagination Response
```json
{
  "data": [],
  "totalItems": 100,
  "currentPage": 1,
  "itemsPerPage": 10
}
```

---

## 34. NOTABLE TECHNICAL DECISIONS

### 34.1 Architecture Choices
- **Fastify over Express:** Better performance, built-in validation
- **Prisma ORM:** Type-safe database access
- **BullMQ for queues:** Redis-backed, job tracking, persistence
- **EJS templates:** Server-side rendering for PDFs
- **Mollie integration:** European payment preference
- **TrackingMore:** Multi-carrier tracking abstraction

### 34.2 Data Design
- **Composite IDs:** PaymentHasPlaylist uses (paymentId, playlistId)
- **Normalization:** Track data cached separately from playlist references
- **Versioning:** Multiple year sources stored (spotifyYear, discogsYear, etc.)
- **Soft deletion:** Payment records preserved even when user deleted

---

## 35. AUDIT & COMPLIANCE

### 35.1 Data Tracked
- User email, name, preferences
- Payment amounts and methods
- Order details and status
- IP addresses and user agents
- Review ratings and text
- Marketing email preferences
- Tax rates and shipping info

### 35.2 Compliance Features
- Newsletter opt-in/out
- Marketing email preferences
- CAPTCHA on user forms
- Data associated with user records
- Email verification before use
- Password security (PBKDF2 hash)

---

## 36. TECHNOLOGY STACK SUMMARY

| Component | Technology | Version |
|-----------|-----------|---------|
| Framework | Fastify | 5.6.1 |
| Language | TypeScript | 5.9.3 |
| Database | MySQL | - |
| ORM | Prisma | 6.18.0 |
| Queue | BullMQ | 5.61.2 |
| Cache | Redis | - |
| Auth | JWT | - |
| Email | AWS SES | - |
| Payments | Mollie | 4.3.3 |
| Push | Firebase | 13.5.0 |
| PDF | pdf-lib | 1.17.1 |
| Conversion | ConvertAPI | 1.15.0 |
| Image | Sharp | 0.34.4 |
| QR Code | qrcode | 1.5.4 |
| Shipping | TrackingMore SDK | 1.0.8 |
| Cron | cron | 4.3.3 |
| Rate Limit | Bottleneck | 2.19.5 |

---

## CONCLUSION

This QRHit/QRSong backend is a sophisticated, feature-rich e-commerce and content management platform with:

- **Complex order fulfillment** spanning physical goods, digital deliverables, and printing
- **Rich music integrations** with multiple metadata sources and music link resolution
- **B2B capabilities** (OnzeVibe voting system) alongside B2C retail
- **Multilingual support** across 11 languages
- **Enterprise features** including user roles, company management, and comprehensive reporting
- **Background job processing** with queue management and worker pools
- **Multi-provider integrations** for payments, shipping, email, and music data
- **Comprehensive admin dashboard** with analytics, order management, and system monitoring

The platform demonstrates mature engineering practices with proper error handling, rate limiting, queue management, and production-grade logging.

