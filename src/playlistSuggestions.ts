import Translation from './translation';
import { PlaylistSuggestionOptions } from './data/featuredPlaylists';

/** Box sizes the admin can pick a suggestion list for. */
export const SUGGESTION_CARD_COUNTS = [48, 96, 192, 200] as const;

const MAX_GENRE_IDS = 50;

export interface ParsedPlaylistSuggestionOptions extends PlaylistSuggestionOptions {
  /** Business locale the document itself is written in (nl / de / en). */
  locale: string;
}

/**
 * Reads the suggestion filters from a query string or a JSON body. The
 * unauthenticated HTML view is screenshotted by Lambda, so everything has to
 * travel as plain comma-separated scalars that are validated here and never
 * reach SQL. Returns an error message instead of throwing so routes can 400.
 */
export function parsePlaylistSuggestionOptions(
  source: Record<string, unknown> | undefined,
  translation: Translation
): { ok: true; opts: ParsedPlaylistSuggestionOptions } | { ok: false; error: string } {
  const src = source || {};

  const cardCount = Number(src['cardCount'] ?? 96);
  if (!(SUGGESTION_CARD_COUNTS as readonly number[]).includes(cardCount)) {
    return { ok: false, error: 'Invalid cardCount' };
  }

  const locales = toStringList(src['locales'])
    .map((l) => l.toLowerCase())
    .filter((l) => /^[a-z]{2}$/.test(l) && Translation.ALL_LOCALES.includes(l));

  const genreIds = toStringList(src['genreIds'])
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, MAX_GENRE_IDS);

  return {
    ok: true,
    opts: {
      locale: translation.resolveBusinessLocale(
        typeof src['locale'] === 'string' ? src['locale'] : null
      ),
      locales: Array.from(new Set(locales)),
      genreIds: Array.from(new Set(genreIds)),
      cardCount,
    },
  };
}

/** Query string for the HTML view, so the PDF route and the count endpoint agree. */
export function playlistSuggestionQuery(opts: ParsedPlaylistSuggestionOptions): string {
  const params = new URLSearchParams({
    locale: opts.locale,
    cardCount: String(opts.cardCount),
  });
  if (opts.locales.length) params.set('locales', opts.locales.join(','));
  if (opts.genreIds.length) params.set('genreIds', opts.genreIds.join(','));
  return params.toString();
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
  return [];
}
