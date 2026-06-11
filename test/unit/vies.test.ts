import { describe, it, expect, vi, beforeEach } from 'vitest';

const cacheStore = new Map<string, string>();
vi.mock('../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string) => cacheStore.get(key) ?? null,
      set: async (key: string, value: string, _ttl?: number) => {
        cacheStore.set(key, value);
      },
    }),
  },
}));

vi.mock('axios');
import axios from 'axios';
import Vies from '../../src/services/vies';

const vies = Vies.getInstance();
const axiosGet = vi.mocked(axios.get);

describe('Vies.normalize', () => {
  it('strips whitespace, dots and dashes and uppercases', () => {
    expect(vies.normalize('nl 1234.5678-9b01', 'NL')).toBe('NL123456789B01');
  });

  it('prepends the country prefix when missing', () => {
    expect(vies.normalize('123456789', 'de')).toBe('DE123456789');
  });

  it('keeps an existing prefix', () => {
    expect(vies.normalize('FR123456789', 'DE')).toBe('FR123456789');
  });

  it('rejects empty and malformed input', () => {
    expect(vies.normalize('', 'NL')).toBeNull();
    expect(vies.normalize('!!!', 'NL')).toBeNull();
    expect(vies.normalize('N', 'NL')).toBeNull();
  });
});

describe('Vies.validate', () => {
  beforeEach(() => {
    cacheStore.clear();
    axiosGet.mockReset();
  });

  it('returns null when normalization fails', async () => {
    expect(await vies.validate('###', 'NL')).toBeNull();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('rejects a prefix that does not match the declared country without calling VIES', async () => {
    const res = await vies.validate('FR123456789', 'DE');
    expect(res).toMatchObject({ valid: false, normalized: 'FR123456789' });
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('returns valid for a VIES-confirmed ID and caches it', async () => {
    axiosGet.mockResolvedValueOnce({
      data: { isValid: true, name: 'ACME GmbH', address: 'Berlin' },
    });
    const res = await vies.validate('DE123456789', 'DE');
    expect(res).toMatchObject({
      valid: true,
      normalized: 'DE123456789',
      name: 'ACME GmbH',
    });
    expect(cacheStore.has('vies:DE123456789')).toBe(true);
  });

  it('serves repeat lookups from cache', async () => {
    axiosGet.mockResolvedValueOnce({ data: { isValid: true } });
    await vies.validate('DE123456789', 'DE');
    const res = await vies.validate('DE123456789', 'DE');
    expect(res?.valid).toBe(true);
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  it('marks the result unreachable when VIES errors, still invalid', async () => {
    axiosGet.mockRejectedValueOnce(new Error('timeout'));
    const res = await vies.validate('DE123456789', 'DE');
    expect(res).toMatchObject({
      valid: false,
      unreachable: true,
      normalized: 'DE123456789',
    });
  });
});
