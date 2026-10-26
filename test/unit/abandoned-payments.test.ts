import { describe, it, expect } from 'vitest';
import {
  HelpMailCandidate,
  HelpMailOtherPayment,
  RESUME_LINK_DAYS,
  helpMailDecision,
  resumeLink,
} from '../../src/abandonedPayments';
import { isSignedRenderRequest } from '../../src/renderSignature';

const NOW = new Date('2026-10-26T12:00:00Z');
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000);

const candidate = (over: Partial<HelpMailCandidate> = {}): HelpMailCandidate => ({
  id: 100,
  createdAt: at(3),
  hasCards: true,
  trustedIp: false,
  ...over,
});

const other = (over: Partial<HelpMailOtherPayment> = {}): HelpMailOtherPayment => ({
  id: 50,
  status: 'paid',
  createdAt: at(24 * 90),
  helpMailStatus: null,
  helpMailAt: null,
  ...over,
});

describe('helpMailDecision (who gets the help mail)', () => {
  it('sends to a customer whose only payment was abandoned', () => {
    expect(helpMailDecision(candidate(), [], NOW)).toBe('send');
  });

  it('still sends when they paid an earlier, older order', () => {
    expect(helpMailDecision(candidate(), [other({ createdAt: at(24 * 60) })], NOW)).toBe('send');
  });

  it('skips a customer who paid with another payment since', () => {
    expect(helpMailDecision(candidate(), [other({ id: 101, createdAt: at(2) })], NOW)).toBe('skipped_paid');
  });

  it('counts a paid payment started in the same second as "since"', () => {
    expect(helpMailDecision(candidate(), [other({ id: 99, createdAt: at(3) })], NOW)).toBe('skipped_paid');
  });

  it('waits while a newer payment is still open, without deciding', () => {
    for (const status of ['open', 'pending', 'authorized']) {
      expect(helpMailDecision(candidate(), [other({ id: 101, status, createdAt: at(1) })], NOW)).toBe('wait');
    }
  });

  it('does not wait for an open payment older than the abandoned one', () => {
    expect(
      helpMailDecision(candidate(), [other({ id: 99, status: 'open', createdAt: at(24 * 5) })], NOW)
    ).toBe('send');
  });

  it('mails only the newest of several abandoned tries', () => {
    const tries = [other({ id: 101, status: 'canceled', createdAt: at(2) })];
    expect(helpMailDecision(candidate(), tries, NOW)).toBe('skipped_newer');
    // and the newest one, seeing the older try, does get it
    expect(
      helpMailDecision(candidate({ id: 101, createdAt: at(2) }), [other({ id: 100, status: 'canceled', createdAt: at(3) })], NOW)
    ).toBe('send');
  });

  it('breaks a tie between tries started in the same second by id', () => {
    const sameTime = [other({ id: 101, status: 'expired', createdAt: at(3) })];
    expect(helpMailDecision(candidate({ id: 100 }), sameTime, NOW)).toBe('skipped_newer');
    expect(
      helpMailDecision(candidate({ id: 101 }), [other({ id: 100, status: 'expired', createdAt: at(3) })], NOW)
    ).toBe('send');
  });

  it('mails a customer at most once in 30 days', () => {
    const mailed = (daysAgo: number) =>
      other({ id: 20, status: 'canceled', createdAt: at(24 * daysAgo), helpMailStatus: 'sent', helpMailAt: at(24 * daysAgo) });
    expect(helpMailDecision(candidate(), [mailed(10)], NOW)).toBe('skipped_recent');
    expect(helpMailDecision(candidate(), [mailed(31)], NOW)).toBe('send');
    // a mail that failed or was skipped does not count
    expect(
      helpMailDecision(candidate(), [{ ...mailed(10), helpMailStatus: 'error' }], NOW)
    ).toBe('send');
  });

  it('skips test-mode orders and orders without cards', () => {
    expect(helpMailDecision(candidate({ trustedIp: true }), [], NOW)).toBe('skipped_test');
    expect(helpMailDecision(candidate({ hasCards: false }), [], NOW)).toBe('skipped_nocards');
  });

  it('puts a paid order before every other reason', () => {
    expect(
      helpMailDecision(candidate({ trustedIp: true, hasCards: false }), [other({ id: 101, createdAt: at(1) })], NOW)
    ).toBe('skipped_paid');
  });
});

describe('resumeLink', () => {
  it('points at the API, carries the language and a signature for this order only', () => {
    const { url, validUntil } = resumeLink('100009439', 'de', NOW);
    expect(url.startsWith(`${process.env['API_URI']}/order/resume/100009439?`)).toBe(true);
    const query = Object.fromEntries(new URL(url).searchParams);
    expect(query['l']).toBe('de');
    expect(validUntil.getTime() - NOW.getTime()).toBe(RESUME_LINK_DAYS * 24 * 60 * 60 * 1000);

    const env = process.env['ENVIRONMENT'];
    process.env['ENVIRONMENT'] = 'production';
    try {
      expect(isSignedRenderRequest('payment-resume', { params: { orderId: '100009439' }, query })).toBe(true);
      expect(isSignedRenderRequest('payment-resume', { params: { orderId: '100009440' }, query })).toBe(false);
      expect(isSignedRenderRequest('card-draft', { params: { orderId: '100009439' }, query })).toBe(false);
    } finally {
      process.env['ENVIRONMENT'] = env;
    }
  });
});
