/**
 * Checking the scan app's store purchases (src/storePurchases.ts).
 *
 * Apple: Xcode-signed transactions (local StoreKit testing) are decoded
 * without a signature, so they exercise the field checks; a production
 * claim with a forged signature must fail Apple's chain check. Google: the
 * Play Developer API is mocked at googleapis.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import jsonwebtoken from 'jsonwebtoken';

const playMock = vi.hoisted(() => ({ get: vi.fn(), consume: vi.fn() }));
vi.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: class {} },
    androidpublisher: () => ({ purchases: { products: playMock } }),
  },
}));

import StorePurchases, { parseStoreProof, StorePurchaseError } from '../../src/storePurchases';

const store = StorePurchases.getInstance();
const TOKEN = '6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';

function appleJws(over: Record<string, any> = {}): string {
  return jsonwebtoken.sign(
    {
      transactionId: '2000001043762129',
      originalTransactionId: '2000001043762129',
      bundleId: 'nl.rickgroenewegen.qrsong',
      productId: 'deck.500',
      type: 'Consumable',
      appAccountToken: TOKEN,
      environment: 'Xcode',
      price: 14990,
      currency: 'EUR',
      signedDate: Date.now(),
      purchaseDate: Date.now(),
      ...over,
    },
    'not-apple'
  );
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof StorePurchaseError) return e.code;
    throw e;
  }
  return 'accepted';
}

let environment: string | undefined;
beforeEach(() => {
  environment = process.env['ENVIRONMENT'];
  process.env['GOOGLE_PLAY_SERVICE_ACCOUNT_FILE'] = '/dev/null';
  playMock.get.mockReset();
  playMock.consume.mockReset();
});
afterEach(() => {
  process.env['ENVIRONMENT'] = environment;
});

describe('parseStoreProof', () => {
  it('takes a JWS from iOS, a token from Android, a token from the web', () => {
    expect(parseStoreProof({ platform: 'ios', productId: 'deck.500', jws: 'a.b.c' })).toEqual({
      platform: 'ios',
      productId: 'deck.500',
      jws: 'a.b.c',
    });
    expect(
      parseStoreProof({ platform: 'android', productId: 'deck.500', purchaseToken: 'tok' })
    ).toEqual({ platform: 'android', productId: 'deck.500', purchaseToken: 'tok' });
    expect(
      parseStoreProof({ platform: 'web', productId: 'deck.500', appAccountToken: TOKEN })
    ).toEqual({ platform: 'web', productId: 'deck.500', appAccountToken: TOKEN });
  });

  it('refuses a proof without its evidence or product', () => {
    expect(parseStoreProof({ platform: 'ios', productId: 'deck.500' })).toBeNull();
    expect(parseStoreProof({ platform: 'android', productId: 'deck.500', jws: 'a.b.c' })).toBeNull();
    expect(parseStoreProof({ platform: 'ios', jws: 'a.b.c' })).toBeNull();
    expect(parseStoreProof('deck.500')).toBeNull();
  });
});

describe('Apple', () => {
  it('reads an Xcode transaction in development', async () => {
    process.env['ENVIRONMENT'] = 'development';
    const purchase = await store.verify({ platform: 'ios', productId: 'deck.500', jws: appleJws() });
    expect(purchase).toEqual({
      platform: 'ios',
      transactionId: '2000001043762129',
      productId: 'deck.500',
      appAccountToken: TOKEN,
      sandbox: true,
      price: 14.99,
      currency: 'EUR',
    });
  });

  it('never takes an Xcode transaction outside development', async () => {
    process.env['ENVIRONMENT'] = 'production';
    expect(
      await refusal(store.verify({ platform: 'ios', productId: 'deck.500', jws: appleJws() }))
    ).toBe('store_proof');
  });

  it('refuses a production transaction Apple did not sign', async () => {
    process.env['ENVIRONMENT'] = 'production';
    const jws = appleJws({ environment: 'Production' });
    expect(await refusal(store.verify({ platform: 'ios', productId: 'deck.500', jws }))).toBe(
      'store_proof'
    );
  });

  it('refuses another app and a refunded purchase', async () => {
    process.env['ENVIRONMENT'] = 'development';
    const otherApp = appleJws({ bundleId: 'com.example.other' });
    expect(
      await refusal(store.verify({ platform: 'ios', productId: 'deck.500', jws: otherApp }))
    ).toBe('store_proof');
    const refunded = appleJws({ revocationDate: Date.now() });
    expect(
      await refusal(store.verify({ platform: 'ios', productId: 'deck.500', jws: refunded }))
    ).toBe('store_refunded');
  });
});

describe('Google', () => {
  const proof = { platform: 'android' as const, productId: 'deck.500', purchaseToken: 'tok-1' };

  it('takes a purchased product and tells a license tester apart', async () => {
    playMock.get.mockResolvedValue({
      data: { purchaseState: 0, orderId: 'GPA.1234-5678', obfuscatedExternalAccountId: TOKEN },
    });
    expect(await store.verify(proof)).toEqual({
      platform: 'android',
      transactionId: 'GPA.1234-5678',
      productId: 'deck.500',
      appAccountToken: TOKEN,
      sandbox: false,
      price: null,
      currency: null,
      purchaseToken: 'tok-1',
    });
    expect(playMock.get).toHaveBeenCalledWith({
      packageName: 'nl.rickgroenewegen.qrsong',
      productId: 'deck.500',
      token: 'tok-1',
    });

    playMock.get.mockResolvedValue({
      data: { purchaseState: 0, purchaseType: 0, orderId: 'GPA.9', obfuscatedExternalAccountId: TOKEN },
    });
    expect((await store.verify(proof)).sandbox).toBe(true);
  });

  it('refuses pending and cancelled purchases', async () => {
    playMock.get.mockResolvedValue({ data: { purchaseState: 2 } });
    expect(await refusal(store.verify(proof))).toBe('store_pending');
    playMock.get.mockResolvedValue({ data: { purchaseState: 1 } });
    expect(await refusal(store.verify(proof))).toBe('store_refunded');
  });

  it('tells an unknown token from Google being unreachable', async () => {
    playMock.get.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));
    expect(await refusal(store.verify(proof))).toBe('store_proof');
    playMock.get.mockRejectedValue(Object.assign(new Error('backend'), { code: 503 }));
    expect(await refusal(store.verify(proof))).toBe('store_unavailable');
  });

  it('consumes the purchase once the order is paid, and survives a failure', async () => {
    const purchase = {
      platform: 'android' as const,
      transactionId: 'GPA.1',
      productId: 'deck.500',
      appAccountToken: TOKEN,
      sandbox: false,
      price: null,
      currency: null,
      purchaseToken: 'tok-1',
    };
    playMock.consume.mockResolvedValue({});
    await store.finish(purchase);
    expect(playMock.consume).toHaveBeenCalledWith({
      packageName: 'nl.rickgroenewegen.qrsong',
      productId: 'deck.500',
      token: 'tok-1',
    });

    playMock.consume.mockRejectedValue(new Error('offline'));
    await expect(store.finish(purchase)).resolves.toBeUndefined();
  });
});

describe('web (ng serve)', () => {
  const proof = { platform: 'web' as const, productId: 'deck.500', appAccountToken: TOKEN };

  it('takes the app at its word in development only', async () => {
    process.env['ENVIRONMENT'] = 'development';
    expect(await store.verify(proof)).toMatchObject({
      transactionId: `dev_${TOKEN}`,
      appAccountToken: TOKEN,
      sandbox: true,
    });
    process.env['ENVIRONMENT'] = 'production';
    expect(await refusal(store.verify(proof))).toBe('store_proof');
  });
});
