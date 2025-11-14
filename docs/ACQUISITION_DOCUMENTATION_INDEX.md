# QRHit/QRSong Backend API - Acquisition Documentation Index

## Overview
This directory contains comprehensive technical documentation for the QRHit/QRSong backend API - a complete e-commerce platform for creating personalized QR code music cards.

---

## Documentation Files

### 1. **BACKEND_FEATURES_SUMMARY.txt** (Primary Document for Executives)
- **Purpose:** Executive-level overview of all backend capabilities
- **Length:** ~300 lines
- **Audience:** Acquisition team, business stakeholders, technical leads
- **Contents:**
  - Core statistics and metrics
  - 36 major feature categories
  - Critical business capabilities
  - Key integrations
  - Database schema highlights
  - Security architecture
  - Operational complexity metrics
  - Acquisition readiness assessment
  - Implementation estimates

**Start here for a high-level understanding of the system.**

---

### 2. **BACKEND_INVENTORY_ACQUISITION.md** (Technical Deep Dive)
- **Purpose:** Complete technical inventory for due diligence
- **Length:** 1064 lines
- **Audience:** Technical teams, system architects, developers
- **Contents:**
  - Detailed breakdown of all 36 feature categories
  - Every API endpoint documented
  - Database schema description
  - Service classes and their purposes
  - Integration documentation
  - Business logic explanation
  - Technology stack listing
  - Response patterns
  - Data models and relationships
  - Security implementation details

**Reference this document for all technical details.**

---

## Feature Categories Documented

1. Core Infrastructure & Architecture
2. Authentication & Authorization
3. Payment Processing (Mollie)
4. Product & Order Management
5. Printing & Production
6. Music Data & Integration
7. PDF & File Generation
8. Shipping & Fulfillment
9. Notification Systems
10. Analytics & Reporting
11. Queue & Job Processing
12. Background Jobs & Scheduling
13. Review & Rating System
14. Discount & Promotions
15. User Suggestions & Crowdsourcing
16. Card Designer & Customization
17. Blog & CMS System
18. Voting & Submission System (OnzeVibe)
19. Games System
20. Hitlist Voting System
21. Security & Protection
22. Third-Party Integrations
23. Multilingual Support
24. Account Management
25. System Administration
26. File Storage & Management
27. Development & Testing
28. Data Models & Relationships
29. Monitoring & Logging
30. Deployment & Infrastructure
31. Performance Optimizations
32. Business Rules
33. API Response Patterns
34. Technical Decisions
35. Audit & Compliance
36. Technology Stack

---

## Key Statistics

| Metric | Value |
|--------|-------|
| Backend Services | 72+ TypeScript classes |
| Total Code Lines | 33,653+ lines (services only) |
| Database Tables | 34+ tables |
| API Endpoints | 150+ endpoints |
| Routes Files | 7 route modules |
| Third-Party APIs | 10+ integrations |
| Scheduled Jobs | 10+ cron tasks |
| Supported Languages | 11 languages |
| Production Dependencies | 25+ |
| Development Dependencies | 15+ |

---

## Quick Reference: Major Components

### Route Modules
- **adminRoutes.ts** (1,863 lines) - Admin dashboard, orders, payments, queue management
- **accountRoutes.ts** (499 lines) - User auth, registration, password reset, account management
- **paymentRoutes.ts** (352 lines) - Payment processing, order status, PDF downloads
- **publicRoutes.ts** (619 lines) - Public-facing features, contact, newsletter, suggestions
- **musicRoutes.ts** (434 lines) - Spotify integration, track management, QR links
- **gameRoutes.ts** (169 lines) - Games system management
- **vibeRoutes.ts** (973 lines) - B2B voting system (OnzeVibe)

### Core Service Classes
- **mollie.ts** (1,304 lines) - Payment gateway integration
- **mail.ts** (1,724 lines) - Email system (AWS SES)
- **spotify.ts** (1,698 lines) - Music data integration
- **vibe.ts** (3,127 lines) - B2B voting/submission system
- **data.ts** (2,812 lines) - Core data operations
- **generator.ts** (1,401 lines) - PDF generation pipeline
- **shipping.ts** (1,187 lines) - Fulfillment & tracking
- **auth.ts** (952 lines) - Authentication & authorization
- **suggestion.ts** (1,203 lines) - User suggestion system
- **order.ts** (740 lines) - Order management
- And 25+ more service classes...

