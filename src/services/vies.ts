import axios from 'axios';
import Cache from '../cache';
import Logger from '../logger';
import { color } from 'console-log-colors';

const CACHE_TTL_VALID_SECONDS = 24 * 60 * 60; // 24h for valid VAT IDs
const CACHE_TTL_INVALID_SECONDS = 60 * 60;    //  1h for invalid / failed lookups
const VIES_TIMEOUT_MS = 8000;

// EU VAT ID formats vary by country but always start with the ISO country
// code. This regex accepts letters+digits after the prefix so we don't
// exclude countries with alpha characters (NL has a trailing B01, IE may
// contain letters, etc.). Length bounds are loose; VIES is authoritative.
const VAT_ID_FORMAT = /^([A-Z]{2})([A-Z0-9]{2,15})$/;

export interface VatIdCheckResult {
  valid: boolean;
  // The normalized (prefix + number, no whitespace) form that was checked.
  normalized: string;
  // VIES-returned trader name/address, when available. Only present for
  // successful valid lookups; some member states don't publish these.
  name?: string;
  address?: string;
  // ISO timestamp of when this result was obtained.
  checkedAt: string;
  // True if VIES was unreachable / errored and we're returning a
  // conservative "not valid" so callers fall back to charging VAT.
  unreachable?: boolean;
}

/**
 * Client for the EU Commission's VIES (VAT Information Exchange System)
 * VAT number validation service. Used to verify a cross-border EU B2B
 * customer's VAT ID before applying the reverse-charge exemption.
 *
 * We use the JSON REST endpoint (less flaky than the SOAP one). Results
 * are cached in Redis — 24h for valid IDs, 1h for invalid/errored lookups
 * (so a transient VIES outage doesn't lock us out of validating for a day,
 * and a one-off typo expires quickly if the user fixes it).
 *
 * Important: when VIES is unreachable, `valid` is returned as `false` with
 * `unreachable: true`. Callers should treat this as "do NOT apply reverse
 * charge" — we prefer to over-collect VAT (and let the customer request
 * a correction) rather than under-collect and owe the tax authority.
 */
class Vies {
  private static instance: Vies;
  private cache = Cache.getInstance();
  private logger = new Logger();

  private constructor() {}

  public static getInstance(): Vies {
    if (!Vies.instance) {
      Vies.instance = new Vies();
    }
    return Vies.instance;
  }

  /**
   * Normalize a raw VAT ID into "XX1234567890" form (uppercase, no
   * spaces/dots/dashes). If the caller didn't include the country prefix,
   * we prepend it from the buyer's country code.
   */
  public normalize(vatId: string, countryCode: string): string | null {
    if (!vatId) return null;
    const stripped = vatId
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (!stripped) return null;
    const withPrefix = /^[A-Z]{2}/.test(stripped)
      ? stripped
      : `${countryCode.toUpperCase()}${stripped}`;
    if (!VAT_ID_FORMAT.test(withPrefix)) return null;
    return withPrefix;
  }

  /**
   * Validate a VAT ID via VIES. Returns a cached result when available.
   * The `declaredCountry` is the buyer's country at checkout; if the VAT
   * ID's prefix doesn't match we return invalid without ever calling VIES
   * — this guards against a French business typing their FR ID on a
   * "shipping to Germany" order to claim reverse charge.
   */
  public async validate(
    rawVatId: string,
    declaredCountry: string
  ): Promise<VatIdCheckResult | null> {
    const normalized = this.normalize(rawVatId, declaredCountry);
    if (!normalized) return null;

    const prefix = normalized.slice(0, 2);
    if (prefix !== declaredCountry.toUpperCase()) {
      return {
        valid: false,
        normalized,
        checkedAt: new Date().toISOString(),
      };
    }

    const cacheKey = `vies:${normalized}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as VatIdCheckResult;
      } catch {}
    }

    const number = normalized.slice(2);
    const url = `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${prefix}/vat/${number}`;

    try {
      const response = await axios.get(url, { timeout: VIES_TIMEOUT_MS });
      const data = response.data || {};
      const valid = data.isValid === true || data.valid === true;
      const result: VatIdCheckResult = {
        valid,
        normalized,
        name: data.name || undefined,
        address: data.address || undefined,
        checkedAt: new Date().toISOString(),
      };
      await this.cache.set(
        cacheKey,
        JSON.stringify(result),
        valid ? CACHE_TTL_VALID_SECONDS : CACHE_TTL_INVALID_SECONDS
      );
      this.logger.log(
        color.cyan.bold('VIES check: ') +
          color.white.bold(normalized) +
          color.gray(' → ') +
          (valid ? color.green.bold('valid') : color.yellow.bold('invalid'))
      );
      return result;
    } catch (error) {
      this.logger.log(
        color.yellow.bold('VIES unreachable for ') +
          color.white.bold(normalized) +
          color.gray(': ') +
          color.white((error as Error).message)
      );
      const result: VatIdCheckResult = {
        valid: false,
        normalized,
        checkedAt: new Date().toISOString(),
        unreachable: true,
      };
      // Short cache so we retry soon, but not so short that we hammer
      // VIES during a sustained outage.
      await this.cache.set(
        cacheKey,
        JSON.stringify(result),
        CACHE_TTL_INVALID_SECONDS
      );
      return result;
    }
  }
}

export default Vies;
