import { describe, it, expect } from 'vitest';
import { limitProgressData } from '../../src/progressPrivacy';

/**
 * GET /progress is keyed on the payment id alone, so the buyer's name,
 * address and account hash are only in its answer while the checkout and
 * the scan app need them.
 */
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-11T12:00:00Z');

function order(createdHoursAgo: number, finalizedHoursAgo: number | null) {
  return {
    payment: {
      orderId: '100001',
      status: 'paid',
      totalPrice: 34,
      createdAt: new Date(NOW - createdHoursAgo * HOUR),
      finalizedAt: finalizedHoursAgo === null ? null : new Date(NOW - finalizedHoursAgo * HOUR),
      finalized: finalizedHoursAgo !== null,
      fullname: 'Emma Jansen',
      email: 'emma@example.com',
      address: 'Hoofdstraat',
      housenumber: '1',
      city: 'Sassenheim',
      zipcode: '2171AA',
      countryCode: 'NL',
      differentInvoiceAddress: 1,
      invoiceAddress: 'Kerklaan',
      invoiceHousenumber: '2',
      invoiceCity: 'Lisse',
      invoiceZipcode: '2161BB',
      invoiceCountrycode: 'NL',
      userHash: 'a8f3ec97ca372a88',
    },
    playlists: [{ id: 5, playlistId: 'abc', type: 'digital' }],
    userHash: 'a8f3ec97ca372a88',
  };
}

const PERSONAL = [
  'fullname',
  'email',
  'address',
  'housenumber',
  'city',
  'zipcode',
  'invoiceAddress',
  'invoiceHousenumber',
  'invoiceCity',
  'invoiceZipcode',
  'invoiceCountrycode',
  'differentInvoiceAddress',
];

describe('limitProgressData', () => {
  it('keeps everything right after the order', () => {
    const result = limitProgressData(order(1, null), NOW);
    expect(result.payment.email).toBe('emma@example.com');
    expect(result.payment.address).toBe('Hoofdstraat');
    expect(result.userHash).toBe('a8f3ec97ca372a88');
    expect(result.payment).not.toHaveProperty('finalizedAt');
  });

  it('drops name, e-mail, addresses and the hash a day after a finalized order', () => {
    const result = limitProgressData(order(30, 29), NOW);
    for (const field of PERSONAL) expect(result.payment).not.toHaveProperty(field);
    expect(result.payment).not.toHaveProperty('userHash');
    expect(result.userHash).toBeNull();
    expect(result.payment.status).toBe('paid');
    expect(result.payment.orderId).toBe('100001');
    expect(result.payment.totalPrice).toBe(34);
    expect(result.payment.countryCode).toBe('NL');
    expect(result.playlists).toHaveLength(1);
  });

  it('keeps the hash for a day after a late finalize, for the app\'s PDF link', () => {
    const result = limitProgressData(order(60, 2), NOW);
    expect(result.payment).not.toHaveProperty('email');
    expect(result.userHash).toBe('a8f3ec97ca372a88');
  });

  it('keeps the hash of an order still in the year check, for a week at most', () => {
    expect(limitProgressData(order(60, null), NOW).userHash).toBe('a8f3ec97ca372a88');
    expect(limitProgressData(order(8 * 24, null), NOW).userHash).toBeNull();
  });

  it('gives nothing personal when the creation date is missing', () => {
    const data = order(1, null);
    (data.payment as any).createdAt = null;
    const result = limitProgressData(data, NOW);
    expect(result.payment).not.toHaveProperty('email');
    expect(result.userHash).toBeNull();
  });

  it('does not change what it was given', () => {
    const data = order(30, 29);
    limitProgressData(data, NOW);
    expect(data.payment.email).toBe('emma@example.com');
  });
});
