import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import QRCode from 'qrcode';
import { isCardLink, readQr } from '../../src/qrRead';

const LINK = 'https://api.qrsong.io/qr2/12345/678';

/** A card front: a background with the code on a square, as the print does. */
async function front(dark: string, light: string, background: string): Promise<Buffer> {
  const code = await QRCode.toBuffer(LINK, { width: 260, margin: 2, color: { dark, light } });
  return sharp({ create: { width: 510, height: 510, channels: 3, background } })
    .composite([{ input: code, gravity: 'centre' }])
    .png()
    .toBuffer();
}

describe('readQr', () => {
  it('reads the link of a plain code', async () => {
    expect(await readQr(await front('#000000', '#ffffff', '#3366cc'))).toBe(LINK);
  });

  it('reads a light code on a dark square: the app scans inverted codes', async () => {
    expect(await readQr(await front('#ffffff', '#101820', '#101820'))).toBe(LINK);
  });

  it('reads nothing from a code in nearly the colour of its square, or from no code', async () => {
    expect(await readQr(await front('#262626', '#202020', '#202020'))).toBeNull();
    const blank = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ffffff' } }).png().toBuffer();
    expect(await readQr(blank)).toBeNull();
    expect(await readQr(Buffer.from('not a picture'))).toBeNull();
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
