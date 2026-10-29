import type { Exchange, Host, Step } from './types';

/** Bodies kept in run.json; the full one is in the exchange's own file. */
const MAX_BODY_CHARS = 50_000;

/**
 * One call to Print&Bind. Never throws: a request that got no answer comes
 * back with `status: null` and the reason in `networkError`, so a timeout or
 * a reset connection is told apart from an HTTP 500.
 */
export async function pbCall(
  target: Host,
  step: Exchange['step'],
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = 30_000
): Promise<Exchange & { fullBody: unknown }> {
  const url = `${target.baseUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${target.key ?? ''}`,
    Accept: 'application/json',
  };
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const at = new Date().toISOString();
  const started = performance.now();
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    const ms = Math.round(performance.now() - started);
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    } else {
      parsed = null;
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    return {
      step,
      method,
      url,
      ...(body !== undefined ? { requestBody: body } : {}),
      at,
      ms,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: truncate(parsed),
      bodyBytes: Buffer.byteLength(text),
      fullBody: parsed,
    };
  } catch (error: any) {
    const ms = Math.round(performance.now() - started);
    return {
      step,
      method,
      url,
      ...(body !== undefined ? { requestBody: body } : {}),
      at,
      ms,
      status: null,
      statusText: '',
      headers: {},
      body: null,
      bodyBytes: 0,
      networkError: describeNetworkError(error, timeoutMs),
      fullBody: null,
    };
  }
}

function truncate(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_BODY_CHARS
      ? `${value.slice(0, MAX_BODY_CHARS)}… (${value.length} chars)`
      : value;
  }
  const json = JSON.stringify(value);
  if (json && json.length > MAX_BODY_CHARS) {
    return `${json.slice(0, MAX_BODY_CHARS)}… (${json.length} chars)`;
  }
  return value;
}

function describeNetworkError(error: any, timeoutMs: number): string {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return `timeout after ${Math.round(timeoutMs / 1000)} s`;
  }
  const cause = error?.cause;
  const code = cause?.code || error?.code;
  const message = cause?.message || error?.message || String(error);
  return code ? `${code}: ${message}` : message;
}

/** 2xx / 4xx / 5xx / network: what the comparisons work on. */
export function statusClass(exchange: Exchange | undefined): string {
  if (!exchange) return '-';
  if (exchange.status === null) return 'network';
  return `${Math.floor(exchange.status / 100)}xx`;
}

/** The order resource inside `{ data }`, or the first one of a list. */
export function orderFrom(exchange: Exchange & { fullBody?: unknown }): any | null {
  const body: any = exchange.fullBody ?? exchange.body;
  const data = body && typeof body === 'object' ? body.data : null;
  if (Array.isArray(data)) return data[0] ?? null;
  return data && typeof data === 'object' ? data : null;
}

export function isStep(step: string): step is Step {
  return ['calculate', 'place', 'delete', 'verify', 'search'].includes(step);
}