### Database Models
- **Core Business:** User, Payment, Playlist, Track, OrderType
- **E-Commerce:** PaymentHasPlaylist, PaymentHasPlaylistItem, DiscountCode, Review
- **B2B:** Company, CompanyList, CompanyListSubmission, CompanyListQuestion
- **Fulfillment:** ShippingCost, PrinterInvoice, TrustPilot
- **Content:** Blog, Genre, Track metadata
- **Infrastructure:** PushToken, PushMessage, AppSetting, Settings, UserGroup

---

## Business Capabilities Summary

### Revenue Streams
- Physical printed QR cards with customization
- Digital PDF downloads
- Sheet printing services
- B2B voting system (OnzeVibe)
- Games licensing
- Volume-based discounts

### Customer Segments
- B2C: Individual music enthusiasts
- B2B: Companies (OnzeVibe portal)
- Gamers: QRSong card game players

### Data Assets
- 1,000+ Spotify playlists
- 10,000+ tracks with multi-source year metadata
- Customer order history
- Review/rating data
- Shipping rates for 150+ countries
- Analytics & usage data

---

## Integration Partners

### Payment Processing
- **Mollie Payments** - Primary payment gateway (European focus)
- **Print & Bind API** - Print partner integration

### Music Metadata Sources
- **Spotify** - Primary music source (OAuth, API)
- **YouTube Music API** - Link resolution
- **Apple Music** - Link aggregation
- **Deezer, Amazon Music, Tidal** - Link resolution
- **MusicBrainz** - Release year verification
- **Discogs** - Year metadata
- **ISRC Database** - Track identification

### Cloud Services
- **AWS SES** - Email delivery
- **AWS EC2** - Hosting
- **AWS Lambda** - Serverless functions
- **Firebase Admin SDK** - Push notifications
- **Google APIs** - Merchant Center, OAuth

### Supporting Services
- **Trustpilot** - Customer review aggregation
- **TrackingMore** - Multi-carrier shipping tracking
- **ConvertAPI** - Document conversion
- **MaxMind** - GeoIP lookup
- **Sentry** - Error tracking

---

## Security Highlights

### Authentication
- JWT token-based with expiry
- Email/password (PBKDF2 with 10,000 iterations)
- Spotify OAuth
- Email verification required
- Password reset with token validation

### Authorization
- 5 role types (admin, vibeadmin, companyadmin, users, qrvoteadmin)
- Company-scoped data access
- Role-based endpoint protection

### Protective Measures
- CAPTCHA on forms
- Rate limiting
- IP tracking
- User agent logging
- Input sanitization
- CORS configuration
- Secure token handling

---

## Performance Characteristics

### Scaling Features
- Redis caching layer
- Database query optimization (35+ indexes)
- Full-text search indexes
- Pagination on all list endpoints
- Background job queue (BullMQ)
- Multi-worker clustering

### Async Processing
- PDF generation queue
- Email queue
- Excel processing queue
- Music link fetching queue
- Background image optimization

### Scheduled Tasks
- Hourly: Spotify sync, shipping updates
- Daily: Payment reconciliation, Trustpilot fetching
- Weekly: Invoice reconciliation
- Monthly: Tax reports

---

## Technology Stack

### Runtime & Framework
- Node.js (Runtime)
- Fastify 5.6.1 (Web framework)
- TypeScript 5.9.3 (Language)

### Database
- MySQL (Primary database)
- Prisma 6.18.0 (ORM)
- Redis (Cache layer)

### Job Processing
- BullMQ 5.61.2 (Queue system)
- cron 4.3.3 (Scheduling)

### External APIs
- @mollie/api-client 4.3.3 (Payments)
- firebase-admin 13.5.0 (Push notifications)
- axios 1.12.2 (HTTP client)
- googleapis 164.1.0 (Google services)

### Document Generation
- pdf-lib 1.17.1 (PDF manipulation)
- sharp 0.34.4 (Image optimization)
- convertapi 1.15.0 (Format conversion)
- ejs 3.1.10 (Template engine)

### Other Services
- jsonwebtoken 9.0.2 (JWT)
- exceljs 4.4.0 (Excel generation)
- qrcode 1.5.4 (QR code generation)
- sanitize-html 2.17.0 (HTML sanitization)
- trackingmore-sdk-nodejs 1.0.8 (Shipping tracking)

---

## Acquisition Assessment

### Strengths
- ✅ Well-organized, professional codebase
- ✅ Comprehensive feature set
- ✅ Multiple revenue streams
- ✅ Production-ready infrastructure
- ✅ Established integrations
- ✅ Enterprise-grade features (B2B system)
- ✅ Multilingual support (11 languages)
- ✅ Complete admin dashboard

