import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { measureDrift } from '../../src/designDrift';

const SIZE = 600;

/** A card front: a photo-like background, a white QR square with modules in the middle, a logo. */
async function card(options: { background?: [number, number, number]; seed?: number; shift?: number; blank?: boolean } = {}) {
  const [r, g, b] = options.background ?? [40, 90, 160];
  if (options.blank) {
    return sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: '#ffffff' } }).png().toBuffer();
  }
  // A gradient-ish background: two colour bands
  const bands = await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: { r, g, b } } })
    .composite([
      {
        input: await sharp({ create: { width: SIZE, height: SIZE / 2, channels: 3, background: { r: Math.min(255, r + 60), g: Math.min(255, g + 40), b } } }).png().toBuffer(),
        top: SIZE / 2,
        left: 0,
      },
    ])
    .png()
    .toBuffer();
  // The QR code: a white square with black modules from a seed
  const modules = 25;
  const cell = Math.floor((SIZE * 0.5) / modules);
  const qrSide = cell * modules;
  const svgCells: string[] = [];
  let state = options.seed ?? 1;
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      if (state % 2) svgCells.push(`<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}"/>`);
    }
  }
  const qr = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${qrSide}" height="${qrSide}"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${svgCells.join('')}</g></svg>`);
  const shift = options.shift ?? 0;
  return sharp(bands)
    .composite([
      { input: qr, top: Math.round((SIZE - qrSide) / 2) + shift, left: Math.round((SIZE - qrSide) / 2) + shift },
      { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="0" y="30" font-size="28" fill="#fff">Logo</text></svg>`), top: 30 + shift, left: 30 + shift },
    ])
    .png()
    .toBuffer();
}

describe('measureDrift', () => {
  it('sees nothing in the same render', async () => {
    const page = await card();
    expect(await measureDrift(page, page)).toEqual({ changed: 0, colours: 0, drifted: false });
  });

  it('ignores compression, a QR code with another payload and a page shifted a few pixels', async () => {
    const page = await card();
    const jpeg = await sharp(page).jpeg({ quality: 60 }).toBuffer();
    const otherQr = await card({ seed: 99 });
    const shifted = await card({ shift: 4 });
    for (const live of [jpeg, otherQr, shifted]) {
      const measure = await measureDrift(page, live);
      expect(measure.drifted).toBe(false);
    }
    // The QR code is the biggest of these, and still well under the share
    expect((await measureDrift(page, otherQr)).changed).toBeLessThan(0.3);
  });

  it('sees another background and a blank render', async () => {
    const page = await card();
    for (const live of [await card({ background: [200, 30, 40] }), await card({ blank: true })]) {
      const measure = await measureDrift(page, live);
      expect(measure.changed).toBeGreaterThan(0.3);
      expect(measure.colours).toBeGreaterThan(0.25);
      expect(measure.drifted).toBe(true);
    }
  });

  it('takes its thresholds from the environment', async () => {
    const page = await card();
    const other = await card({ background: [200, 30, 40] });
    process.env['DRIFT_SHARE'] = '0.99';
    try {
      expect((await measureDrift(page, other)).drifted).toBe(false);
    } finally {
      delete process.env['DRIFT_SHARE'];
    }
  });
});
