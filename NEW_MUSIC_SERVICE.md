# Adding a New Music Service

Complete guide for integrating a new music streaming service into QRSong.

## Quick Reference - All Files to Touch

### Backend (qrhit-api) - 12 files

| # | File | Action |
|---|------|--------|
| 1 | `src/enums/ServiceType.ts` | Add enum + display name |
| 2 | `src/providers/[Service]Provider.ts` | **Create** - implement IMusicProvider |
| 3 | `src/providers/MusicProviderFactory.ts` | Add switch case |
| 4 | `src/providers/index.ts` | Export provider |
| 5 | `src/services/MusicServiceRegistry.ts` | Register in constructor |
| 6 | `src/[service]_api.ts` | **Create** - API wrapper (if needed) |
| 7 | `src/routes/musicRoutes.ts` | Add routes + update qrlink_unknown endpoint |
| 8 | `src/spotify.ts` | Update resolveSpotifyUrl return type |
| 9 | `src/data.ts` | Add to serviceLinkFieldMap (~line 1852) |
| 10 | `src/settings.ts` | Add SettingKey types (if OAuth) |
| 11 | `src/musicfetch.ts` | Add link field mappings |
| 12 | `.env` | Add credentials |

### Frontend (qrhit) - 17 files

| # | File | Action |
|---|------|--------|
| 1 | `src/enums/MusicServiceType.ts` | Add enum + display name |
| 2 | `src/interfaces/IMusicService.ts` | Add to MUSIC_SERVICE_CONFIGS |
| 3 | `src/services/[service].service.ts` | **Create** - implement IMusicService |
| 4 | `src/services/music-service.factory.ts` | Inject & register |
| 5 | `src/app/[service]-callback/` | **Create** - OAuth callback (if OAuth) |
| 6 | `src/app/app.routes.ts` | Add callback route (if OAuth) |
| 7 | `src/app/home/home.component.html` | Add service icon to supported platforms |
| 8 | `src/app/select-playlist/...html` | Add service logo (light + dark versions) |
| 9 | `src/app/select-playlist/...ts` | Handle shortlinks (if service has shortlinks) |
| 10 | `src/app/summary/summary.component.ts` | Add service methods & inject service |
| 11 | `src/app/year-check/year-check.component.ts` | Add to serviceConfig |
| 12 | `src/app/tracks/tracks.component.html` | Add service icon column (header + body) |
| 13 | `src/app/admin-missing-spotify/...html` | Add service icon column (header + body) |
| 14 | `src/app/shared/link-coverage/link-coverage.component.ts` | Add service to services array |
| 15 | `src/app/shared/supported-platforms-table/...ts` | Add service to platforms array |
| 16 | `src/assets/i18n/en.json` | Add translations |
| 17 | `src/assets/images/service-logos/` | **Create** - logo PNGs (light + dark) |
| 18 | `src/environments/environment.ts` | Add clientId (if OAuth) |
| 19 | `src/environments/environment.prod.ts` | Add clientId (if OAuth) |

---

## Step-by-Step Implementation

### BACKEND

#### Step 1: ServiceType Enum
**File:** `src/enums/ServiceType.ts`
```typescript
export enum ServiceType {
  // existing...
  NEW_SERVICE = 'new_service',
}

export const ServiceTypeDisplayNames: Record<ServiceType, string> = {
  // existing...
  [ServiceType.NEW_SERVICE]: 'New Service',
};
```

#### Step 2: Create Provider
**File:** `src/providers/NewServiceProvider.ts`

