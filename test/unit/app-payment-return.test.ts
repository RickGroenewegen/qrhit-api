import { describe, expect, it } from 'vitest';
import { appPaymentReturnLink, paymentReturnStatus } from '../../src/appPaymentReturn';

describe('paymentReturnStatus', () => {
  it('names the verdict the webhook wrote', () => {
    expect(paymentReturnStatus('paid')).toBe('paid');
    expect(paymentReturnStatus('canceled')).toBe('canceled');
    expect(paymentReturnStatus('failed')).toBe('failed');
    expect(paymentReturnStatus('expired')).toBe('failed');
  });

  it('keeps waiting while Mollie has no verdict yet', () => {
    expect(paymentReturnStatus('open')).toBe('open');
    expect(paymentReturnStatus('pending')).toBe('open');
    expect(paymentReturnStatus('authorized')).toBe('open');
  });

  it('knows nothing of a payment it did not find', () => {
    expect(paymentReturnStatus(undefined)).toBe('unknown');
    expect(paymentReturnStatus(null)).toBe('unknown');
  });
});

describe('appPaymentReturnLink', () => {
  it("is the app's URL scheme, with the payment", () => {
    expect(appPaymentReturnLink('tr_abc')).toBe('nl.rickgroenewegen.qrsong://payment?paymentId=tr_abc');
    expect(appPaymentReturnLink('')).toBe('nl.rickgroenewegen.qrsong://payment');
  });
});
