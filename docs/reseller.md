# QRSong! Reseller API

API for third-party resellers to create QR music card orders and download printer-ready PDFs.

## Base URL

```
https://api.qrsong.io
```

## Authentication

All endpoints (except preview retrieval) require an API key passed as a Bearer token:

```
Authorization: Bearer rk_your_api_key_here
```

API keys start with `rk_`. Contact us to obtain one.

---

## Quick Start

The simplest possible order — just a playlist URL with default design:

```bash
curl -X POST https://api.qrsong.io/reseller/orders \
  -H "Authorization: Bearer rk_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "playlistUrl": "https://open.spotify.com/playlist/5WxLJfgeVeifVtyX0cIFZY",
    "design": {}
  }'
```

Then poll for the result:

```bash
curl https://api.qrsong.io/reseller/orders/100000042 \
  -H "Authorization: Bearer rk_your_api_key_here"
```

When `status` is `"done"`, download the PDF from `pdfUrl`.

---

## Workflow

1. **Browse available assets** (optional) — Fetch fonts and preset backgrounds to offer in your UI
2. **Fetch playlist** (optional) — Validate a playlist URL and display its tracks before ordering
3. **Upload custom media** (optional) — Upload your own background images or logos
4. **Preview** (optional) — Generate a preview URL to visualize the card design (embeddable in iframes)
5. **Create order** — Submit a playlist URL + design configuration
6. **Poll for status** — Check order progress until status is `done`
7. **Download PDF** — Use the `pdfUrl` from the response

---

## Endpoints

### Fonts

#### `GET /reseller/fonts`

Returns all available fonts for card designs.

**Response:**

```json
{
  "success": true,
  "data": [
    { "id": "", "displayName": "Arial (Classic)" },
    { "id": "Oswald", "displayName": "Oswald (Modern)" },
    { "id": "Fredoka", "displayName": "Fredoka (Rounded)" },
    { "id": "Caveat", "displayName": "Caveat (Handwritten)" },
    { "id": "Pacifico", "displayName": "Pacifico (Casual)" }
  ]
}
```

The `id` value is what you pass as `design.selectedFont` when creating orders. An empty string means Arial (the default). To render fonts in their true look on your end, load them from Google Fonts using the `id` as the font family name (e.g. `https://fonts.googleapis.com/css2?family=Oswald&display=swap`).

---

### Backgrounds

#### `GET /reseller/backgrounds`