### Considerations
- ⚠️ Large codebase (33,653+ lines)
- ⚠️ 10+ system interconnections
- ⚠️ Database migration complexity
- ⚠️ Multiple third-party dependencies
- ⚠️ Ongoing maintenance requirements

### Estimated Value
**Years to rebuild:** 2-3 full-stack engineers, 12-18 months
**Code quality:** Professional, production-ready
**Feature completeness:** 80%+ of typical e-commerce + B2B platform

---

## Using These Documents

### For Executive Review
1. Read: **BACKEND_FEATURES_SUMMARY.txt**
2. Focus on: Statistics, Business Capabilities, Integrations, Assessment sections
3. Time required: 15-20 minutes

### For Technical Due Diligence
1. Read: **BACKEND_INVENTORY_ACQUISITION.md**
2. Cross-reference with actual codebase: `/src/routes/`, `/src/` services
3. Review database schema: `prisma/schema.prisma`
4. Check integrations: `package.json`, environment variables
5. Time required: 2-3 hours

### For Implementation Planning
1. Review: Database Models & Relationships section
2. Study: Business Rules section
3. Examine: Cron Jobs & Scheduled Tasks
4. Plan: API migration strategy
5. Time required: 4-6 hours

### For Developer Onboarding
1. Start with: Technology Stack section
2. Review: Core Service Classes quick reference
3. Read: CLAUDE.md (project-specific guidelines)
4. Explore: src/routes/ directory structure
5. Study: Key integration flows
6. Time required: 8-12 hours for familiarity

---

## File Locations

```
/Users/rick/Sites/qrhit-api/
├── ACQUISITION_DOCUMENTATION_INDEX.md  (this file)
├── BACKEND_FEATURES_SUMMARY.txt         (executive summary)
├── BACKEND_INVENTORY_ACQUISITION.md     (detailed inventory)
├── CLAUDE.md                             (project guidelines)
├── package.json                          (dependencies)
├── prisma/
│   └── schema.prisma                     (database schema)
├── src/
│   ├── routes/                           (7 route modules)
│   ├── app.ts                            (core app file)
│   └── [72+ service classes]
└── [other infrastructure files]
```

---

## Questions Answered by This Documentation

**What does the system do?**
→ See BACKEND_FEATURES_SUMMARY.txt (sections 1-20)

**How much code is there?**
→ See "Key Statistics" in this document

**What are the business models?**
→ See BACKEND_INVENTORY_ACQUISITION.md (section 28)

**How does payment work?**
→ See BACKEND_INVENTORY_ACQUISITION.md (section 3)

**What third-party services are used?**
→ See BACKEND_INVENTORY_ACQUISITION.md (section 22)

**How is data stored?**
→ See BACKEND_INVENTORY_ACQUISITION.md (section 28)

**What are the security measures?**
→ See BACKEND_INVENTORY_ACQUISITION.md (section 21)

**How long would it take to rebuild?**
→ See "Estimated Value" in this document

**What are the potential risks?**
→ See "Acquisition Assessment" in this document

---

## Related Projects

### Frontend: QRSong! Main Application
- Location: `/Users/rick/Sites/qrhit`
- Framework: Angular 18
- Purpose: Public-facing QR code generation service
- See: `/Users/rick/Sites/qrhit/CLAUDE.md`

### Frontend: OnzeVibe Company Portal
- Location: `/Users/rick/Sites/qrhit-vibe`
- Framework: Angular 19
- Purpose: B2B voting portal
- See: `/Users/rick/Sites/qrhit-vibe/CLAUDE.md`

---

## Document Maintenance

**Last Updated:** 2025-11-06
**Document Version:** 1.0
**Codebase Reviewed:** /Users/rick/Sites/qrhit-api (main branch)
**Generated By:** Technical Assessment Team

For updates or corrections, maintain consistency between:
1. This index file
2. BACKEND_FEATURES_SUMMARY.txt
3. BACKEND_INVENTORY_ACQUISITION.md
4. Actual codebase

---

## Quick Links to Key Files

| File | Purpose | Lines |
|------|---------|-------|
| src/routes/adminRoutes.ts | Admin panel endpoints | 1,863 |
| src/mollie.ts | Payment processing | 1,304 |
| src/mail.ts | Email system | 1,724 |
| src/spotify.ts | Music integration | 1,698 |
| src/vibe.ts | B2B voting system | 3,127 |
| src/data.ts | Core data layer | 2,812 |
| prisma/schema.prisma | Database schema | 858 |
| package.json | Dependencies | 101 |

---

**End of Index**

For more information, refer to the detailed documentation files or examine the source code directly.