```typescript
import { ServiceType } from '../enums/ServiceType';
import { IMusicProvider, MusicProviderConfig, ... } from '../interfaces/IMusicProvider';

class NewServiceProvider implements IMusicProvider {
  private static instance: NewServiceProvider;

  readonly serviceType = ServiceType.NEW_SERVICE;
  readonly config: MusicProviderConfig = {
    serviceType: ServiceType.NEW_SERVICE,
    displayName: 'New Service',
    supportsOAuth: true/false,
    supportsPublicPlaylists: true/false,
    supportsSearch: true/false,
    supportsPlaylistCreation: false,
    brandColor: '#HEXCOLOR',
    iconClass: 'fa-icon',
  };

  public static getInstance(): NewServiceProvider {
    if (!NewServiceProvider.instance) {
      NewServiceProvider.instance = new NewServiceProvider();
    }
    return NewServiceProvider.instance;
  }

  validateUrl(url: string): UrlValidationResult { /* regex patterns */ }
  extractPlaylistId(url: string): string | null { /* extract from URL */ }
  async getPlaylist(playlistId: string): Promise<ApiResult & { data?: ProviderPlaylistData }> { }
  async getTracks(playlistId: string): Promise<ApiResult & { data?: ProviderTracksResult }> { }

  // OAuth methods (if needed)
  getAuthorizationUrl(): string | null { }
  async handleAuthCallback(code: string): Promise<ApiResult & { data?: { accessToken: string } }> { }
}

export default NewServiceProvider;
```

#### Step 3: Register in Factory
**File:** `src/providers/MusicProviderFactory.ts`

```typescript
import NewServiceProvider from './NewServiceProvider';

getProvider(serviceType?: string): IMusicProvider {
  switch (serviceType) {
    // existing cases...
    case ServiceType.NEW_SERVICE:
      return NewServiceProvider.getInstance();
    default:
      return SpotifyProvider.getInstance();
  }
}

isSupported(serviceType: string): boolean {
  return [...existing, ServiceType.NEW_SERVICE].includes(serviceType as ServiceType);
}
```

#### Step 4: Export Provider
**File:** `src/providers/index.ts`
```typescript
export { default as NewServiceProvider } from './NewServiceProvider';
```

#### Step 5: Register in Registry
**File:** `src/services/MusicServiceRegistry.ts`
```typescript
import { NewServiceProvider } from '../providers';

constructor() {
  // existing...
  this.registerProvider(NewServiceProvider.getInstance());
}
```

#### Step 6: Add Routes
**File:** `src/routes/musicRoutes.ts`

```typescript
// OAuth (if needed)
fastify.get('/new-service/auth', async () => {
  return { success: true, authUrl: provider.getAuthorizationUrl() };
});

fastify.post('/new-service/callback', async (request) => {
  const { code } = request.body;
  return await provider.handleAuthCallback(code);
});

// Data routes
fastify.post('/new-service/playlists', async (request) => {
  const { playlistId, url } = request.body;
  // Extract ID and fetch
});

fastify.post('/new-service/playlists/tracks', async (request) => {
  // Similar pattern
});
```

#### Step 7: Update Data Layer
**File:** `src/data.ts` (~line 1852)
```typescript
const serviceLinkFieldMap: Record<string, string> = {
  spotify: 'spotifyLink',
  youtube_music: 'youtubeMusicLink',
  tidal: 'tidalLink',
  new_service: 'newServiceLink',  // ADD
};
```

#### Step 8: Update QRLink Unknown Endpoint
**File:** `src/routes/musicRoutes.ts` (qrlink_unknown endpoint ~line 666)

The `/qrlink_unknown` endpoint is used when scanning QR codes from external cards (Jumbo, Country, MusicMatch). It resolves unknown URLs and returns all available music service links.

When adding a new service, ensure the endpoint returns the new link field:
```typescript
// In the qrlink_unknown endpoint response
reply.send({
  success: true,
  spotifyUri: result.spotifyUri,
  link: result.links?.spotifyLink || null,
  am: result.links?.appleMusicLink || null,
  td: result.links?.tidalLink || null,
  ym: result.links?.youtubeMusicLink || null,
  dz: result.links?.deezerLink || null,
  az: result.links?.amazonMusicLink || null,
  ns: result.links?.newServiceLink || null,  // ADD new service
});
```

Also update the `resolveSpotifyUrl` method in `src/spotify.ts` to include the new link field in its return type and mapping.

#### Step 9: Update MusicFetch
**File:** `src/musicfetch.ts`

