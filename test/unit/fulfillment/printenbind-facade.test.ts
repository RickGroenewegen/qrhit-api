/**
 * Unit tests for src/printers/printenbind.ts, the facade that routes every
 * Print&Bind call to the legacy (v1) or REST (v2) integration based on the
 * `printenbind_api_version` app setting.
 *
 * The facade itself is globally mocked in test/setup.ts; we vi.unmock it here
 * and stub both integrations plus Settings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.unmock('../../../src/printers/printenbind');

vi.mock('cluster', () => ({ default: { isPrimary: false }, isPrimary: false }));
vi.mock('cron', () => ({
  CronJob: class {
    start() {}
  },
}));

const v1 = vi.hoisted(() => ({
  calculateOrder: vi.fn(async () => ({ success: true, data: { api: 'v1' } })),
  createOrder: vi.fn(async () => ({ success: true, api: 'v1' })),
  handleTrackingMails: vi.fn(async () => 'v1-tracking'),
  getRawCardCostEur: vi.fn(() => 0.11),
}));
const v2 = vi.hoisted(() => ({
  calculateOrder: vi.fn(async () => ({ success: true, data: { api: 'v2' } })),
  createOrder: vi.fn(async () => ({ success: true, api: 'v2' })),
  handleTrackingMails: vi.fn(async () => 'v2-tracking'),
  quoteShippingCost: vi.fn(async () => 3.45),
  getRawCardCostEur: vi.fn(() => 0.12),
}));
vi.mock('../../../src/printers/printenbindV1', () => ({
  default: { getInstance: () => v1 },
}));
vi.mock('../../../src/printers/printenbindV2', () => ({
  default: { getInstance: () => v2 },
}));

const settingsMock = vi.hoisted(() => ({
  getSetting: vi.fn(async () => null as string | null),
  setSetting: vi.fn(async () => {}),
}));
vi.mock('../../../src/settings', () => ({
  default: { getInstance: () => settingsMock },
}));

vi.mock('../../../src/utils', () => ({
  default: class {
    isMainServer = async () => false;
  },
}));
vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

import PrintEnBind from '../../../src/printers/printenbind';

const peb = PrintEnBind.getInstance();

beforeEach(() => {
  vi.clearAllMocks();
  settingsMock.getSetting.mockResolvedValue(null);
  // Forget the 5s in-memory copy of the setting between tests.
  (peb as any).cachedVersion = null;
  (peb as any).cachedVersionAt = 0;
  process.env['PRINTENBIND_API_URL'] = 'https://www.printenbind.test/api/rest/';
  process.env['PRINTENBIND_V1_API_URL'] = 'https://www.printenbind.test/api';
});

describe('getApiVersion', () => {
  it('defaults to v2 when nothing is stored', async () => {
    expect(await peb.getApiVersion()).toBe('v2');
    expect(settingsMock.getSetting).toHaveBeenCalledWith('printenbind_api_version');
  });

  it('honours a stored v1', async () => {
    settingsMock.getSetting.mockResolvedValue('v1');
    expect(await peb.getApiVersion()).toBe('v1');
  });

  it('ignores garbage and falls back to v2', async () => {
    settingsMock.getSetting.mockResolvedValue('v9');
    expect(await peb.getApiVersion()).toBe('v2');
  });

  it('falls back to v2 when Settings throws', async () => {
    settingsMock.getSetting.mockRejectedValue(new Error('db down'));
    expect(await peb.getApiVersion()).toBe('v2');
  });

  it('caches the answer briefly instead of asking Settings on every call', async () => {
    settingsMock.getSetting.mockResolvedValue('v1');
    await peb.getApiVersion();
    await peb.getApiVersion();
    await peb.calculateOrder({ cart: { items: [] } });
    expect(settingsMock.getSetting).toHaveBeenCalledTimes(1);
  });
});

describe('setApiVersion / getApiInfo', () => {
  it('stores the choice and takes effect immediately', async () => {
    await peb.setApiVersion('v1');
    expect(settingsMock.setSetting).toHaveBeenCalledWith('printenbind_api_version', 'v1');
    const r = await peb.calculateOrder({ cart: { items: [] } });
    expect(r.data.api).toBe('v1');
    expect(v2.calculateOrder).not.toHaveBeenCalled();
  });

  it('rejects unknown versions', async () => {
    await expect(peb.setApiVersion('v3' as any)).rejects.toThrow('Unknown Print&Bind API version');
    expect(settingsMock.setSetting).not.toHaveBeenCalled();
  });

  it('reports both endpoints without trailing slashes', async () => {
    expect(await peb.getApiInfo()).toEqual({
      version: 'v2',
      v1Url: 'https://www.printenbind.test/api',
      v2Url: 'https://www.printenbind.test/api/rest',
    });
  });

  it('reports a missing endpoint as null', async () => {
    delete process.env['PRINTENBIND_V1_API_URL'];
    expect((await peb.getApiInfo()).v1Url).toBeNull();
  });
});

describe('delegation', () => {
  it('routes to v2 by default', async () => {
    const r = await peb.calculateOrder({ cart: { items: [] } });
    expect(r.data.api).toBe('v2');
    expect(v1.calculateOrder).not.toHaveBeenCalled();
  });

  it('routes to v1 when selected', async () => {
    settingsMock.getSetting.mockResolvedValue('v1');
    const r = await peb.calculateOrder({ cart: { items: [] } });
    expect(r.data.api).toBe('v1');
    expect(await peb.handleTrackingMails()).toBe('v1-tracking');
    expect(v2.calculateOrder).not.toHaveBeenCalled();
  });

  it('serves the raw card cost synchronously from v2 regardless of the toggle', async () => {
    settingsMock.getSetting.mockResolvedValue('v1');
    expect(peb.getRawCardCostEur()).toBe(0.12);
  });

  it('only quotes live shipping on v2', async () => {
    expect(await peb.quoteShippingCost('NL', [])).toBe(3.45);
    settingsMock.getSetting.mockResolvedValue('v1');
    (peb as any).cachedVersion = null;
    expect(await peb.quoteShippingCost('NL', [])).toBeNull();
    expect(v2.quoteShippingCost).toHaveBeenCalledTimes(1);
  });
});
