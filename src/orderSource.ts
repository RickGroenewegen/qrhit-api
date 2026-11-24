import { MCP_SOURCE } from './mcp/links';

/**
 * Where an order started when that is somewhere else than the site or the
 * scan app: `payments.source`. The site keeps the `?src=` of the link a
 * visitor arrived by and sends it with the payment as `source`.
 *
 * It says how the visitor got here, not where the order was placed (that is
 * `payments.channel`, src/salesChannel.ts): an order that started in ChatGPT
 * is still paid on the website and counts as a website order in the reports.
 *
 * Only the sources listed here are stored; anything else a visitor puts in
 * the URL is dropped.
 */
export const ORDER_SOURCES: readonly string[] = [MCP_SOURCE];

export function parseOrderSource(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ORDER_SOURCES.includes(text) ? text : null;
}