```typescript
// Line ~13 - Interface
interface TrackLinks {
  // existing...
  newServiceLink?: string | null;
}

// Line ~42 - Field map
const serviceFieldMap = {
  // existing...
  newServiceLink: 'newService',
};

// Line ~52 - Link fields array
const linkFields = [...existing, 'newServiceLink'];

// Line ~115 - API services param
services: 'spotify,deezer,youtubeMusic,appleMusic,amazonMusic,tidal,newService',

// Line ~135 - Result mapping
newServiceLink: services.newService?.link || null,

// Throughout - Add to select/where clauses
```

#### Step 9: Settings (if OAuth)
**File:** `src/settings.ts`
```typescript
export type SettingKey =
  // existing...
  | 'new_service_access_token'
  | 'new_service_refresh_token'
  | 'new_service_token_expires_at';
```

#### Step 10: Environment
**File:** `.env`
```
NEW_SERVICE_CLIENT_ID=xxx
NEW_SERVICE_CLIENT_SECRET=xxx
NEW_SERVICE_REDIRECT_URI=https://api.qrsong.io/new-service/callback
```

---

### FRONTEND

#### Step 11: MusicServiceType Enum
**File:** `src/enums/MusicServiceType.ts`
```typescript
export enum MusicServiceType {
  // existing...
  NEW_SERVICE = 'new_service',
}

export const ServiceTypeDisplayNames = {
  // existing...
  [MusicServiceType.NEW_SERVICE]: 'New Service',
};
```

#### Step 12: Service Config
**File:** `src/interfaces/IMusicService.ts`
```typescript
export const MUSIC_SERVICE_CONFIGS: Record<MusicServiceType, MusicServiceConfig> = {
  // existing...
  [MusicServiceType.NEW_SERVICE]: {
    serviceType: MusicServiceType.NEW_SERVICE,
    displayName: 'New Service',
    requiresOAuth: true/false,
    brandColor: '#HEXCOLOR',
    iconClass: 'fa-icon',
    supportsYearData: true/false,
  },
};
```

#### Step 13: Create Service
**File:** `src/services/new-service.service.ts`

```typescript
@Injectable({ providedIn: 'root' })
export class NewServiceService implements IMusicService {
  readonly serviceType = MusicServiceType.NEW_SERVICE;
  readonly config = MUSIC_SERVICE_CONFIGS[MusicServiceType.NEW_SERVICE];

  private readonly urlPatterns = {
    playlist: /regex-pattern/i,
    shortlink: /^https?:\/\/(link\.newservice\.com|newservice\.page\.link)\//i, // if service has shortlinks
  };

  isConnected(): boolean { /* check localStorage */ }
  validateUrl(url: string): UrlValidationResult { }
  extractPlaylistId(url: string): string | null { }
  async getPlaylist(playlistId: string, ...): Promise<Playlist | null> { }
  async getTracks(playlistId: string, ...): Promise<TracksResult | null> { }

  // Shortlink resolution (if service has shortlinks)
  async resolveShortlink(url: string): Promise<string | null> {
    const response = await this.http.post<any>(`${environment.apiEndpoint}/new-service/resolve-shortlink`, { url });
    return response.data?.resolvedUrl || null;
  }

  // OAuth methods (if needed)
  getAuthorizeUri(): string { }
  async authorize(code: string): Promise<void> { }
  discardTokens(): void { }
}
```

#### Step 14: Register in Factory
**File:** `src/services/music-service.factory.ts`
```typescript
constructor(
  // existing...
  private newServiceService: NewServiceService
) {
  this.services.set(MusicServiceType.NEW_SERVICE, newServiceService);
}
```

#### Step 15: OAuth Callback (if needed)
**Create:** `src/app/new-service-callback/new-service-callback.component.ts`

```typescript
@Component({
  selector: 'app-new-service-callback',
  template: '<p>Connecting...</p>',
  standalone: true
})
export class NewServiceCallbackComponent implements OnInit {
  async ngOnInit() {
    const code = this.route.snapshot.queryParams['code'];
    if (code) {
      await this.newServiceService.authorize(code);
      this.router.navigate(['/', this.lang, 'generate', 'playlist']);
    }
  }
}
```

#### Step 16: Add Route (if OAuth)
**File:** `src/app/app.routes.ts`
```typescript
{
  path: 'newservice_callback',
  loadComponent: () => import('./new-service-callback/new-service-callback.component')
    .then(m => m.NewServiceCallbackComponent)
}
```

