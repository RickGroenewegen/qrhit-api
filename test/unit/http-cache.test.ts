import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for src/http-cache.ts.
 *
 * The point of this module is that a font added today reaches a returning
 * visitor immediately instead of after 24 hours, so the tests care about the
 * tag changing with the data and about 304 handling.
 */

import { sendCatalogue, __testing } from '../../src/http-cache';

const { buildEtag, matchesEtag } = __testing;

function makeReply() {
  const headers: Record<string, string> = {};
  const reply: any = {
    headers,
    statusCode: 200,
    body: undefined as unknown,
    header: vi.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
      return reply;
    }),
    code: vi.fn((c: number) => {
      reply.statusCode = c;
      return reply;
    }),
    type: vi.fn(() => reply),
    send: vi.fn((b?: unknown) => {
      reply.body = b;
      return reply;
    }),
  };
  return reply;
}

const makeRequest = (ifNoneMatch?: string) => ({
  headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {},
}) as any;

const ORIGINAL_ENV = process.env['ENVIRONMENT'];

beforeEach(() => {
  process.env['ENVIRONMENT'] = 'production';
});

afterEach(() => {
  process.env['ENVIRONMENT'] = ORIGINAL_ENV;
});

describe('buildEtag', () => {
  it('is stable for the same payload', () => {
    expect(buildEtag('{"a":1}')).toBe(buildEtag('{"a":1}'));
  });

  it('changes as soon as the data changes', () => {
    // This is what makes adding a font show up without waiting out a max-age.
    expect(buildEtag('{"fonts":["Oswald"]}')).not.toBe(
      buildEtag('{"fonts":["Oswald","Roboto Condensed"]}')
    );
  });

  it('is a quoted md5 hex digest', () => {
    expect(buildEtag('x')).toMatch(/^"[0-9a-f]{32}"$/);
  });
});

describe('matchesEtag', () => {
  const tag = '"abc123"';

  it('matches an exact tag', () => {
    expect(matchesEtag('"abc123"', tag)).toBe(true);
  });

  it('matches through a proxy that marked it weak', () => {
    expect(matchesEtag('W/"abc123"', tag)).toBe(true);
  });

  it('matches one entry in a list', () => {
    expect(matchesEtag('"other", W/"abc123"', tag)).toBe(true);
  });

  it('matches the wildcard', () => {
    expect(matchesEtag('*', tag)).toBe(true);
  });

  it('does not match a different tag', () => {
    expect(matchesEtag('"nope"', tag)).toBe(false);
    expect(matchesEtag('', tag)).toBe(false);
  });
});

describe('sendCatalogue', () => {
  it('sends the body with an ETag on a first request', () => {
    const reply = makeReply();
    sendCatalogue(makeRequest(), reply, { success: true, data: [1, 2] });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBe('{"success":true,"data":[1,2]}');
    expect(reply.headers['etag']).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('answers 304 with no body when the client already has it', () => {
    const first = makeReply();
    const payload = { success: true, data: ['Oswald'] };
    sendCatalogue(makeRequest(), first, payload);

    const second = makeReply();
    sendCatalogue(makeRequest(first.headers['etag']), second, payload);

    expect(second.statusCode).toBe(304);
    expect(second.body).toBeUndefined();
  });

  it('sends the new body once the data changes, despite the old tag', () => {
    const first = makeReply();
    sendCatalogue(makeRequest(), first, { data: ['Oswald'] });

    const second = makeReply();
    sendCatalogue(makeRequest(first.headers['etag']), second, {
      data: ['Oswald', 'Roboto Condensed'],
    });

    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('Roboto Condensed');
  });

  it('tells clients to revalidate rather than sit on a copy for a day', () => {
    const reply = makeReply();
    sendCatalogue(makeRequest(), reply, { data: [] });

    const cacheControl = reply.headers['cache-control'];
    expect(cacheControl).toContain('must-revalidate');
    expect(cacheControl).not.toContain('max-age=86400');
  });

  it('revalidates on every request in development', () => {
    process.env['ENVIRONMENT'] = 'development';
    const reply = makeReply();
    sendCatalogue(makeRequest(), reply, { data: [] });

    expect(reply.headers['cache-control']).toContain('max-age=0');
  });
});
