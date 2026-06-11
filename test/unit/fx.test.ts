import { describe, it, expect, vi, beforeEach } from 'vitest';

const cacheStore = new Map<string, string>();
vi.mock('../../src/cache', () => ({
  default: {
    getInstance: () => ({
      get: async (key: string) => cacheStore.get(key) ?? null,
      set: async (key: string, value: string) => {
        cacheStore.set(key, value);
      },
    }),
  },
}));

// Avoid the EC2 main-server probe in the Fx constructor's cron gate.
vi.mock('../../src/utils', () => ({
  default: class {
    isMainServer = async () => false;
  },
}));

vi.mock('axios');
import axios from 'axios';
import Fx from '../../src/services/fx';

const axiosGet = vi.mocked(axios.get);
const fx = Fx.getInstance();

const ECB_XML = `
<gesmes:Envelope>
  <Cube>
    <Cube time='2026-06-10'>
      <Cube currency='USD' rate='1.10'/>
      <Cube currency='NOK' rate='11.50'/>
      <Cube currency='GBP' rate='0.84'/>
      <Cube currency='JPY' rate='170.1'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe('Fx', () => {
  beforeEach(() => {
    cacheStore.clear();
    axiosGet.mockReset();
    axiosGet.mockResolvedValue({ data: ECB_XML });
  });

  it('parses ECB XML, keeping only supported currencies', async () => {
    const rates = await fx.refreshRates();
    expect(rates?.asOf).toBe('2026-06-10');
    expect(rates?.rates).toMatchObject({ EUR: 1, USD: 1.1, NOK: 11.5, GBP: 0.84 });
    expect((rates?.rates as any).JPY).toBeUndefined();
  });

  it('returns null when the feed has no usable rates', async () => {
    axiosGet.mockResolvedValueOnce({ data: '<Envelope></Envelope>' });
    expect(await fx.refreshRates()).toBeNull();
  });

  it('applies the 5% buffer in effective rates with EUR pinned to 1', async () => {
    const eff = await fx.getEffectiveRates();
    expect(eff?.rates.EUR).toBe(1);
    expect(eff?.rates.USD).toBeCloseTo(1.1 * 1.05, 10);
  });

  it('converts EUR amounts with buffer and currency-specific rounding', async () => {
    // 100 EUR → NOK: 100 * 11.5 * 1.05 = 1207.5 → snapped to nearest 5
    const res = await fx.convert(100, 'NOK');
    expect(res.rate).toBeCloseTo(11.5 * 1.05, 10);
    expect(res.amount).toBe(1210);
    expect(res.amount % 5).toBe(0);
  });

  it('convert to EUR is identity', async () => {
    expect(await fx.convert(12.345, 'EUR')).toEqual({ amount: 12.35, rate: 1 });
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('tryConvert falls back to EUR for unsupported currencies', async () => {
    const res = await fx.tryConvert(50, 'JPY');
    expect(res).toEqual({ amount: 50, rate: 1, currency: 'EUR' });
  });

  it('tryConvert falls back to EUR when the rate lookup fails', async () => {
    axiosGet.mockRejectedValue(new Error('ECB down'));
    const res = await fx.tryConvert(50, 'USD');
    expect(res.currency).toBe('EUR');
    expect(res.amount).toBe(50);
  });

  it('convertAndFormat returns a 2-decimal string for payment providers', async () => {
    const res = await fx.convertAndFormat(10, 'GBP');
    // 10 * 0.84 * 1.05 = 8.82 → GBP snaps to 0.5 → 9.00
    expect(res).toEqual({ value: '9.00', currency: 'GBP' });
  });
});