#### Step 17: Update Select-Playlist HTML
**File:** `src/app/select-playlist/select-playlist.component.html`
```html
<div class="...">
  <img src="assets/images/service-logos/newservice.png" alt="New Service" class="h-5 sm:h-6">
</div>
```

#### Step 18: Handle Shortlinks in Select-Playlist (if service has shortlinks)
**File:** `src/app/select-playlist/select-playlist.component.ts`

1. Import the service:
```typescript
import { NewServiceService } from '../../services/new-service.service';
```

2. Inject in constructor:
```typescript
constructor(
  // existing...
  private newService: NewServiceService,
) {}
```

3. Add shortlink handling (after existing Spotify/Deezer shortlink handling):
```typescript
// Handle New Service shortlinks that need resolution
if (!playlistId && serviceType === MusicServiceType.NEW_SERVICE) {
  try {
    const parsedUrl = new URL(decodedUrl);
    if (parsedUrl.hostname === 'link.newservice.com' || parsedUrl.hostname === 'newservice.page.link') {
      console.log('[new_service] Resolving shortlink:', decodedUrl);
      const resolvedUrl = await this.newService.resolveShortlink(decodedUrl);
      if (resolvedUrl) {
        console.log('[new_service] Shortlink resolved to:', resolvedUrl);
        const resolvedExtraction = this.musicServiceFactory.extractPlaylistId(resolvedUrl);
        if (resolvedExtraction) {
          playlistId = resolvedExtraction.playlistId;
        }
      }
    }
  } catch (e) {
    // Not a URL, might be a bare ID
  }
}
```

#### Step 19: Update Summary Component
**File:** `src/app/summary/summary.component.ts`

1. Import the service:
```typescript
import { NewServiceService } from '../../services/new-service.service';
```

2. Inject in constructor:
```typescript
constructor(
  // existing...
  private newServiceService: NewServiceService,
) {}
```

3. Add service handling to all service methods:
```typescript
// In getPlaylistForService()
if (this.serviceType === MusicServiceType.NEW_SERVICE) {
  return this.newServiceService.getPlaylist(playlistId, cache, featured, isSlug);
}

// In getTracksForService()
if (this.serviceType === MusicServiceType.NEW_SERVICE) {
  return this.newServiceService.getTracks(playlistId, cache, isSlug);
}

// In getOrderTypeForService()
if (this.serviceType === MusicServiceType.NEW_SERVICE) {
  return this.newServiceService.getOrderType(trackCount, digital, playlistId, subType);
}

// In constructServicePlaylistUrl()
if (this.serviceType === MusicServiceType.NEW_SERVICE) {
  return `https://www.newservice.com/playlist/${this.playlistId}`;
}

// In getTrackUriScheme()
if (this.serviceType === MusicServiceType.NEW_SERVICE) {
  return `https://www.newservice.com/track/${trackId}`;
}
```

#### Step 20: Update Year-Check
**File:** `src/app/year-check/year-check.component.ts`
```typescript
private readonly serviceConfig = {
  // existing...
  new_service: { icon: 'fas fa-icon', name: 'New Service', color: 'text-color-500' },
};
```

#### Step 21: Update Admin Tracks Component
**Files:**
- `src/app/tracks/tracks.component.ts`
- `src/app/tracks/tracks.component.html`

The tracks component (`/dashboard/tracks`) has:
- A table with per-service icon columns (header + body cells with search buttons)
- A service search modal that searches each provider's API
- Filter chips to show tracks missing links for a specific service
- An edit modal with URL fields for each service

**tracks.component.ts** - Update these sections:

1. Add to `serviceFilters` array:
```typescript
serviceFilters = [
  // existing...
  { key: 'newservice', icon: 'fab fa-newservice', color: '#BRANDCOLOR', label: 'New Service' },
];
```

2. Add to `searchableServices` array (if the provider supports search):
```typescript
private searchableServices = ['spotify', 'youtube', 'deezer', 'apple', 'tidal', 'newservice'];
```

3. Add to `serviceColumnMap`:
```typescript
private serviceColumnMap: Record<string, keyof Track> = {
  // existing...
  newservice: 'newServiceLink',
};
```

4. Add `newServiceLink` to the `Track` interface.

**tracks.component.html** - Update these sections:

1. Add icon column header (after existing service icons):
```html
<th class="px-2 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 w-12">
  <i class="fab fa-newservice fa-lg text-[#BRANDCOLOR]"></i>
