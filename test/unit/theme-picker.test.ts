import { describe, it, expect } from 'vitest';
import { themePickerEntries } from '../../src/routes/themeRoutes';

/**
 * GET /theme/debug/all feeds the scan app's dev-mode theme picker: every
 * theme once, not one row per order line.
 */
describe('themePickerEntries', () => {
  const business = [
    { slug: 'cannock', name: 'Cannock Hits' },
    { slug: 'acme', name: 'Acme Company' },
    // The folder of a stored theme: the stored one came first and wins
    { slug: 'acme', name: 'Acme (folder)' },
    { slug: 'default', name: 'QRSong!' },
  ];
  const lines = [
    { s: '', n: '' },
    { s: '', n: '' },
    { s: 'cannock', n: 'Cannock' },
    { s: 'acme--v3', n: 'Acme Company' },
    { s: 'cab12cd34ef-4', n: 'Zomerfeest' },
    { s: 'cab12cd34ef-4', n: 'Zomerfeest' },
    { s: 'c0011223344-1', n: '' },
  ];

  it('lists each B2B theme once by name, without the app default', () => {
    expect(themePickerEntries(business, lines, false)).toEqual([
      { slug: 'acme', name: 'Acme Company', source: 'business' },
      { slug: 'cannock', name: 'Cannock Hits', source: 'business' },
    ]);
  });

  it('adds each customer design once, after the B2B themes, in development', () => {
    expect(themePickerEntries(business, lines, true)).toEqual([
      { slug: 'acme', name: 'Acme Company', source: 'business' },
      { slug: 'cannock', name: 'Cannock Hits', source: 'business' },
      { slug: 'c0011223344-1', name: 'c0011223344-1', source: 'customer' },
      { slug: 'cab12cd34ef-4', name: 'Zomerfeest', source: 'customer' },
    ]);
  });
});
