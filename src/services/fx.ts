import axios from 'axios';
import { CronJob } from 'cron';
import cluster from 'cluster';
import Cache from '../cache';
import Logger from '../logger';
import Utils from '../utils';
import { color } from 'console-log-colors';
import {
  SUPPORTED_CURRENCIES,
  SupportedCurrency,
  isSupportedCurrency,
} from '../data/currency-map';
import { roundTotal } from './currency-format';

const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const CACHE_KEY = 'fx:rates:latest';
const BUFFER_PCT = 0.05;

export interface FxRates {
  asOf: string;
  rates: Record<SupportedCurrency, number>;
}

class Fx {
  private static instance: Fx;
  private cache = Cache.getInstance();
  private logger = new Logger();
  private utils = new Utils();
  private cronStarted = false;

  private constructor() {
    this.maybeStartCron();
  }

  public static getInstance(): Fx {
    if (!Fx.instance) {
      Fx.instance = new Fx();
    }
    return Fx.instance;
  }

  private maybeStartCron(): void {
    if (this.cronStarted) return;
    if (!cluster.isPrimary) return;
    this.cronStarted = true;
    this.utils.isMainServer().then(async (isMainServer) => {
      if (!isMainServer && process.env['ENVIRONMENT'] !== 'development') {
        return;
      }
      const existing = await this.cache.get(CACHE_KEY);
      if (!existing) {
        await this.refreshRates().catch(() => {});
      }
      new CronJob('30 16 * * *', async () => {
        await this.refreshRates();
      }).start();
    });
  }

  public async refreshRates(): Promise<FxRates | null> {
    try {
      const response = await axios.get<string>(ECB_URL, {
        responseType: 'text',
        timeout: 15000,
      });
      const parsed = this.parseEcbXml(response.data);
      if (!parsed) return null;
      await this.cache.set(CACHE_KEY, JSON.stringify(parsed));
      this.logger.log(
        color.green.bold('FX rates refreshed from ECB (asOf ') +
          color.white.bold(parsed.asOf) +
          color.green.bold(')')
      );
      return parsed;
    } catch (error) {
      this.logger.log(
        color.red.bold('Failed to refresh FX rates: ') +
          color.white((error as Error).message)
      );
      return null;
    }
  }

  public async getRates(): Promise<FxRates | null> {
    const cached = await this.cache.get(CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached) as FxRates;
      } catch {}
    }
    return await this.refreshRates();
  }

  /**
   * Rates already multiplied by the FX buffer (ECB × 1.05) and keyed EUR: 1.
   * This is what the frontend consumes so the client never has to know the
   * buffer size — single source of truth lives here.
   */
  public async getEffectiveRates(): Promise<FxRates | null> {
    const raw = await this.getRates();
    if (!raw) return null;
    const out: Partial<Record<SupportedCurrency, number>> = { EUR: 1 };
    for (const code of SUPPORTED_CURRENCIES) {
      if (code === 'EUR') continue;
      const rate = raw.rates?.[code];
      if (rate) out[code] = rate * (1 + BUFFER_PCT);
    }
    return { asOf: raw.asOf, rates: out as Record<SupportedCurrency, number> };
  }

  public async convert(
    amountEur: number,
    to: SupportedCurrency
  ): Promise<{ amount: number; rate: number }> {
    if (to === 'EUR') {
      return { amount: Number(amountEur.toFixed(2)), rate: 1 };
    }
    const rates = await this.getRates();
    const raw = rates?.rates?.[to];
    if (!raw) {
      throw new Error(`No FX rate available for ${to}`);
    }
    const effectiveRate = raw * (1 + BUFFER_PCT);
    const converted = amountEur * effectiveRate;
    const rounded = roundTotal(converted, to);
    return { amount: rounded, rate: effectiveRate };
  }

  /**
   * Convert with transparent fallback to EUR if the target currency isn't
   * supported or the ECB rate lookup fails. Callers get a guaranteed-valid
   * `{ amount, rate, currency }` so they don't need to wrap in try/catch.
   * The returned `currency` may be EUR even when the caller asked for
   * something else — mollie / merchantcenter use that to keep the charged
   * amount and the currency label consistent in the payload.
   */
  public async tryConvert(
    amountEur: number,
    targetCurrency: string
  ): Promise<{ amount: number; rate: number; currency: SupportedCurrency }> {
    if (targetCurrency === 'EUR' || !isSupportedCurrency(targetCurrency)) {
      return {
        amount: Number(amountEur.toFixed(2)),
        rate: 1,
        currency: 'EUR',
      };
    }
    try {
      const result = await this.convert(
        amountEur,
        targetCurrency as SupportedCurrency
      );
      return { ...result, currency: targetCurrency as SupportedCurrency };
    } catch (error) {
      this.logger.log(
        color.yellow.bold(
          `FX tryConvert failed for ${targetCurrency}, falling back to EUR: ${(error as Error).message}`
        )
      );
      return {
        amount: Number(amountEur.toFixed(2)),
        rate: 1,
        currency: 'EUR',
      };
    }
  }

  /**
   * Same as `tryConvert` but returns the value pre-formatted the way Mollie
   * and Google Merchant Center expect (2 decimals, no thousands separator).
   */
  public async convertAndFormat(
    amountEur: number,
    targetCurrency: string
  ): Promise<{ value: string; currency: SupportedCurrency }> {
    const { amount, currency } = await this.tryConvert(
      amountEur,
      targetCurrency
    );
    return { value: amount.toFixed(2), currency };
  }

  private parseEcbXml(xml: string): FxRates | null {
    const timeMatch = xml.match(/<Cube\s+time=['"]([^'"]+)['"]/);
    const asOf = timeMatch?.[1] ?? new Date().toISOString().slice(0, 10);

    const matches = xml.matchAll(
      /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g
    );
    const rates: Partial<Record<SupportedCurrency, number>> = { EUR: 1 };
    for (const m of matches) {
      const code = m[1];
      if ((SUPPORTED_CURRENCIES as readonly string[]).includes(code)) {
        rates[code as SupportedCurrency] = parseFloat(m[2]);
      }
    }

    if (Object.keys(rates).length <= 1) return null;
    return { asOf, rates: rates as Record<SupportedCurrency, number> };
  }
}

export default Fx;