</th>
```

2. Add icon column body cell with search button:
```html
<td class="px-2 py-4 whitespace-nowrap text-center">
  <i *ngIf="track.newServiceLink" class="fab fa-newservice fa-lg text-[#BRANDCOLOR]"></i>
  <button *ngIf="!track.newServiceLink"
    (click)="openServiceSearchModal(track, 'newservice'); $event.stopPropagation()"
    class="w-8 h-8 inline-flex items-center justify-center rounded border border-gray-300 dark:border-gray-600 text-gray-400 hover:text-[#BRANDCOLOR] hover:border-[#BRANDCOLOR] transition-colors"
    title="Search New Service">
    <i class="fas fa-search text-xs"></i>
  </button>
</td>
```

3. Add the URL field to the edit modal form.
4. Update the `colspan` on the "No tracks found" row.
5. Add the field to `validateUrls()` and `saveTrack()` payload.

#### Step 22: Update Admin Missing Spotify Table
**File:** `src/app/admin-missing-spotify/admin-missing-spotify.component.html`

Add icon column header and body cell (same pattern as tracks table above).

**Note:** Both admin tables show which music service links exist for each track. When adding a new service, you need to:
1. Add the icon column to the table header
2. Add the icon column to the table body
3. Update the Track interface to include `newServiceLink`
4. Add the field to the edit modal form
5. Update the colspan on "No tracks found" rows if needed

#### Step 23: Translations
**File:** `src/assets/i18n/en.json`
```json
{
  "submit": {
    "invalidNewServiceUrl": "The link you provided appears to be a [Service] link, but it is not a playlist."
  }
}
```

Then run:
```bash
./_scripts/remove-from-cache.sh submit.invalidNewServiceUrl
```

#### Step 22: Update Supported Platforms Table Component
**File:** `src/app/shared/supported-platforms-table/supported-platforms-table.component.ts`

Add the new service to the `platforms` array:
```typescript
platforms = [
  // existing...
  {
    name: 'New Service',
    logo: 'assets/images/service-logos/newservice.png',
    logoDark: 'assets/images/service-logos/newservice-dark.png', // or null if no dark version needed
    playlists: true,
    years: true,  // or 'ai' if the service doesn't provide year data
    hiddenPlayback: false  // only Spotify supports hidden playback currently
  }
];
```

**Note:** This component is used in:
- The "Supported Platforms" modal in `select-playlist.component.html`
- The dedicated `/supported-platforms` page

#### Step 23: Update Link Coverage Component
**File:** `src/app/shared/link-coverage/link-coverage.component.ts`

Add the new service to the `services` array in the `buildServicesDisplay()` method:
```typescript
this.services = [
  // existing...
  {
    key: 'newService',  // must match the API response field name
    name: 'New Service',
    logo: 'assets/images/service-logos/newservice.png',
    logoDark: 'assets/images/service-logos/newservice-dark.png',
    percentage: this.coverage.newService
  }
];
```

Also update the `LinkCoverage` interface at the top of the file to include the new service field.

**Note:** This component displays the percentage of tracks in a featured playlist that have direct links to each music service. The data comes from the API endpoint `/playlist/:id/link-coverage` which queries the database for link coverage stats.

#### Step 24: Service Logos
**Create:** `src/assets/images/service-logos/`
- `newservice.png` - Light mode logo (brand color text on transparent, ~240px width)
- `newservice-dark.png` - Dark mode logo (white text on transparent, same dimensions)

Both logos should have:
- Transparent background
- ~240px width (height varies by aspect ratio)
- Light mode: Brand color text (visible on white background)
- Dark mode: White text (visible on dark background)

**Creating logos with ImageMagick:**
```bash
cd src/assets/images/service-logos

