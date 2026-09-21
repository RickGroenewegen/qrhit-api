/**
 * Pull the printer's own error text out of a stored printApiOrderResponse, for
 * the admin dashboard. Both Print&Bind integrations store
 * `{ apiCalls: [{ statusCode, responseBody }], error? }`; the legacy API
 * answers a refusal with HTTP 200 and `{ result: false, error }`, the REST API
 * with a 4xx and a `message` / `error` / `detail` body.
 */
export function extractPrintErrorMessage(
  printApiOrderResponse: string | null | undefined
): string | null {
  if (!printApiOrderResponse) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(printApiOrderResponse);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

  const calls: any[] = Array.isArray(parsed.apiCalls) ? parsed.apiCalls : [];
  for (const call of calls) {
    const body = call?.responseBody;
    const refused =
      (typeof call?.statusCode === 'number' && call.statusCode >= 400) ||
      body?.result === false;
    if (!refused) continue;

    const message =
      text(body?.error) ??
      text(body?.message) ??
      text(body?.detail) ??
      text(body?.title) ??
      text(body);
    if (message) return message;
    if (typeof call?.statusCode === 'number' && call.statusCode >= 400) {
      return `HTTP ${call.statusCode}`;
    }
  }

  return text(parsed.error);
}
