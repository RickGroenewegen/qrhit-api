/**
 * Redis key layout for resolved physical-card scans (Hitster, MusicMatch,
 * Hitify). Kept dependency-free so spotify.ts, musicfetch.ts and
 * externalCardService.ts can all import it without a cycle.
 *
 * Keys are derived from the card identity rather than the scanned URL, so a
 * card reached through `www.`, a locale prefix, or a different path shape
 * always hits the same entry and can be invalidated exactly.
 */

export const EXTERNAL_CARD_CACHE_PREFIX = 'qrlink2_extcard_';

// Successful resolutions are invalidated explicitly whenever a card changes;
// the TTL is only a safety net. Failures expire quickly so a card that shows
// up in a later import starts resolving without manual intervention.
export const EXTERNAL_CARD_CACHE_TTL_SUCCESS = 30 * 24 * 60 * 60;
export const EXTERNAL_CARD_CACHE_TTL_FAILURE = 60 * 60;

export interface ExternalCardIdentity {
  cardType: string;
  sku?: string | null;
  countryCode?: string | null;
  playlistId?: string | null;
  cardNumber: string;
}

export function jumboCardCacheKey(sku: string, cardNumber: string): string {
  return `${EXTERNAL_CARD_CACHE_PREFIX}jumbo_${sku}_${cardNumber}`;
}

export function countryCardCacheKey(
  countryCode: string,
  cardNumber: string
): string {
  return `${EXTERNAL_CARD_CACHE_PREFIX}country_${countryCode.toLowerCase()}_${cardNumber}`;
}

export function musicMatchCardCacheKey(
  playlistId: string,
  cardNumber: string
): string {
  return `${EXTERNAL_CARD_CACHE_PREFIX}musicmatch_${playlistId}_${cardNumber}`;
}

export function hitifyCardCacheKey(code: string): string {
  return `${EXTERNAL_CARD_CACHE_PREFIX}hitify_${code}`;
}

/**
 * Cache key for a stored external card, or null when the row lacks the
 * identifier its type needs (e.g. a jumbo card without a sku).
 */
export function externalCardCacheKey(
  card: ExternalCardIdentity
): string | null {
  if (card.cardType === 'jumbo' && card.sku) {
    return jumboCardCacheKey(card.sku, card.cardNumber);
  }
  if (card.cardType === 'country' && card.countryCode) {
    return countryCardCacheKey(card.countryCode, card.cardNumber);
  }
  if (card.cardType === 'musicmatch' && card.playlistId) {
    return musicMatchCardCacheKey(card.playlistId, card.cardNumber);
  }
  return null;
}
