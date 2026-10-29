import dotenv from 'dotenv';
import path from 'path';
import { createHash } from 'crypto';
import type { PbCustomerInfo } from '../../src/printers/printenbindV2Request';
import type { EnvName, Host } from './types';

dotenv.config({ quiet: true });

export const API_ROOT = path.resolve(__dirname, '../..');
export const REPORTS_DIR =
  process.env['PNB_HARNESS_REPORTS_DIR'] || path.join(API_ROOT, 'reports', 'pnb-harness');
export const FILES_DIR = path.join(REPORTS_DIR, 'files');
export const LEDGER_FILE = path.join(REPORTS_DIR, 'ledger.jsonl');
export const FIXTURES_FILE = path.join(__dirname, 'fixtures.local.json');

/** Where Print&Bind fetches our printer PDFs from: production's public folder. */
export const DEFAULT_FILE_BASE = 'https://api.qrsong.io';

/** Every order the harness places carries this, so a leftover is recognisable. */
export const REFERENCE_PREFIX = 'qrs-harness-';
export const TEST_ORDER_COMMENT =
  'TESTORDER QRSong API-test, NIET PRODUCEREN, wordt direct geannuleerd';

/** The servers in Print&Bind's OpenAPI spec. */
const DEFAULT_URLS: Record<EnvName, string> = {
  sandbox: 'https://sandbox.printenbind.nl/api/rest',
  live: 'https://www.printenbind.nl/api/rest',
};

export function fingerprint(key: string | null): string {
  return key
    ? createHash('sha256').update(key).digest('hex').slice(0, 12)
    : '(no key)';
}

export function host(env: EnvName): Host {
  const upper = env.toUpperCase();
  const key = process.env[`PNB_HARNESS_${upper}_KEY`]?.trim() || null;
  const baseUrl = (
    process.env[`PNB_HARNESS_${upper}_URL`] || DEFAULT_URLS[env]
  ).replace(/\/+$/, '');
  return { env, baseUrl, key, fingerprint: fingerprint(key) };
}

function parseAddress(raw: string, name: string): PbCustomerInfo {
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error}`);
  }
  for (const field of ['fullname', 'address', 'housenumber', 'zipcode', 'city', 'email']) {
    if (!value[field]) {
      throw new Error(`${name} has no ${field}`);
    }
  }
  return { countrycode: 'NL', ...value };
}

/**
 * The address live test orders go to, per country. PNB_HARNESS_ADDRESS is
 * the NL one (Rick's own, so a parcel that slips through comes home);
 * PNB_HARNESS_ADDRESSES adds others as {"DE": {...}, ...}. A country without
 * one is only calculated on live, never placed.
 */
export function addresses(): Record<string, PbCustomerInfo> {
  const result: Record<string, PbCustomerInfo> = {};
  const main = process.env['PNB_HARNESS_ADDRESS']?.trim();
  if (main) {
    const address = parseAddress(main, 'PNB_HARNESS_ADDRESS');
    result[address.countrycode.toUpperCase()] = address;
  }
  const more = process.env['PNB_HARNESS_ADDRESSES']?.trim();
  if (more) {
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(more);
    } catch (error) {
      throw new Error(`PNB_HARNESS_ADDRESSES is not valid JSON: ${error}`);
    }
    for (const [country, value] of Object.entries(parsed)) {
      result[country.toUpperCase()] = {
        ...parseAddress(JSON.stringify(value), `PNB_HARNESS_ADDRESSES.${country}`),
        countrycode: country.toUpperCase(),
      };
    }
  }
  return result;
}
