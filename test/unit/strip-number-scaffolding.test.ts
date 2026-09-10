import { describe, it, expect } from 'vitest';
import { stripNumberScaffolding } from '../../src/chatgpt';

/**
 * The four fragments below are the ones that actually reached the live
 * catalogue, copied from www.qrsong.io/en/playlists.
 */
describe('stripNumberScaffolding', () => {
  it('removes the labelled figure lists that leaked into live descriptions', () => {
    const cases: Array<[string, string]> = [
      [
        "Musicals deutsch serves up 262 tracks from Andrew Lloyd Webber to Meat Loaf. Numbers you'll spot: 1990, 8 — hit play and let QRSong do the rest.",
        "Musicals deutsch serves up 262 tracks from Andrew Lloyd Webber to Meat Loaf. Hit play and let QRSong do the rest.",
      ],
      [
        'QRSong! Kerst brings 300 tracks of festive vibes with Mariah, Elvis, Frank, and more. Numbers from the list: 300, 2000, 2 — hit play with QRSong! and keep the cheer going.',
        'QRSong! Kerst brings 300 tracks of festive vibes with Mariah, Elvis, Frank, and more. Hit play with QRSong! and keep the cheer going.',
      ],
      [
        'A big pile of rock. Numbers to spot: 883, 13, 96 — press play.',
        'A big pile of rock. Press play.',
      ],
      [
        'Party starters all night. Numbers in the mix: 188, 2014, 2k12— enjoy.',
        'Party starters all night. Enjoy.',
      ],
    ];
    for (const [input, expected] of cases) {
      expect(stripNumberScaffolding(input)).toBe(expected);
    }
  });

  it('leaves ordinary descriptions untouched, figures included', () => {
    const clean = [
      'Dive into 262 tracks of showtunes, from Webber to Newton-John. Scan and play with QRSong!',
      'Punk rock across 206 tracks. Loud, fast and ready for a party.',
      'Sixties soul with 120 tracks, mostly 1960s and 1970s.',
    ];
    for (const text of clean) {
      expect(stripNumberScaffolding(text)).toBe(text);
    }
  });

  it('handles empty input without throwing', () => {
    expect(stripNumberScaffolding('')).toBe('');
    expect(stripNumberScaffolding(undefined as unknown as string)).toBe(
      undefined as unknown as string
    );
  });
});
