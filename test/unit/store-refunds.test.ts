/**
 * Refunds of the scan app's store orders (src/storeRefunds.ts).
 *
 * The stores are mocked at their libraries (googleapis, Apple's API client;
 * Apple's signature check is replaced by a plain decode), the database by a
 * small in-memory payments table that answers the job's queries. Pushover is
 * the global recording mock (test/setup.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { outbound } from '../helpers/recording-mock';

const h = vi.hoisted(() => {
  const db = { payments: [] as any[], lines: [] as any[] };
  const matches = (row: any, where: any): boolean =>
    Object.entries(where).every(([field, condition]: [string, any]) => {
      const value = row[field];
      if (condition === null) return value === null;
      if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
        if ('in' in condition) return condition.in.includes(value);
        if ('not' in condition) return value !== condition.not;
        if ('gte' in condition) return value >= condition.gte;
      }
      return value === condition;
    });
  const prisma = {
    payment: {
      findMany: vi.fn(async ({ where }: any) => db.payments.filter((p) => matches(p, where)).map((p) => ({ ...p }))),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = db.payments.filter((p) => matches(p, where));
        rows.forEach((p) => Object.assign(p, data));
        return { count: rows.length };
      }),
    },
    paymentHasPlaylist: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = db.lines.filter((l) => matches(l, where));
        rows.forEach((l) => Object.assign(l, data));
        return { count: rows.length };
      }),
    },
  };
  return {
    db,
    prisma,
    voidedList: vi.fn(),
    refundHistory: vi.fn(),
    appleClients: [] as any[][],
    republishBlocked: vi.fn(async () => true),
    logs: [] as string[],
  };
});

vi.mock('../../src/prisma', () => ({ default: { getInstance: () => h.prisma } }));
vi.mock('../../src/cache', () => ({
  default: { getInstance: () => ({ acquireLock: async () => true, releaseLock: async () => {} }) },
}));
vi.mock('../../src/data', () => ({
  default: { getInstance: () => ({ republishBlocked: h.republishBlocked }) },
}));
vi.mock('../../src/utils', () => ({
  default: class Utils {
    isMainServer = async () => false;
  },
}));
vi.mock('../../src/logger', () => ({
  default: class Logger {
    log = (message: string) => h.logs.push(message);
  },
}));
vi.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: class {} },
    androidpublisher: () => ({ purchases: { voidedpurchases: { list: h.voidedList } } }),
  },
}));
vi.mock('@apple/app-store-server-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@apple/app-store-server-library')>()),
  AppStoreServerAPIClient: class {
    constructor(...args: any[]) {
      h.appleClients.push(args);
    }
    getRefundHistory = h.refundHistory;
  },
}));

import { APIException, Environment } from '@apple/app-store-server-library';
import StoreRefunds from '../../src/storeRefunds';
import StorePurchases, { purchaseTokenTransactionId } from '../../src/storePurchases';

const job = StoreRefunds.getInstance();
const VOIDED_AT = Date.parse('2026-10-28T09:30:00Z');
const REVOKED_AT = Date.parse('2026-10-29T14:00:00Z');

function order(over: Record<string, any> = {}) {
  return {
    id: 1,
    paymentId: 'store_6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f',
    orderId: '100012345',
    totalPrice: 13,
    profit: 9.13,
    fullname: 'Test Buyer',
    countrycode: 'NL',
    paymentMethod: 'googleplay',
    status: 'paid',
    storeTransactionId: 'GPA.3300-0000-0000-00001',
    storeEnvironment: 'production',
    refundAmount: null,
    refundedAt: null,
    refundReason: null,
    createdAt: new Date(),
    ...over,
  };
}

function voided(over: Record<string, any> = {}) {
  return {
    kind: 'androidpublisher#voidedPurchase',
    orderId: 'GPA.3300-0000-0000-00001',
    purchaseToken: 'token-1',
    voidedTimeMillis: String(VOIDED_AT),
    voidedReason: 7,
    voidedSource: 0,
    ...over,
  };
}

// The "signed" transactions the mocked verifier decodes.
const appleTx = (transactionId: string, over: Record<string, any> = {}) =>
  JSON.stringify({ transactionId, revocationDate: REVOKED_AT, revocationReason: 1, ...over });

const pushes = () => outbound.calls('PushoverClient', 'sendMessage');

let keyDir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['APPLE_IAP_KEY_FILE', 'APPLE_IAP_KEY_ID', 'APPLE_IAP_ISSUER_ID', 'GOOGLE_PLAY_SERVICE_ACCOUNT_FILE'];

function useAppleKey() {
  const file = path.join(keyDir, 'iap.p8');
  fs.writeFileSync(file, 'not-a-real-key');
  process.env['APPLE_IAP_KEY_FILE'] = file;
  process.env['APPLE_IAP_KEY_ID'] = 'KEYID';
  process.env['APPLE_IAP_ISSUER_ID'] = 'issuer';
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS.slice(0, 3)) delete process.env[key];
  process.env['GOOGLE_PLAY_SERVICE_ACCOUNT_FILE'] = '/dev/null';
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-refunds-'));

  h.db.payments = [];
  h.db.lines = [];
  h.logs.length = 0;
  h.appleClients.length = 0;
  h.voidedList.mockReset().mockResolvedValue({ data: {} });
  h.refundHistory.mockReset().mockResolvedValue({ signedTransactions: [], hasMore: false });
  h.republishBlocked.mockReset().mockResolvedValue(true);
  h.prisma.payment.updateMany.mockClear();
  outbound.reset();
  (job as any).appleClients.clear();
  (job as any).appleKeyMissingLogged = false;
  vi.spyOn(StorePurchases.getInstance(), 'appleVerifier').mockReturnValue({
    verifyAndDecodeTransaction: async (jws: string) => JSON.parse(jws),
  } as any);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(keyDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Google Play', () => {
  it('refunds a voided order, blocks its lines and tells Rick', async () => {
    h.db.payments = [order()];
    h.db.lines = [
      { id: 11, paymentId: 1, blocked: false },
      { id: 12, paymentId: 1, blocked: false },
      { id: 13, paymentId: 2, blocked: false },
    ];
    h.voidedList
      .mockResolvedValueOnce({ data: { voidedPurchases: [voided({ orderId: 'GPA.other' })], tokenPagination: { nextPageToken: 'page-2' } } })
      .mockResolvedValueOnce({ data: { voidedPurchases: [voided()] } });

    expect(await job.run()).toEqual({ google: 1, apple: 0 });

    expect(h.voidedList).toHaveBeenNthCalledWith(1, { packageName: 'nl.rickgroenewegen.qrsong', maxResults: 1000 });
    expect(h.voidedList).toHaveBeenNthCalledWith(2, {
      packageName: 'nl.rickgroenewegen.qrsong',
      maxResults: 1000,
      token: 'page-2',
    });
    expect(h.db.payments[0]).toMatchObject({
      status: 'paid',
      refundAmount: 13,
      refundedAt: new Date(VOIDED_AT),
      refundReason: 'Google Play refund: chargeback',
      profit: 0,
    });
    expect(h.db.lines.map((l) => l.blocked)).toEqual([true, true, false]);
    expect(h.republishBlocked).toHaveBeenCalledTimes(1);
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0].args[0].title).toContain('APP-REFUND');
    expect(pushes()[0].args[0].message).toMatch(/^Via Google Play: .*€ 13,00.*100012345/);
  });

  it('matches an order stored under its token hash', async () => {
    h.db.payments = [order({ storeTransactionId: purchaseTokenTransactionId('token-9') })];
    h.voidedList.mockResolvedValue({ data: { voidedPurchases: [voided({ orderId: null, purchaseToken: 'token-9', voidedReason: 1 })] } });

    expect(await job.run()).toEqual({ google: 1, apple: 0 });
    expect(h.db.payments[0].refundReason).toBe('Google Play refund: remorse');
  });

  it('skips an order already refunded, and never handles one twice', async () => {
    const earlier = new Date('2026-10-20T10:00:00Z');
    h.db.payments = [
      order({ refundedAt: earlier, refundAmount: 13, refundReason: 'Google Play refund: other' }),
      order({ id: 2, orderId: '100012346', storeTransactionId: 'GPA.3300-0000-0000-00002' }),
    ];
    h.db.lines = [{ id: 21, paymentId: 2, blocked: false }];
    h.voidedList.mockResolvedValue({
      data: { voidedPurchases: [voided(), voided({ orderId: 'GPA.3300-0000-0000-00002', purchaseToken: 'token-2' })] },
    });

    expect(await job.run()).toEqual({ google: 1, apple: 0 });
    expect(h.db.payments[0]).toMatchObject({ refundedAt: earlier, refundReason: 'Google Play refund: other' });
    expect(h.db.payments[1].refundedAt).toEqual(new Date(VOIDED_AT));

    // Google lists it for 30 days; the next runs leave it alone.
    expect(await job.run()).toEqual({ google: 0, apple: 0 });
    expect(pushes()).toHaveLength(1);
  });

  it('ignores a voided purchase no order knows', async () => {
    h.db.payments = [order()];
    h.db.lines = [{ id: 11, paymentId: 1, blocked: false }];
    h.voidedList.mockResolvedValue({ data: { voidedPurchases: [voided({ orderId: 'GPA.unknown', purchaseToken: 'other' })] } });

    expect(await job.run()).toEqual({ google: 0, apple: 0 });
    expect(h.db.payments[0].refundedAt).toBeNull();
    expect(h.db.lines[0].blocked).toBe(false);
    expect(h.republishBlocked).not.toHaveBeenCalled();
    expect(pushes()).toHaveLength(0);
  });

  it('refunds and blocks a test purchase without a Pushover', async () => {
    h.db.payments = [order({ storeEnvironment: 'sandbox' })];
    h.db.lines = [{ id: 11, paymentId: 1, blocked: false }];
    h.voidedList.mockResolvedValue({ data: { voidedPurchases: [voided()] } });

    expect(await job.run()).toEqual({ google: 1, apple: 0 });
    expect(h.db.payments[0].refundAmount).toBe(13);
    expect(h.db.lines[0].blocked).toBe(true);
    expect(pushes()).toHaveLength(0);
  });

  it('leaves the order for the next run when the blocked list could not be published', async () => {
    h.db.payments = [order()];
    h.db.lines = [{ id: 11, paymentId: 1, blocked: false }];
    h.voidedList.mockResolvedValue({ data: { voidedPurchases: [voided()] } });
    h.republishBlocked.mockResolvedValueOnce(false);

    expect(await job.run()).toEqual({ google: 0, apple: 0 });
    expect(h.db.payments[0].refundedAt).toBeNull();

    expect(await job.run()).toEqual({ google: 1, apple: 0 });
    expect(h.db.payments[0].refundedAt).toEqual(new Date(VOIDED_AT));
  });
});

describe('App Store', () => {
  const appleOrder = (over: Record<string, any> = {}) =>
    order({ paymentMethod: 'appstore', storeTransactionId: '2000001043762129', ...over });

  it('does nothing without the In-App Purchase key, and says so once', async () => {
    h.db.payments = [appleOrder()];
    h.voidedList.mockResolvedValue({ data: { voidedPurchases: [voided({ orderId: 'GPA.unknown' })] } });

    expect(await job.run()).toEqual({ google: 0, apple: 0 });
    expect(await job.run()).toEqual({ google: 0, apple: 0 });
    expect(h.appleClients).toHaveLength(0);
    expect(h.refundHistory).not.toHaveBeenCalled();
    // Google is still asked
    expect(h.voidedList).toHaveBeenCalledTimes(2);
    expect(h.logs.filter((line) => line.includes('APPLE_IAP_KEY_FILE'))).toHaveLength(1);
  });

  it("matches the buyer's refunds, asking once for everything one answer settles", async () => {
    useAppleKey();
    const older = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    h.db.payments = [
      appleOrder(),
      appleOrder({ id: 2, orderId: '100012346', storeTransactionId: '2000001043762200', createdAt: older }),
      appleOrder({ id: 3, orderId: '100012347', storeTransactionId: '2000001043762300', createdAt: older }),
    ];
    h.db.lines = [
      { id: 11, paymentId: 1, blocked: false },
      { id: 21, paymentId: 2, blocked: false },
      { id: 31, paymentId: 3, blocked: false },
    ];
    // The first order's buyer bought the second too and had both refunded,
    // over two pages; the third order is someone else's.
    h.refundHistory.mockImplementation(async (transactionId: string, revision: string | null) => {
      if (transactionId !== '2000001043762129') return { signedTransactions: [], hasMore: false, revision: 'r0' };
      return revision === null
        ? { signedTransactions: [appleTx('2000001043762129')], hasMore: true, revision: 'r1' }
        : { signedTransactions: [appleTx('2000001043762200', { revocationReason: 0 })], hasMore: false, revision: 'r2' };
    });

    expect(await job.run()).toEqual({ google: 0, apple: 2 });

    expect(h.appleClients[0]).toEqual(['not-a-real-key', 'KEYID', 'issuer', 'nl.rickgroenewegen.qrsong', Environment.PRODUCTION]);
    expect(h.refundHistory.mock.calls).toEqual([
      ['2000001043762129', null],
      ['2000001043762129', 'r1'],
      ['2000001043762300', null],
    ]);
    expect(h.db.payments[0]).toMatchObject({
      refundAmount: 13,
      refundedAt: new Date(REVOKED_AT),
      refundReason: 'App Store refund: issue with the purchase',
      profit: 0,
    });
    expect(h.db.payments[1].refundReason).toBe('App Store refund: other');
    expect(h.db.payments[2].refundedAt).toBeNull();
    expect(h.db.lines.map((l) => l.blocked)).toEqual([true, true, false]);
    expect(pushes()).toHaveLength(2);
    expect(pushes()[0].args[0].message).toMatch(/^Via de App Store: /);
  });

  it('asks the sandbox for a test purchase, and sends no Pushover', async () => {
    useAppleKey();
    h.db.payments = [appleOrder({ storeEnvironment: 'sandbox' })];
    h.refundHistory.mockResolvedValue({ signedTransactions: [appleTx('2000001043762129')], hasMore: false });

    expect(await job.run()).toEqual({ google: 0, apple: 1 });
    expect(h.appleClients.map((args) => args[4])).toEqual([Environment.SANDBOX]);
    expect(StorePurchases.getInstance().appleVerifier).toHaveBeenCalledWith(Environment.SANDBOX);
    expect(pushes()).toHaveLength(0);
  });

  it('skips a transaction Apple does not know, and stops when Apple refuses', async () => {
    useAppleKey();
    h.db.payments = [
      appleOrder(),
      appleOrder({ id: 2, storeTransactionId: '2000001043762200' }),
      appleOrder({ id: 3, storeTransactionId: '2000001043762300' }),
    ];
    h.refundHistory
      .mockRejectedValueOnce(new APIException(404, 4040010, 'Transaction id not found'))
      .mockRejectedValueOnce(new APIException(401))
      .mockResolvedValue({ signedTransactions: [appleTx('2000001043762300')], hasMore: false });

    expect(await job.run()).toEqual({ google: 0, apple: 0 });
    expect(h.refundHistory).toHaveBeenCalledTimes(2);
    expect(h.logs.some((line) => line.includes('status 401'))).toBe(true);
  });

  it('leaves out orders older than the lookback and development web proofs', async () => {
    useAppleKey();
    h.db.payments = [
      appleOrder({ createdAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000) }),
      appleOrder({ id: 2, storeTransactionId: 'dev_6f1c2b9e' }),
    ];

    expect(await job.run()).toEqual({ google: 0, apple: 0 });
    expect(h.refundHistory).not.toHaveBeenCalled();
  });
});
