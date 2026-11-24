import { SITE_LOCALES } from '../data/shared/shared-data.generated';
import { ServiceType } from '../enums/ServiceType';

/**
 * The links the ChatGPT channel (src/mcp) hands a customer: the page on the
 * site where they design the cards and pay. Nothing is ordered in the chat.
 *
 * Every link opens on printed cards (`orderType=physical`): OpenAI lets a
 * plugin sell physical goods only, so the digital PDF and the sheets are not
 * offered there. `src` is what the site keeps and sends with the payment
 * (`payments.source`), so an order from this channel can be told apart.
 */

/** `payments.source` of an order that started in ChatGPT. */
export const MCP_SOURCE = 'chatgpt';

const SITE_LOCALE_CODES = new Set<string>(SITE_LOCALES.map((l) => l.code));

/** The site language of a chat: the locale when the site has it, its alias, else English. */
export function siteLocale(locale: string | null | undefined): string {
  const code = String(locale || '').trim().toLowerCase().split(/[-_]/)[0];
  if (SITE_LOCALE_CODES.has(code)) return code;
  const byAlias = SITE_LOCALES.find(
    (l) => (l.aliases ?? []).includes(code) || l.htmlLang === code
  );
  return byAlias?.code ?? 'en';
}

function siteBase(): string {
  return (process.env['FRONTEND_URI'] || 'https://www.qrsong.io').replace(/\/+$/, '');
}

const HANDOFF_QUERY = `orderType=physical&src=${MCP_SOURCE}`;

/** The product page of a ready-made playlist. */
export function featuredLink(locale: string, slug: string): string {
  return `${siteBase()}/${siteLocale(locale)}/product/${encodeURIComponent(slug)}?${HANDOFF_QUERY}`;
}

/**
 * The summary page of the customer's own playlist. The route takes the
 * service as the enum writes it (`apple_music`), the form "Order again" uses.
 */
export function playlistLink(locale: string, service: ServiceType, playlistId: string): string {
  return (
    `${siteBase()}/${siteLocale(locale)}/generate/summary/` +
    `${encodeURIComponent(playlistId)}/0/1/${service}?${HANDOFF_QUERY}`
  );
}

/** The cover of a ready-made playlist from our own domain. */
export function featuredCover(slug: string): string {
  const api = (process.env['API_URI'] || 'https://api.qrsong.io').replace(/\/+$/, '');
  return `${api}/product-cover/${encodeURIComponent(slug)}.jpg`;
}
