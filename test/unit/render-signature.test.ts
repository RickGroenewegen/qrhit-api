import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { isSignedRenderRequest, signedRenderQuery } from '../../src/renderSignature';

/**
 * The quotation and technical-instructions pages are opened by the PDF
 * Lambda without a session; the signature is all that keeps them closed to
 * someone counting company ids.
 */

// What Fastify hands the handler for a query string: one string per key,
// an array when a key repeats.
function request(params: Record<string, string>, queryString: string) {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(queryString)) {
    const existing = query[key];
    query[key] = existing === undefined ? value : ([] as string[]).concat(existing, value);
  }
  return { params, query };
}

const quotationParams = { type: 'schneider', companyId: '12', quotationNumber: 'Q-2026-001' };

describe('render URL signatures', () => {
  const env = { ...process.env };

  beforeEach(() => {
    process.env['JWT_SECRET'] = 'test-secret';
    process.env['ENVIRONMENT'] = 'production';
  });

  afterEach(() => {
    process.env = { ...env };
    vi.useRealTimers();
  });

  it('accepts the values it signed', () => {
    const query = signedRenderQuery('quotation', quotationParams, {
      listId: '4',
      profitMargins: '{"a":1}',
      locale: 'nl',
    });
    expect(isSignedRenderRequest('quotation', request(quotationParams, query))).toBe(true);
  });

  it('rejects missing, altered, added or repeated values, another view and another secret', () => {
    const query = signedRenderQuery('quotation', quotationParams, { locale: 'en' });

    expect(isSignedRenderRequest('quotation', request(quotationParams, 'locale=en'))).toBe(false);
    expect(
      isSignedRenderRequest('quotation', request({ ...quotationParams, companyId: '13' }, query))
    ).toBe(false);
    expect(isSignedRenderRequest('quotation', request(quotationParams, `${query}&contactUserId=7`))).toBe(false);
    expect(isSignedRenderRequest('quotation', request(quotationParams, `${query}&locale=de`))).toBe(false);
    expect(isSignedRenderRequest('technical-instructions', request(quotationParams, query))).toBe(false);

    process.env['JWT_SECRET'] = 'another-secret';
    expect(isSignedRenderRequest('quotation', request(quotationParams, query))).toBe(false);
  });

  it('rejects an expired link', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
    const params = { companyId: '12' };
    const query = signedRenderQuery('technical-instructions', params, { printer: 'tromp' }, 60);
    expect(isSignedRenderRequest('technical-instructions', request(params, query))).toBe(true);

    vi.setSystemTime(new Date('2026-10-08T12:01:01Z'));
    expect(isSignedRenderRequest('technical-instructions', request(params, query))).toBe(false);
  });

  it('lets unsigned requests through in development only', () => {
    const unsigned = request({ companyId: '12' }, '');
    process.env['ENVIRONMENT'] = 'development';
    expect(isSignedRenderRequest('technical-instructions', unsigned)).toBe(true);
    process.env['ENVIRONMENT'] = 'test';
    expect(isSignedRenderRequest('technical-instructions', unsigned)).toBe(false);
  });
});