# Light mode - brand color text on transparent background
magick -size 240x50 xc:transparent \
  -font "Helvetica-Bold" -pointsize 28 \
  -fill '#BRANDCOLOR' \
  -gravity center -annotate +0+0 "Service Name" \
  -trim +repage \
  newservice.png

# Dark mode - white text on transparent background
magick -size 240x50 xc:transparent \
  -font "Helvetica-Bold" -pointsize 28 \
  -fill '#FFFFFF' \
  -gravity center -annotate +0+0 "Service Name" \
  -trim +repage \
  newservice-dark.png
```

**Note:** Replace `#BRANDCOLOR` with the service's brand color (e.g., `#FA243C` for Apple Music, `#1DB954` for Spotify).

**Update select-playlist.component.html:**
```html
<div class="px-4 py-2 bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700">
    <img src="assets/images/service-logos/newservice.png" alt="New Service" class="h-5 sm:h-6 dark:hidden">
    <img src="assets/images/service-logos/newservice-dark.png" alt="New Service" class="h-5 sm:h-6 hidden dark:block">
</div>
```

**Update home.component.html** (add icon to supported platforms section):
```html
<i class="fab fa-newservice text-3xl text-[#BRANDCOLOR]" title="New Service"></i>
<!-- Or use SVG if no FontAwesome icon exists -->
```

#### Step 23: Environment (if OAuth)
**Files:** `src/environments/environment.ts` and `environment.prod.ts`
```typescript
newServiceClientId: 'your-client-id',
```

#### Step 24: Update FAQ
**File:** `src/assets/i18n/en.json`

Update the `faq.supportedPlatformsAnswer` to include the new service:
```json
{
  "faq": {
    "supportedPlatformsAnswer": "QRSong! supports playlists from <strong>Spotify</strong>, <strong>YouTube Music</strong>, <strong>Tidal</strong>, <strong>Deezer</strong>, and <strong>New Service</strong>. Simply paste the URL of your public playlist from any of these services, and we'll generate your QR music cards. Each service has its own URL format, but our system automatically recognizes and processes them all."
  }
}
```

Then run:
```bash
./_scripts/remove-from-cache.sh faq.supportedPlatformsAnswer
```

#### Step 25: Update Homepage Translations
**File:** `src/assets/i18n/en.json`

Update the homepage translations that mention music services:

1. **`home.subtitle`** - The hero section description mentions which services are supported
2. **`home.feat1Desc`** - The "Personalized Music Experience" feature description

Both should list all supported services with a link to the supported platforms page:
```json
{
  "home": {
    "subtitle": "...Choose your favorite songs from Spotify, Apple Music, YouTube Music <a href='/{{lang}}/supported-platforms' class='underline hover:text-gray-200'>and more</a>...",
    "feat1Desc": "Create a custom set of up to 3000 cards from your Spotify, Apple Music, YouTube Music, Tidal or Deezer playlists (<a href='/{{lang}}/supported-platforms' class='text-primary-600 hover:text-primary-700 underline'>see all platforms</a>)..."
  }
}
```

Then run:
```bash
./_scripts/remove-from-cache.sh home.subtitle home.feat1Desc
```

---

## WebSocket Progress Reporting

For long-running playlist fetches, providers should report progress via WebSocket. This allows the frontend to show a progress indicator when fetching large playlists.

### Provider Implementation

1. **Update getTracks signature** to accept an optional `ProgressCallback`:
```typescript
import { ProgressCallback } from '../interfaces/IMusicProvider';

async getTracks(
  playlistId: string,
  cache: boolean = true,
  maxTracks?: number,
  onProgress?: ProgressCallback
): Promise<ApiResult & { data?: ProviderTracksResult }> {
  // ... implementation
}
```