Returns the 20 preset background images that can optionally be used in card designs. You can also upload your own backgrounds via the media upload endpoint — these presets are just a convenient starting point.

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "mediaId": 42,
      "thumbnail": "https://www.qrsong.io/assets/images/card_backgrounds/thumbnails/background1_thumb.png",
      "full": "https://www.qrsong.io/assets/images/card_backgrounds/background1.png"
    },
    {
      "mediaId": 43,
      "thumbnail": "https://www.qrsong.io/assets/images/card_backgrounds/thumbnails/background2_thumb.png",
      "full": "https://www.qrsong.io/assets/images/card_backgrounds/background2.png"
    }
  ]
}
```

- **thumbnail** — 150x150px preview image, suitable for displaying in a picker
- **full** — 1000x1000px full-size image
- **mediaId** — Pass this as `design.background` or `design.backgroundBack` when creating orders

---

### Playlist

#### `POST /reseller/playlist`

Fetch playlist metadata and track listing from a music service URL. Use this to validate a playlist and display its contents before placing an order.

**Supported music services:** Spotify, YouTube Music, Apple Music, Deezer, Tidal.

**Request body:**

```json
{
  "playlistUrl": "https://open.spotify.com/playlist/5WxLJfgeVeifVtyX0cIFZY"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "serviceType": "spotify",
    "playlist": {
      "id": "5WxLJfgeVeifVtyX0cIFZY",
      "name": "My Playlist",
      "description": "A great playlist",
      "imageUrl": "https://i.scdn.co/image/ab67616d00001e02...",
      "trackCount": 25
    },
    "tracks": [
      {
        "name": "Bohemian Rhapsody",
        "artist": "Queen",
        "album": "A Night at the Opera",
        "releaseDate": "1975-10-31",
        "duration": 354320
      }
    ]
  }
}
```

If any tracks were skipped (unavailable, local files, podcasts, duplicates), a `skipped` object is included with details.

---

### Media Upload

#### `POST /reseller/media/upload`

Upload a custom background or logo image. Send as `multipart/form-data`.

**Form fields:**

| Field | Type | Description |
|-------|------|-------------|
| `image` | file | Image file (PNG, JPG, etc.) |
| `type` | text | `background`, `background_back`, or `logo` |

Background images are resized to 1000x1000px. Logos are stored in their original format.

**Response:**

```json
{
  "success": true,
  "data": {
    "mediaId": 1,
    "type": "background"
  }
}
```

Use the returned `mediaId` in the design object when creating orders.

---

### Orders

#### `POST /reseller/orders`

Create a card order from a music playlist URL.

**Supported music services:** Spotify, YouTube Music, Apple Music, Deezer, Tidal.

**Request body:**

```json
{
  "playlistUrl": "https://open.spotify.com/playlist/5WxLJfgeVeifVtyX0cIFZY",
  "design": {
    "background": 42,
    "backgroundFrontType": "image",
    "frontOpacity": 100,
    "qrColor": "#000000",
    "qrBackgroundColor": "#ffffff",
    "qrBackgroundType": "square",
    "selectedFont": "Pacifico"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `playlistUrl` | Yes | Full URL of a playlist from a supported music service |
| `serviceType` | No | `spotify`, `youtube_music`, `apple_music`, `deezer`, or `tidal`. Auto-detected from URL if omitted. |
| `design` | Yes | Design configuration (see below). Pass `{}` for defaults. |

**Response:**

```json
{
  "success": true,
  "data": {
    "orderId": "100000042",
    "status": "processing"
  }
}
```

#### `GET /reseller/orders/:orderId`

Poll this endpoint to check order progress. You can only retrieve orders you created.

**Status values:**

| Status | Description |
|--------|-------------|
| `processing` | PDF is being generated |
| `finalizing` | Almost done |
| `done` | PDF ready — `pdfUrl` is included in the response |
| `failed` | Order failed |

Recommended polling interval: every 5–10 seconds.

The response may include a `comment` field with additional information. For example, if track years need manual verification before the PDF can be generated, the comment will say `"Order years are being manually checked"`. This means the order is waiting on our team — no action required on your end.

**Response (done):**

```json
{
  "success": true,
  "data": {
    "orderId": "100000042",
    "status": "done",
    "createdAt": "2026-02-12T10:30:00.000Z",
    "pdfUrl": "https://api.qrsong.io/public/pdf/reseller_abc123_printer_cards_1.pdf"
  }
}
```

---

### Preview

#### `POST /reseller/preview`

Generate a preview to visualize a card design before placing an order. Preview URLs expire after 24 hours.

**Request body:**

```json
{
  "design": {
    "backgroundFrontType": "solid",
    "backgroundFrontColor": "#1DB954",
    "backgroundBackType": "solid",
    "backgroundBackColor": "#191414",
    "qrColor": "#1DB954",
    "qrBackgroundType": "square",
    "selectedFont": "Oswald",
    "fontColor": "#ffffff"
  },
  "sampleTrackName": "Bohemian Rhapsody",
  "sampleTrackArtist": "Queen",
  "sampleTrackYear": "1975"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "previewUrlFront": "https://qrsong.io/en/card-preview-front/abc123def456",
    "previewUrlBack": "https://qrsong.io/en/card-preview-back/abc123def456",
    "token": "abc123def456"
  }
}
```

The preview URLs can be opened in a browser or embedded in iframes on your own site. The pages are designed to work well inside iframes — headers and other chrome are automatically hidden.

**Iframe example:**

```html
<iframe
  src="https://qrsong.io/en/card-preview-front/abc123def456"
  width="350"
  height="350"
  style="border: none;"
></iframe>
```

---

## Design Object Reference

The `design` object controls the visual appearance of the cards. All fields are optional — omitted fields use sensible defaults.

### Card Layout

Each card has two sides:

- **Front** — Contains the QR code and an optional logo
- **Back** — Contains the track name, artist, and year

### Images

| Field | Type | Description |
|-------|------|-------------|
| `background` | integer | Front background image. Pass a `mediaId` from the upload endpoint or the backgrounds endpoint. |
| `backgroundBack` | integer | Back background image. Pass a `mediaId`. |
| `logo` | integer | Logo overlaid on the front. Pass a `mediaId` from the upload endpoint. |

### Front Side

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `backgroundFrontType` | string | `"image"` | `"image"` to use a background image, `"solid"` for a solid color |
| `backgroundFrontColor` | string | `"#ffffff"` | Hex color when using solid background |
| `frontOpacity` | integer | `100` | Background image opacity (0–100) |
| `useFrontGradient` | boolean | `false` | Enable gradient overlay |
| `gradientFrontColor` | string | `"#ffffff"` | Second gradient color |
| `gradientFrontDegrees` | integer | `180` | Gradient angle (0–360) |
| `gradientFrontPosition` | integer | `50` | Gradient color stop position (0–100) |

### Back Side

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `backgroundBackType` | string | `"image"` | `"image"` or `"solid"` |
| `backgroundBackColor` | string | `"#ffffff"` | Hex color when using solid background |
| `backOpacity` | integer | `50` | Background image opacity (0–100) |
| `useGradient` | boolean | `false` | Enable gradient overlay |
| `gradientBackgroundColor` | string | `"#ffffff"` | Second gradient color |
| `gradientDegrees` | integer | `180` | Gradient angle (0–360) |
| `gradientPosition` | integer | `50` | Gradient color stop position (0–100) |

### QR Code

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `qrColor` | string | `"#000000"` | Color of the QR code dots |
| `qrBackgroundColor` | string | `"#ffffff"` | Background color of the QR code area |
| `qrBackgroundType` | string | `"square"` | Shape behind the QR code: `"none"`, `"circle"`, or `"square"` |

### Typography

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `selectedFont` | string | `""` | Font name from `GET /reseller/fonts`. Empty string = Arial. |
| `selectedFontSize` | string | auto | CSS font size (e.g. `"14px"`). Auto-detected from font if omitted. |
| `fontColor` | string | `"#000000"` | Text color for track name, artist, year |

---

## Error Handling

All error responses follow the same format:

```json
{
  "success": false,
  "error": "Description of what went wrong"
}
```

Common HTTP status codes:

| Code | Meaning |
|------|---------|
| 400 | Bad request — missing or invalid fields |
| 401 | Unauthorized — missing or invalid API key |
| 403 | Forbidden — API key doesn't have access |
| 404 | Not found — order or preview doesn't exist |
| 500 | Internal server error |
