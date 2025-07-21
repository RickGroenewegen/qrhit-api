# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development Commands
- `npm run start:dev` - Start development server with TypeScript watch mode and nodemon
- `npm run start:dev2` - Alternative development server using tsx watch
- `npm run build` - Build TypeScript to JavaScript (outputs to ./build)
- `npm run start` - Build and start production server
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