2. **Report progress during pagination loops**:
```typescript
// For providers with unknown total (use log-scale progress)
if (onProgress) {
  const percentage = Math.min(95, Math.round(50 * Math.log10(allTracks.length + 10) - 25));
  onProgress({
    stage: 'fetching_metadata',
    current: allTracks.length,
    total: null,
    percentage: Math.max(1, percentage),
    message: 'progress.loaded',  // Translation key for frontend
  });
}

// For providers with known total (use linear progress)
if (onProgress) {
  const percentage = Math.round((current / total) * 100);
  onProgress({
    stage: 'fetching_metadata',
    current: current,
    total: total,
    percentage: percentage,
    message: 'progress.loaded',
  });
}
```

3. **For two-step fetches** (like Tidal which gets IDs first, then metadata):
```typescript
// Step 1: Fetching IDs (0-30%)
if (onProgress) {
  const step1Progress = Math.min(30, Math.round(15 * Math.log10(allIds.length + 10) - 10));
  onProgress({
    stage: 'fetching_ids',
    current: allIds.length,
    total: null,
    percentage: Math.max(1, step1Progress),
    message: 'progress.fetchingIds',
  });
}

// Step 2: Fetching metadata (30-100%)
if (onProgress) {
  const step2Progress = 30 + Math.round((processed / total) * 70);
  onProgress({
    stage: 'fetching_metadata',
    current: processed,
    total: total,
    percentage: step2Progress,
    message: 'progress.fetchingMetadata',
  });
}
```

### Route Implementation

Update the service route to pass progress callbacks and broadcast via WebSocket:

```typescript
import ProgressWebSocketServer from '../progress-websocket';
import { ServiceType } from '../enums/ServiceType';

// In the /playlists/tracks route handler:
const progressWs = ProgressWebSocketServer.getInstance();

const onProgress = progressWs
  ? (progress: { stage: string; current: number; total: number | null; percentage: number; message?: string }) => {
      progressWs.broadcastProgress(playlistId, ServiceType.NEW_SERVICE, {
        stage: progress.stage as 'fetching_ids' | 'fetching_metadata',
        percentage: progress.percentage,
        message: progress.message,
        current: progress.current,
        total: progress.total ?? undefined,
      });
    }
  : undefined;

const result = await provider.getTracks(playlistId, cache, undefined, onProgress);

// Broadcast completion or error
if (progressWs) {
  if (result.success && result.data) {
    progressWs.broadcastComplete(playlistId, ServiceType.NEW_SERVICE, {
      trackCount: result.data.tracks.length,
    });
  } else {
    progressWs.broadcastError(playlistId, ServiceType.NEW_SERVICE, result.error);
  }
}
```

### WebSocket Message Format

The WebSocket server sends messages in this format:
```typescript
interface ProgressMessage {
  type: 'connected' | 'progress' | 'complete' | 'error';
  playlistId: string;
  serviceType: string;
  data: {
    stage?: 'fetching_ids' | 'fetching_metadata';
    percentage: number;      // 0-100
    message?: string;        // Translation key (e.g., 'progress.loaded')
    current?: number;        // Current count
    total?: number;          // Total count (if known)
    trackCount?: number;     // Final count (on complete)
    error?: string;          // Error message (on error)
  };
}
```

### Frontend Translation Keys

Add these translation keys in `en.json`:
```json
{
  "progress": {
    "fetchingIds": "Finding tracks...",
    "fetchingMetadata": "Loading track details...",
    "loaded": "Loaded {{current}} tracks..."
  }
}
```

---

## Redis Rate Limiting

For services with strict rate limits (like Tidal), use Redis-based rate limiting to coordinate across all workers/nodes. This prevents hitting rate limits when multiple users fetch playlists simultaneously.

### Implementation

1. **Add rate limit constants** in the provider:
```typescript
const SERVICE_RATE_LIMIT_KEY = 'new_service_api';
const SERVICE_MAX_REQUESTS = 25; // Max requests per window
const SERVICE_WINDOW_MS = 60000; // 1 minute window
```

2. **Create rate limit helper method**:
```typescript
private async applyRateLimit(): Promise<void> {
  await this.cache.slidingWindowRateLimit(
    SERVICE_RATE_LIMIT_KEY,
    SERVICE_MAX_REQUESTS,
    SERVICE_WINDOW_MS
  );
}
```

3. **Apply before API calls**:
```typescript
// Before each API call
await this.applyRateLimit();
const result = await this.serviceApi.getData();
```

