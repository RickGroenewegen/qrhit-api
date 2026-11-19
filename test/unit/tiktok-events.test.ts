import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for src/tiktokEvents.ts.
 *
 * All I/O is mocked at module level:
 *  - src/cache  → an in-memory map
 *  - src/prisma → one payment row
 *  - src/logger → no-op
 *  - fetch      → stubbed per test
 */

const store = vi.hoisted(() => new Map<string, string>());

const cacheMock = vi.hoisted(() => ({
  set: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  del: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

const prismaMock = vi.hoisted(() => ({
  payment: { findUnique: vi.fn() },
}));

vi.mock('../../src/cache', () => ({
  default: { getInstance: () => cacheMock },
}));

vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

vi.mock('../../src/logger', () => ({
  default: class {
    log = vi.fn();
  },
}));

import TikTokEvents, { buildPurchaseEvent, sanitizeAttribution } from '../../src/tiktokEvents';

const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
const TTCLID = 'E.C.P.CsoBx1-abc_DEF.123~xyz';
const TTP = '2abCdEfGhIjKlMnOpQrStUvWxYz';

const payment = {
  orderId: '100009163',
  totalPrice: 34.004,
  email: '  Jan.Jansen@Example.NL ',
  clientIp: '84.104.1.2',
  locale: 'de',
};

describe('sanitizeAttribution', () => {
  it('is null without the buyer’s advertising consent', () => {
    expect(sanitizeAttribution(undefined)).toBeNull();
    expect(sanitizeAttribution({ ttclid: TTCLID, userAgent: UA })).toBeNull();
    expect(sanitizeAttribution({ consent: 'true', ttclid: TTCLID, userAgent: UA })).toBeNull();
  });

  it('is null without a user agent', () => {
    expect(sanitizeAttribution({ consent: true, ttclid: TTCLID })).toBeNull();
    expect(sanitizeAttribution({ consent: true, userAgent: 'x'.repeat(513) })).toBeNull();
  });

  it('keeps the click id and the cookie only when they look like tokens', () => {
    expect(sanitizeAttribution({ consent: true, ttclid: TTCLID, ttp: TTP, userAgent: UA })).toEqual({
      ttclid: TTCLID,
      ttp: TTP,
      userAgent: UA,
    });
    expect(
      sanitizeAttribution({ consent: true, ttclid: '<script>', ttp: 42, userAgent: UA })
    ).toEqual({ ttclid: undefined, ttp: undefined, userAgent: UA });
  });

  it('still sends for a consenting buyer who did not come from an ad', () => {
    expect(sanitizeAttribution({ consent: true, ttclid: null, ttp: null, userAgent: UA })).toEqual({
      ttclid: undefined,
      ttp: undefined,
      userAgent: UA,
    });
  });
});

describe('buildPurchaseEvent', () => {
  const event = buildPurchaseEvent(
    payment,
    { ttclid: TTCLID, ttp: TTP, userAgent: UA },
    'https://www.qrsong.io',
    1761570000
  ) as any;

  it('carries the order number as event id, like the pixel', () => {
    expect(event.event).toBe('Purchase');
    expect(event.event_id).toBe('100009163');
    expect(event.event_time).toBe(1761570000);
    expect(event.page.url).toBe('https://www.qrsong.io/de/generate/progress');
  });

  it('sends the browser event’s value and currency', () => {
    expect(event.properties).toEqual({
      currency: 'EUR',
      value: 34,
      order_id: '100009163',
      content_type: 'product',
    });
  });

  it('hashes the e-mail address and sends the rest as it is', () => {
    expect(event.user).toEqual({
      user_agent: UA,
      email: sha('jan.jansen@example.nl'),
      ip: '84.104.1.2',
      ttclid: TTCLID,
      ttp: TTP,
    });
  });

  it('leaves out what it does not have', () => {
    const bare = buildPurchaseEvent(
      { ...payment, clientIp: null },
      { userAgent: UA },
      'https://www.qrsong.io',
      1
    ) as any;
    expect(bare.user).toEqual({ user_agent: UA, email: sha('jan.jansen@example.nl') });
  });
});

describe('TikTokEvents', () => {
  const env = { ...process.env };
  const fetchMock = vi.fn();

  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    process.env['TIKTOK_PIXEL_CODE'] = 'CPIXEL123';
    process.env['TIKTOK_EVENTS_ACCESS_TOKEN'] = 'token';
    process.env['ENVIRONMENT'] = 'production';
    delete process.env['TIKTOK_EVENTS_TEST_CODE'];
    prismaMock.payment.findUnique.mockResolvedValue(payment);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0, message: 'OK' }) });
  });

  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it('keeps nothing without consent, and nothing when it is not configured', async () => {
    await TikTokEvents.getInstance().remember(7, { ttclid: TTCLID, userAgent: UA });
    expect(store.size).toBe(0);
    delete process.env['TIKTOK_PIXEL_CODE'];
    await TikTokEvents.getInstance().remember(7, { consent: true, ttclid: TTCLID, userAgent: UA });
    expect(store.size).toBe(0);
  });

  it('sends the purchase once and forgets the attribution', async () => {
    await TikTokEvents.getInstance().remember(7, { consent: true, ttclid: TTCLID, ttp: TTP, userAgent: UA });
    expect(store.has('tiktok_events:7')).toBe(true);
    await TikTokEvents.getInstance().sendPurchase(7);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://business-api.tiktok.com/open_api/v1.3/event/track/');
    expect(init.headers['Access-Token']).toBe('token');
    const body = JSON.parse(init.body);
    expect(body.event_source).toBe('web');
    expect(body.event_source_id).toBe('CPIXEL123');
    expect(body.data[0].event_id).toBe('100009163');
    expect(body.test_event_code).toBeUndefined();
    expect(store.size).toBe(0);

    await TikTokEvents.getInstance().sendPurchase(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a buyer who did not consent', async () => {
    await TikTokEvents.getInstance().sendPurchase(8);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('outside production only sends as a test event', async () => {
    process.env['ENVIRONMENT'] = 'development';
    await TikTokEvents.getInstance().remember(7, { consent: true, userAgent: UA });
    expect(store.size).toBe(0);
    process.env['TIKTOK_EVENTS_TEST_CODE'] = 'TEST1';
    await TikTokEvents.getInstance().remember(7, { consent: true, userAgent: UA });
    await TikTokEvents.getInstance().sendPurchase(7);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).test_event_code).toBe('TEST1');
  });

  it('keeps the attribution and does not throw when TikTok refuses', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 40105, message: 'bad token', request_id: 'r1' }) });
    await TikTokEvents.getInstance().remember(7, { consent: true, userAgent: UA });
    await expect(TikTokEvents.getInstance().sendPurchase(7)).resolves.toBeUndefined();
    expect(store.has('tiktok_events:7')).toBe(true);
  });
});
