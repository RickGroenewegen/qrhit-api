# Adding a New Language

This guide covers all the files that need to be updated when adding a new language to QRSong. Use a 2-letter ISO 639-1 code for the language (e.g., `no` for Norwegian, `da` for Danish). The project uses custom codes for some languages: `jp` for Japanese, `cn` for Chinese.

Language data is centralized in two files:
- **Frontend:** `src/app/shared/languages.util.ts` — all components import from here
- **Backend:** `src/translation.ts` — `LOCALE_DATA` array with code, name, greeting, storefront

## Frontend (`/Users/rick/Sites/qrhit`)

### 1. Language Definition (central source of truth)
**`src/app/shared/languages.util.ts`** — Add to the `SUPPORTED_LANGUAGES` array:
```ts
{ code: 'xx', name: 'languagename', nativeName: 'NativeName', flag: 'xx' }
```
- `name`: lowercase English name (used as translation key under `langs.*`)
- `nativeName`: name in the language itself (e.g., `'Norsk'`, `'Deutsch'`)
- `flag`: country code for flag icon (e.g., `se` for Swedish, `no` for Norwegian)
- `htmlLang`: only needed if code differs from HTML lang attribute (e.g., `jp` → `ja`, `cn` → `zh`)

All other frontend files import from this file automatically — no need to update routes, server.ts, admin components, etc.

### 2. Translation Files
**`src/assets/i18n/xx.json`** — Create an empty JSON file `{}` for the new language. The `translate.js` script will populate it.

### 3. Translation Script (exception — cannot import from TypeScript)
**`translate.js`** — Add to both arrays:
- `languages` array: the language code (e.g., `"no"`)
- `languagesFull` array: the full English name (e.g., `"Norwegian"`) — must be at the same index position

### 4. Language Name Label
**`src/assets/i18n/en.json`** — Add the language name under the `langs` key:
```json
"langs": {
  "languagename": "LanguageName"
}
```
Then run `_scripts/remove-from-cache.sh langs.languagename` to clear the translation cache for that key.

### 5. Cache Busting
**`i18n-cache-busting.json`** — Add an entry for the new language with an md5 hash of the initial file content.

### 6. Language-Specific Routes (Optional)
**`src/app/config/language-specific-routes.json`** — If the new language needs localized URL slugs (e.g., Dutch has `/muziekspel-spotify`, German has `/spotify-musikspiel`), add entries here.

## Backend (`/users/rick/sites/qrhit-api`)

### 7. Translation Class (central source of truth)
**`src/translation.ts`** — Add an entry to the `LOCALE_DATA` array:
```ts
{ code: 'xx', name: 'LanguageName', greeting: 'Hello', storefront: 'xx' }
```
- `name`: English name (used for LLM prompts)
- `greeting`: greeting in the language (used in emails)
- `storefront`: Apple Music storefront country code

All other backend files (mail.ts, chatgpt.ts, chat.ts, AppleMusicProvider.ts) use `Translation.LOCALE_NAMES`, `Translation.LOCALE_GREETINGS`, and `Translation.LOCALE_STOREFRONTS` — no need to update them.

### 8. Prisma Schema
**`prisma/schema.prisma`** — Add localized fields to these models:
- **Playlist** model — `description_xx String? @db.Text`
- **CompanyList** model — `description_xx String @default("")`
- **genre** model — `name_xx String @default("")`
- **TrustPilot** model:
  - `title_xx String @default("")`
  - `message_xx String @default("") @db.Text`
- **Blog** model:
  - `slug_xx String? @unique`
  - `title_xx String @default("")`
  - `content_xx String @default("") @db.Text`
  - `summary_xx String? @db.Text`

After updating the schema, generate and run a Prisma migration:
```bash
npx prisma migrate dev --name add_xx_language
```

### 9. API Translation Files
**`src/locales/xx.json`** — Create an empty JSON file `{}` for the new language.

### 10. API Translation Script (exception — cannot import from TypeScript)
**`translate.js`** — Add to both arrays:
- `languages` array: the language code
- `languagesFull` array: the full English name — same index position

## After All Changes

1. Run `npx ng build --configuration=development` to verify the frontend compiles
2. Run `npx tsc --noEmit` in the API to verify the backend compiles
3. Run `npx prisma migrate dev` in the API to create the database migration
4. Run `node translate.js` in both frontend and API to generate translations for the new language