The `slidingWindowRateLimit` method in `cache.ts`:
- Uses Redis sorted sets to track request timestamps
- Works across all workers/nodes
- Automatically waits when rate limit is reached
- Cleans up old entries outside the time window

---

## Normalized Track Data Format

All providers must return tracks in this format:

```typescript
{
  id: string;              // Service-specific track ID
  name: string;            // Track title (cleaned)
  artist: string;          // Primary artist name
  artistsList?: string[];  // All artist names
  album: string;           // Album name
  albumImageUrl: string;   // Cover art URL
  releaseDate: string;     // ISO format (YYYY-MM-DD) or null
  isrc?: string;           // International Standard Recording Code
  previewUrl?: string;     // Audio preview URL (if available)
  duration?: number;       // Duration in milliseconds
  serviceType: ServiceType;
  serviceLink: string;     // Direct link to track
}
```

---

## Cache Key Patterns

```typescript
const CACHE_KEY_PLAYLIST = '[service]_playlist_';  // TTL: 3600s (1 hour)
const CACHE_KEY_TRACKS = '[service]_tracks_';      // TTL: 3600s (1 hour)
const CACHE_KEY_SEARCH = '[service]_search_';      // TTL: 1800s (30 min)
```

---

## Checklist

### Backend
- [ ] Add to `ServiceType` enum
- [ ] Create Provider class
- [ ] Add to `MusicProviderFactory` switch
- [ ] Export from `providers/index.ts`
- [ ] Register in `MusicServiceRegistry`
- [ ] Add routes in `musicRoutes.ts`
- [ ] Add to `serviceTypeMap` in `adminRoutes.ts` `/tracks/service-search` route (if provider supports search)
- [ ] Update `data.ts` serviceLinkFieldMap
- [ ] Update `qrlink_unknown` endpoint response in `musicRoutes.ts`
- [ ] Update `resolveSpotifyUrl` return type in `spotify.ts`
- [ ] Update `musicfetch.ts` link fields
- [ ] Add Settings keys (if OAuth)
- [ ] Add `.env` variables

### Frontend
- [ ] Add to `MusicServiceType` enum
- [ ] Add to `MUSIC_SERVICE_CONFIGS`
- [ ] Create service class (with shortlink patterns if needed)
- [ ] Register in `music-service.factory.ts`
- [ ] Create OAuth callback (if OAuth)
- [ ] Add callback route (if OAuth)
- [ ] Update `select-playlist.component.html` (add logo)
- [ ] Handle shortlinks in `select-playlist.component.ts` (if service has shortlinks)
- [ ] Update `summary.component.ts` (inject service, add to all service methods)
- [ ] Update `year-check.component.ts`
- [ ] Update `tracks.component.ts` (add to serviceFilters, searchableServices, serviceColumnMap, Track interface)
- [ ] Update `tracks.component.html` (add icon column with search button + edit modal field)
- [ ] Update `admin-missing-spotify.component.html` (add icon column + edit modal field)
- [ ] Update `link-coverage.component.ts` (add service to services array + interface)
- [ ] Update `supported-platforms-table.component.ts` (add service to platforms array)
- [ ] Add translations
- [ ] Run `remove-from-cache.sh`
- [ ] Add service logos (light + dark versions)
- [ ] Add icon to `home.component.html` supported platforms section
- [ ] Update FAQ `supportedPlatformsAnswer` in `en.json` to include new service

### External Cards (Admin Dashboard)
- [ ] Update `admin-external-cards.component.html` - add icon column header and body cell
- [ ] Update `admin-external-cards.component.ts` - add field to ExternalCard interface
- [ ] Update `prisma/schema.prisma` - add `newServiceLink` field to ExternalCard model
- [ ] Update `musicfetch.ts` - add field to `processSingleExternalCard` and `updateExternalCardWithLinks` methods

### Testing
- [ ] URL validation works for all formats
- [ ] Playlist metadata loads
- [ ] Tracks load with all fields
- [ ] OAuth flow works (if applicable)
- [ ] Year-check shows correct icon
- [ ] Payment flow uses correct provider
- [ ] Caching works correctly
