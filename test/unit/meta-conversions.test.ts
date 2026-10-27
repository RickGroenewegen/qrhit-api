import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for src/metaConversions.ts.
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

import MetaConversions, {
  buildPurchaseEvent,
  sanitizeAttribution,
} from '../../src/metaConversions';

const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
const FBP = 'fb.1.1761570000000.1234567890';
const FBC = 'fb.1.1761570000000.IwAR2abc-DEF_123';

const payment = {
  orderId: '100009163',
  totalPrice: 34.004,
  email: '  Jan.Jansen@Example.NL ',
  fullname: 'Jan van der Berg',
  city: "'s-Hertogenbosch",
  zipcode: '5211 AB',
  countrycode: 'NL',
  clientIp: '84.104.1.2',
  locale: 'nl',
};

describe('sanitizeAttribution', () => {
  it('is null without the buyer’s advertising consent', () => {
    expect(sanitizeAttribution(undefined)).toBeNull();
    expect(sanitizeAttribution({ fbp: FBP, userAgent: UA })).toBeNull();
    expect(sanitizeAttribution({ consent: 'true', fbp: FBP, userAgent: UA })).toBeNull();
  });

  it('is null without a user agent, which Meta needs for a website event', () => {
    expect(sanitizeAttribution({ consent: true, fbp: FBP })).toBeNull();
    expect(sanitizeAttribution({ consent: true, userAgent: 'x'.repeat(513) })).toBeNull();
  });

  it('keeps the cookies only when they look like Meta’s', () => {
    expect(sanitizeAttribution({ consent: true, fbp: FBP, fbc: FBC, userAgent: UA })).toEqual({
      fbp: FBP,
      fbc: FBC,
      userAgent: UA,
    });
    expect(
      sanitizeAttribution({ consent: true, fbp: 'GA1.1.123', fbc: 42, userAgent: UA })
    ).toEqual({ fbp: undefined, fbc: undefined, userAgent: UA });
  });
});

describe('buildPurchaseEvent', () => {
  const event = buildPurchaseEvent(
    payment,
    { fbp: FBP, fbc: FBC, userAgent: UA },
    'https://www.qrsong.io',
    1761570000
  ) as any;

  it('carries the order number as event id, like the pixel', () => {
    expect(event.event_name).toBe('Purchase');
    expect(event.event_id).toBe('100009163');
    expect(event.event_time).toBe(1761570000);
    expect(event.action_source).toBe('website');
    expect(event.event_source_url).toBe('https://www.qrsong.io/nl/generate/progress');
  });

  it('sends the browser event’s value and currency', () => {
    expect(event.custom_data).toEqual({ currency: 'EUR', value: 34, order_id: '100009163' });
  });

  it('hashes contact details normalised the way Meta asks', () => {
    expect(event.user_data.em).toBe(sha('jan.jansen@example.nl'));
    expect(event.user_data.fn).toBe(sha('jan'));
    expect(event.user_data.ln).toBe(sha('berg'));
    expect(event.user_data.ct).toBe(sha('shertogenbosch'));
    expect(event.user_data.zp).toBe(sha('5211ab'));
    expect(event.user_data.country).toBe(sha('nl'));
  });

  it('sends the IP address, user agent and cookies as they are', () => {
    expect(event.user_data.client_ip_address).toBe('84.104.1.2');
    expect(event.user_data.client_user_agent).toBe(UA);
    expect(event.user_data.fbp).toBe(FBP);
    expect(event.user_data.fbc).toBe(FBC);
  });

  it('leaves out what the order does not have', () => {
    const bare = buildPurchaseEvent(
      { ...payment, fullname: 'Cher', city: null, zipcode: null, countrycode: null, clientIp: null },
      { userAgent: UA },
      'https://www.qrsong.io',
      1761570000
    ) as any;
    expect(Object.keys(bare.user_data).sort()).toEqual(['client_user_agent', 'em', 'fn']);
  });
});

describe('MetaConversions', () => {
  const meta = MetaConversions.getInstance();
  const fetchMock = vi.fn();

  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('ENVIRONMENT', 'production');
    vi.stubEnv('META_PIXEL_ID', '123456');
    vi.stubEnv('META_CAPI_ACCESS_TOKEN', 'token');
    vi.stubEnv('META_CAPI_TEST_EVENT_CODE', '');
    vi.stubEnv('FRONTEND_URI', 'https://www.qrsong.io');
    prismaMock.payment.findUnique.mockResolvedValue(payment);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ events_received: 1 }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('sends a remembered checkout once, then forgets it', async () => {
    await meta.remember(7, { consent: true, fbp: FBP, userAgent: UA });
    await meta.sendPurchase(7);
    await meta.sendPurchase(7);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v26.0/123456/events');
    const body = JSON.parse(init.body);
    expect(body.access_token).toBe('token');
    expect(body.test_event_code).toBeUndefined();
    expect(body.data[0].event_id).toBe('100009163');
    expect(store.size).toBe(0);
  });

  it('keeps and sends nothing without consent', async () => {
    await meta.remember(7, { fbp: FBP, userAgent: UA });
    await meta.sendPurchase(7);
    expect(cacheMock.set).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing until the pixel and token are configured', async () => {
    vi.stubEnv('META_CAPI_ACCESS_TOKEN', '');
    await meta.remember(7, { consent: true, userAgent: UA });
    await meta.sendPurchase(7);
    expect(cacheMock.set).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only sends test events outside production', async () => {
    vi.stubEnv('ENVIRONMENT', 'development');
    await meta.remember(7, { consent: true, userAgent: UA });
    expect(cacheMock.set).not.toHaveBeenCalled();

    vi.stubEnv('META_CAPI_TEST_EVENT_CODE', 'TEST123');
    await meta.remember(7, { consent: true, userAgent: UA });
    await meta.sendPurchase(7);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).test_event_code).toBe('TEST123');
  });

  it('never throws when Meta refuses, and keeps the attribution', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid parameter', fbtrace_id: 'abc' } }),
    });
    await meta.remember(7, { consent: true, userAgent: UA });
    await expect(meta.sendPurchase(7)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    expect(store.size).toBe(1);
    errorSpy.mockRestore();
  });
});
