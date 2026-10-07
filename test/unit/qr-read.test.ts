import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import QRCode from 'qrcode';
import { isCardLink, readQrCodes } from '../../src/qrRead';

const LINK = 'https://api.qrsong.io/qr2/12345/678';

/** A card front: a background with the code on a square, as the print does. */
async function front(dark: string, light: string, background: string, size = 510, link = LINK): Promise<Buffer> {
  const code = await QRCode.toBuffer(link, { width: Math.round(size * 0.51), margin: 2, color: { dark, light } });
  return sharp({ create: { width: size, height: size, channels: 3, background } })
    .composite([{ input: code, gravity: 'centre' }])
    .png()
    .toBuffer();
}

describe('readQrCodes', () => {
  it('reads the link of a plain code', async () => {
    expect(await readQrCodes(await front('#000000', '#ffffff', '#3366cc'))).toEqual([LINK]);
  });

  it('reads a light code on a dark square: the app scans inverted codes', async () => {
    expect(await readQrCodes(await front('#ffffff', '#101820', '#101820'))).toEqual([LINK]);
  });

  it('reads a plain code at every size finalCheck renders a card', async () => {
    for (const size of [374, 467, 561, 654, 748]) {
      expect(await readQrCodes(await front('#000000', '#ffffff', '#ffffff', size))).toEqual([LINK]);
    }
  });

  it('reads every code on a sheet', async () => {
    const cards = await Promise.all(
      Array.from({ length: 12 }, (_, n) => front('#000000', '#ffffff', '#ffffff', 300, `https://api.qrsong.io/qr2/${n + 1}/678`))
    );
    const sheet = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#ffffff' } })
      .composite(cards.map((input, n) => ({ input, left: (n % 3) * 300, top: Math.floor(n / 3) * 300 })))
      .png()
      .toBuffer();
    const texts = await readQrCodes(sheet);
    expect(texts).toHaveLength(12);
    expect(texts.every((text) => isCardLink(text, 678))).toBe(true);
  });

  it('reads nothing from a code in nearly the colour of its square, or from no code', async () => {
    expect(await readQrCodes(await front('#262626', '#202020', '#202020'))).toEqual([]);
    const blank = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ffffff' } }).png().toBuffer();
    expect(await readQrCodes(blank)).toEqual([]);
    expect(await readQrCodes(Buffer.from('not a picture'))).toEqual([]);
  });
});

describe('isCardLink', () => {
  it('knows the link of a card of this order line, and no other', () => {
    expect(isCardLink(LINK, 678)).toBe(true);
    expect(isCardLink('http://localhost:3004/qr2/9/678', 678)).toBe(true);
    expect(isCardLink(LINK, 67)).toBe(false);
    expect(isCardLink('https://example.com/whatever', 678)).toBe(false);
  });
});
