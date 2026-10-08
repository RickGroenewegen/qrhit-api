import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { isSignedRenderRequest, signRenderUrl } from '../../src/renderSignature';

/**
 * The quotation and technical-instructions pages are opened by the PDF
 * Lambda without a session; the signature is all that keeps them closed to
 * someone counting company ids.
 */

const pathOf = (url: string) => {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
};

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

  it('accepts the signed URL as the server receives it', () => {
    const signed = signRenderUrl(
      'https://api.example.com/business/quotation/schneider/12/Q-2026-001?listId=4&profitMargins=%7B%22a%22%3A1%7D&locale=nl'
    );
    expect(isSignedRenderRequest(pathOf(signed))).toBe(true);
  });

  it('rejects a missing, altered or foreign signature', () => {
    const signed = pathOf(
      signRenderUrl('https://api.example.com/business/quotation/qrsong/12/Q-1?locale=en')
    );
    expect(isSignedRenderRequest('/business/quotation/qrsong/12/Q-1?locale=en')).toBe(false);
    expect(isSignedRenderRequest(signed.replace('/12/', '/13/'))).toBe(false);
    expect(isSignedRenderRequest(signed + '&contactUserId=7')).toBe(false);
    expect(isSignedRenderRequest(signed.replace(/sig=[0-9a-f]{4}/, 'sig=0000'))).toBe(false);

    process.env['JWT_SECRET'] = 'another-secret';
    expect(isSignedRenderRequest(signed)).toBe(false);
  });

  it('rejects an expired link', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
    const signed = pathOf(
      signRenderUrl('https://api.example.com/business/technical-instructions/12?printer=tromp', 60)
    );
    expect(isSignedRenderRequest(signed)).toBe(true);

    vi.setSystemTime(new Date('2026-10-08T12:01:01Z'));
    expect(isSignedRenderRequest(signed)).toBe(false);
  });

  it('lets unsigned requests through in development only', () => {
    process.env['ENVIRONMENT'] = 'development';
    expect(isSignedRenderRequest('/business/technical-instructions/12')).toBe(true);
    process.env['ENVIRONMENT'] = 'test';
    expect(isSignedRenderRequest('/business/technical-instructions/12')).toBe(false);
  });
});
