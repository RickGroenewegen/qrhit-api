# Google Merchant Center Integration

This module integrates QRSong featured playlists with Google Merchant Center for Google Shopping.

It uses the **Merchant API** (`merchantapi.googleapis.com`). Google discontinued
the Content API for Shopping on 18 August 2026; this integration was migrated
off it. See [Migration notes](#migration-notes-content-api--merchant-api) below.

## Setup

### Prerequisites

1. **Google Merchant Center Account**: Create an account at https://merchants.google.com
2. **Service Account**: Create a service account in Google Cloud Console
3. **API Access**: Enable the Merchant API

### Environment Variables

Add the following to your `.env` file:

```env
# Google Merchant Center Configuration
GOOGLE_MERCHANT_ID=your_merchant_id
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=path/to/service-account-key.json

# Optional: pin the API data source products are written to. Accepts a bare id
# ("104628") or a full resource name ("accounts/123/dataSources/104628").
# When unset, the service finds the data source named "QRSong! API feed" and
# creates it on first run if the account has none.
# GOOGLE_MERCHANT_DATASOURCE=
```

### Data Sources

Unlike the Content API, every Merchant API product write must name a data
source. The service resolves one at startup:

1. `GOOGLE_MERCHANT_DATASOURCE` if set.
2. Otherwise the existing primary data source called **QRSong! API feed**.
3. Otherwise it creates that data source (no `feedLabel` / `contentLanguage`,
   so a single source accepts every locale-country combination we publish).

Only products in *our* data source are touched. Anything supplied by another
feed is left alone, including by the cleanup pass.

### How to Get Your GOOGLE_MERCHANT_ID

1. **Sign up for Google Merchant Center**:
   - Go to https://merchants.google.com
   - Sign in with your Google account
   - Click "Get started" if you don't have an account yet

2. **Find your Merchant ID**:
   - Once logged in, your Merchant ID is displayed in the top-right corner of the dashboard
   - It's also visible in the URL: `https://merchants.google.com/mc/accounts/{MERCHANT_ID}`
   - The Merchant ID is a numerical value (e.g., `123456789`)

3. **Alternative method**:
   - Go to Settings (gear icon) in Merchant Center
   - Click on "Business information"
   - Your Merchant ID will be displayed at the top of the page

### How to Get Google Service Account Credentials

#### Step 1: Create a Google Cloud Project
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Select a project" dropdown at the top
3. Click "New Project"
4. Name your project (e.g., "QRSong Merchant Center")
5. Click "Create"

#### Step 2: Enable the Merchant API
1. **Direct link**: Go to https://console.developers.google.com/apis/api/merchantapi.googleapis.com/overview?project=YOUR_PROJECT_ID
   - Replace YOUR_PROJECT_ID with your actual project ID
   - Or use the link from the error message if you get one
2. **Alternative method**:
   - In Google Cloud Console, go to "APIs & Services" > "Library"
   - Search for "Merchant API"
   - Click on it and press "Enable"
3. **Important**: Wait 2-5 minutes after enabling for the API to be fully activated
4. If you see an error about billing:
   - You may need to enable billing for your Google Cloud project
   - Go to "Billing" in the console and set up a billing account
   - The Merchant API has generous free quotas for small usage

#### Step 3: Create a Service Account
1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "Service Account"
3. Fill in the service account details:
   - Service account name: `qrsong-merchant-center`
   - Service account ID: (auto-generated)
   - Description: "Service account for Google Merchant Center integration"
4. Click "Create and Continue"
5. Skip the optional grant access step (click "Continue")
6. Click "Done"

#### Step 4: Create and Download the JSON Key
1. Find your newly created service account in the list
2. Click on the service account email
3. Go to the "Keys" tab
4. Click "Add Key" > "Create new key"
5. Choose "JSON" format
6. Click "Create"
7. The JSON file will download automatically
8. **Save this file securely** - you'll need it for `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`

#### Step 5: Get the Service Account Email
1. In the service account details, copy the email address
   - It looks like: `qrsong-merchant-center@your-project.iam.gserviceaccount.com`
2. You'll need this email for the next step

#### Step 6: Grant Access in Google Merchant Center
1. Log into [Google Merchant Center](https://merchants.google.com)
2. Click the settings gear icon (⚙️) in the top-right
3. Select "Account access"
4. Click the "+" button to add a new user
5. Enter the service account email from Step 5
6. Set the access level to "Standard" or "Admin"
7. Click "Add user"

#### Step 7: Configure Your Environment
1. Move the downloaded JSON file to a secure location in your project
   - Recommended: `/Users/rick/Sites/qrhit-api/credentials/merchant-center-key.json`
   - **IMPORTANT**: Add this to `.gitignore` to never commit it!
2. Add to your `.env` file:
```env
GOOGLE_MERCHANT_ID=123456789  # Your Merchant ID from earlier
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/Users/rick/Sites/qrhit-api/credentials/merchant-center-key.json
```

#### Security Notes
- **NEVER commit the JSON key file to git**
- Add to `.gitignore`:
```
credentials/
*.json
!package.json
!package-lock.json
!tsconfig.json
```
- Keep the JSON file secure and make backups
- You can always create a new key if needed
- Rotate keys periodically for security

## Features

### Product Variants

Each featured playlist is uploaded as 3 separate product variants:
- **Digital**: PDF download version
- **Sheets**: Printable sheets version  
- **Physical**: Pre-printed physical cards

### Multi-language Support

Products are created for each supported language:
- English (US)
- Dutch (NL)
- German (DE)
- French (FR)
- Spanish (ES)
- Italian (IT)
- Portuguese (PT)
- Polish (PL)
- Japanese (JP)
- Chinese (CN)

### Product URLs

Products link directly to the playlist page with pre-selected order type:
- `/en/product/playlist-slug?orderType=digital`
- `/en/product/playlist-slug?orderType=sheets`
- `/en/product/playlist-slug?orderType=physical`

## API Endpoints

### Admin Route

Requires admin authentication.

#### Upload Featured Playlists
```
POST /admin/merchant-center/upload-featured
Body: { "limit": 2 }
```
Uploads the specified number of top featured playlists (default: 2)

## Dashboard Integration

The upload functionality is integrated into the admin dashboard:

1. Navigate to the Dashboard in the QRSong admin panel
2. In the **Spotify** card, you'll find an "Upload to Merchant" link
3. Click the link to upload the first 2 featured playlists to Google Merchant Center
4. The link will show "Uploading..." while processing
5. You'll receive an alert confirming success or showing any errors

## Testing

Run the test script:
```bash
npx tsx test-merchant-center.ts
```

This will:
1. Upload the first 2 featured playlists
2. List all products in Merchant Center
3. Display a sample product

## Product Structure

Products are addressed by the Merchant API id
`{contentLanguage}~{feedLabel}~{offerId}`, for example `en~US~7_3_1`. The feed
label is the target country, which is how the Content API's `targetCountry`
carries over.

Each product includes:
- **Offer ID**: Unique identifier (format: `{playlistId}_{typeNum}_{localeNum}`)
- **Title**: Playlist name with product type
- **Description**: Playlist description with track count
- **Price**: Converted to the target country's currency, sent in micros
  (1 EUR = 1000000)
- **Image**: Generated product image (AI composite, or the Sharp template
  composite; variants without a hosted image are skipped)
- **Availability**: Always "in_stock"
- **Brand**: "QRSong!"
- **Custom labels** (real product fields, used for PMax segmentation):
  - customLabel0: product variant (digital / sheets / physical)
  - customLabel1: genre group
  - customLabel2: genre slug
  - customLabel3: track-count bucket
- **Custom Attributes**:
  - number_of_tracks
  - product_variant
  - playlist_slug

## Google Product Categories

- **Digital**: 839 (Media > Music & Sound Recordings)
- **Sheets/Physical**: 5030 (Arts & Entertainment > Hobbies & Creative Arts > Arts & Crafts)

## Troubleshooting

### Authentication Issues
- Verify service account has proper permissions in Merchant Center
- Check that the key file path is correct
- Ensure the Merchant API is enabled in Google Cloud Console
- A "No Merchant API data source resolved" warning means data source
  resolution failed; check the service account can list and create data sources

### Product Upload Failures
- Check that featured playlists have:
  - Valid slug
  - Image URL
  - Pricing for all variants
- Verify merchant ID is correct
- Check API quotas in Google Cloud Console

### Missing Products
- Products are only created for locales matching playlist's featuredLocale
- Ensure playlists are marked as featured in database
- Check that descriptions are available for target locales

## Maintenance

### Regular Tasks
1. Monitor API quota usage
2. Review product data quality in Merchant Center
3. Update product descriptions and images as needed
4. Check for API deprecations or changes

### Database Changes
If playlist schema changes, update:
- `uploadPlaylist()` method to handle new fields
- `createMerchantProduct()` to include new attributes
- Product type mappings if new variants are added

## Migration notes (Content API → Merchant API)

What changed when this module moved off the discontinued Content API v2.1:

| Content API v2.1 | Merchant API |
| --- | --- |
| `google.content({version:'v2.1'})` | `google.merchantapi({version:'products_v1'})` + `datasources_v1` |
| `merchantId: '123'` | `parent: 'accounts/123'` |
| no data source concept | every write names `accounts/{id}/dataSources/{id}` |
| `products.insert` / `products.update` (updateMask) | `productInputs.insert` (upsert; no update call) |
| `products.delete` | `productInputs.delete` |
| `products.list` → `data.resources`, max 250/page | `accounts.products.list` → `data.products`, max 1000/page |
| id `online:en:US:123` | id `en~US~123` (no channel prefix in v1) |
| `targetCountry: 'US'` | `feedLabel: 'US'` |
| `price: {value:'29.99', currency:'EUR'}` | `price: {amountMicros:'29990000', currencyCode:'EUR'}` |
| shipping times as numbers | shipping times as strings |
| flat product fields | nested under `productAttributes` |
| `custom_label_0..4` in `customAttributes` | `customLabel0..4` product fields |

The OAuth scope is unchanged (`https://www.googleapis.com/auth/content`), so
the service account and key file did not need to be reissued.

Because `productInputs.insert` is an upsert that rewrites custom labels, the old
`USE_DELETE_INSERT_FOR_UPDATES` workaround (delete-then-reinsert, because PATCH
could not touch `customAttributes`) is gone, and each variant now costs one API
call per sync instead of two.