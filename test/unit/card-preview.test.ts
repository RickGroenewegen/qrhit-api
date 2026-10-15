import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { PDFDocument, rgb } from 'pdf-lib';
import PDF from '../../src/pdf';
import { renderPdfPages } from '../../src/pdfRaster';
import CardPreviews, {
  BLEED_MM,
  CardPreviewError,
  DIE_PX,
  PREVIEW_PX,
  cropToCut,
  dieLinesSvg,
  drawDieLines,
  drawDieView,
  parseDieViews,
  previewName,
  previewSource,
  withBleed,
} from '../../src/cardPreview';

/**
 * The printer card pictures (src/cardPreview.ts): which source the
 * dashboard's preview reads, the name that changes with everything a picture
 * shows, the bleed it cuts off and the printer's guides it draws, for the
 * dashboard and for the qrsong toolkit's cut-check. The crop is checked
 * against pdf.ts addBleed itself on a real PDF, rendered through PDFium, so a
 * change to either shows up here.
 */

const MM = 72 / 25.4;
const SCALE = 5;

/** A card of `sizeMm`: blue, its left half red, a 2 mm green frame (inside what gets cut). */
async function cardPdf(sizeMm: number, frameMm = 2): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const side = sizeMm * MM;
  for (let p = 0; p < 2; p++) {
    const page = doc.addPage([side, side]);
    page.drawRectangle({ x: 0, y: 0, width: side, height: side, color: rgb(0, 1, 0) });
    const inset = frameMm * MM;
    page.drawRectangle({ x: inset, y: inset, width: side - 2 * inset, height: side - 2 * inset, color: rgb(0, 0, 1) });
    page.drawRectangle({ x: inset, y: inset, width: side / 2 - inset, height: side - 2 * inset, color: rgb(1, 0, 0) });
  }
  return Buffer.from(await doc.save());
}

async function pixels(png: Buffer) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Share of the pixels that are clearly green. */
async function greenShare(png: Buffer): Promise<number> {
  const { data } = await pixels(png);
  let green = 0;
  for (let i = 0; i < data.length; i += 3) {
    if (data[i + 1] > 150 && data[i] < 100 && data[i + 2] < 100) green++;
  }
  return green / (data.length / 3);
}

/** The RGB of pixel (x, y). */
async function pixelAt(png: Buffer, x: number, y: number): Promise<number[]> {
  const { data, width } = await pixels(png);
  return Array.from(data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3));
}

const isMagenta = ([r, g, b]: number[]) => r > 200 && g < 80 && b > 100;
const isCyan = ([r, g, b]: number[]) => r < 80 && g > 120 && b > 180;
const white = (side: number) => sharp({ create: { width: side, height: side, channels: 3, background: '#ffffff' } }).png().toBuffer();

describe('card preview', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'card-preview-'));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('renderPdfPages', () => {
    it('gives the exact page size, not the one pdfium floors to whole points', async () => {
      const [page] = await renderPdfPages(await cardPdf(62), [1], SCALE);
      expect(page.widthMm).toBeCloseTo(62, 3);
      // 62 mm is 175.7 pt: 879 px at 5 px per point, not 875
      expect((await sharp(page.png).metadata()).width).toBe(879);
    });
  });

  describe('cropToCut', () => {
    it('leaves the card as cut, as a square of PREVIEW_PX', async () => {
      // 620 px for 62 mm: a 30 px green bleed around a blue card
      const page = await sharp({ create: { width: 620, height: 620, channels: 3, background: '#00ff00' } })
        .composite([{ input: await sharp({ create: { width: 560, height: 560, channels: 3, background: '#0000ff' } }).png().toBuffer(), left: 30, top: 30 }])
        .png()
        .toBuffer();
      const cut = await cropToCut(page, 62);
      const meta = await sharp(cut).metadata();
      expect([meta.width, meta.height]).toEqual([PREVIEW_PX, PREVIEW_PX]);
      expect(await greenShare(page)).toBeGreaterThan(0.18);
      expect(await greenShare(cut)).toBe(0);
    });
  });

  describe('withBleed', () => {
    it('gives a fresh render the page addBleed makes of it, so both cut to the same card', async () => {
      const raw = await cardPdf(56);
      const bledFile = path.join(dir, 'bled.pdf');
      await fs.writeFile(bledFile, raw);
      await new PDF().addBleed(bledFile, BLEED_MM);

      const [rawPage] = await renderPdfPages(raw, [1], SCALE);
      const [pdfPage] = await renderPdfPages(await fs.readFile(bledFile), [1], SCALE);
      expect(pdfPage.widthMm).toBeCloseTo(62, 2);
      expect(await greenShare(rawPage.png)).toBeGreaterThan(0.1);

      const fromRender = await withBleed(rawPage.png, rawPage.widthMm, false);
      const fromPdf = await withBleed(pdfPage.png, pdfPage.widthMm, true);
      expect(fromPdf.png).toBe(pdfPage.png);
      expect(fromRender.pageMm).toBeCloseTo(62, 2);

      const cutRender = await cropToCut(fromRender.png, fromRender.pageMm);
      const cutPdf = await cropToCut(fromPdf.png, fromPdf.pageMm);
      // The frame is inside what the printer cuts off, in both
      expect(await greenShare(cutRender)).toBeLessThan(0.002);
      expect(await greenShare(cutPdf)).toBeLessThan(0.002);

      const a = await pixels(cutRender);
      const b = await pixels(cutPdf);
      let diff = 0;
      for (let i = 0; i < a.data.length; i++) diff += Math.abs(a.data[i] - b.data[i]);
      expect(diff / a.data.length).toBeLessThan(3);
      // Red left, blue right: nothing mirrored or shifted
      expect(await pixelAt(cutRender, 100, 360)).toEqual([255, 0, 0]);
      expect(await pixelAt(cutRender, 620, 360)).toEqual([0, 0, 255]);
    });
  });

  describe('die lines', () => {
    it('draws the die line 3 mm in with the die\'s corner, the safe line 3 mm inside it, the bleed edge dashed', () => {
      // 620 px for a 62 mm page: 10 px per mm
      const svg = dieLinesSvg(620, 62);
      // die line: the 56 mm card, corners 4.35 mm
      expect(svg).toContain('<rect x="30.00" y="30.00" width="560.00" height="560.00" rx="43.50" ry="43.50" fill="none" stroke="#ec008c" stroke-width="2.50"/>');
      // safe zone: 3 mm inside, the corner 3 mm smaller
      expect(svg).toContain('<rect x="60.00" y="60.00" width="500.00" height="500.00" rx="13.50" ry="13.50" fill="none" stroke="#00a0d2" stroke-width="1.50"/>');
      // bleed edge: dashed, just inside the page edge
      expect(svg).toContain('<rect x="1.50" y="1.50" width="617.00" height="617.00" rx="0.00" ry="0.00" fill="none" stroke="#5a5a5a" stroke-width="1.50" stroke-dasharray="20.00"/>');
      // a 60 mm card gets the same corner in proportion
      expect(dieLinesSvg(660, 66)).toContain('rx="46.61"');
    });

    it('keeps the card in the middle of a page with more margin, and draws a part of it to scale', () => {
      // Schneiders' own template: a 68 mm page, the die line 6 mm in
      expect(dieLinesSvg(680, 68, 56)).toContain('<rect x="60.00" y="60.00" width="560.00" height="560.00" rx="43.50"');
      // 6 mm around the middle of the top edge at 420 px (70 px per mm): the die line 3 mm down, its line 0.1 mm
      const zoom = dieLinesSvg(420, 62, 56, { x: 28, y: 0, sizeMm: 6 });
      expect(zoom).toContain('<rect x="-1750.00" y="210.00" width="3920.00" height="3920.00" rx="304.50" ry="304.50" fill="none" stroke="#ec008c" stroke-width="7.00"/>');
    });

    it('puts them on the page with its bleed', async () => {
      const die = await drawDieLines(await white(620), 62);
      const meta = await sharp(die).metadata();
      expect([meta.width, meta.height]).toEqual([DIE_PX, DIE_PX]);
      const px = DIE_PX / 62;
      // the middle of the top edge: magenta at 3 mm, cyan at 6 mm, white between
      expect(isMagenta(await pixelAt(die, DIE_PX / 2, Math.round(3 * px)))).toBe(true);
      expect(isCyan(await pixelAt(die, DIE_PX / 2, Math.round(6 * px)))).toBe(true);
      expect(await pixelAt(die, DIE_PX / 2, Math.round(4.5 * px))).toEqual([255, 255, 255]);
      // the die's round corner leaves the card's corner point outside the line
      expect(await pixelAt(die, Math.round(3.3 * px), Math.round(3.3 * px))).toEqual([255, 255, 255]);
    });

    it('draws a part of the page, or the page alone', async () => {
      const page = await white(620);
      const corner = await drawDieView(page, 62, 56, { px: 420, x: 0, y: 0, sizeMm: 9 });
      expect((await sharp(corner).metadata()).width).toBe(420);
      // 9 mm at 420 px: the die line's straight top edge 3 mm down, at x = 8 mm
      expect(isMagenta(await pixelAt(corner, Math.round((8 * 420) / 9), Math.round((3 * 420) / 9)))).toBe(true);
      const plain = await drawDieView(page, 62, 56, { px: 300, guides: false });
      expect(await pixelAt(plain, 150, Math.round((3 * 300) / 62))).toEqual([255, 255, 255]);
    });
  });

  describe('parseDieViews', () => {
    it('defaults to the whole page and checks every view', () => {
      expect(parseDieViews(undefined)).toEqual([{ px: DIE_PX }]);
      expect(parseDieViews('[{"px":420,"x":1.6,"y":1.6,"sizeMm":6},{"px":1465,"guides":false}]')).toEqual([
        { px: 420, x: 1.6, y: 1.6, sizeMm: 6 },
        { px: 1465, guides: false },
      ]);
      expect(() => parseDieViews('nope')).toThrow(/not valid JSON/);
      expect(() => parseDieViews('[]')).toThrow(/1 to 12 views/);
      expect(() => parseDieViews('[{"px":5000}]')).toThrow(/px must be 50 to 3000/);
      expect(() => parseDieViews('[{"px":400,"sizeMm":0}]')).toThrow(/sizeMm must be a positive/);
      expect(() => parseDieViews('[{"px":400,"x":-1}]')).toThrow(CardPreviewError);
    });
  });

  describe('dieLines of an upload', () => {
    it('draws the guides on every asked page of a PDF, taken as it is', async () => {
      const raw = await cardPdf(56);
      const bledFile = path.join(dir, 'upload.pdf');
      await fs.writeFile(bledFile, raw);
      await new PDF().addBleed(bledFile, BLEED_MM);
      const result = await CardPreviews.getInstance().dieLines({
        file: await fs.readFile(bledFile),
        pages: '1,2',
        views: JSON.stringify([{ px: 620 }, { px: 310, guides: false }]),
      });
      expect(result.source).toBe('upload');
      expect(result.cardMm).toBe(56);
      expect(result.pages.map((p) => [p.page, p.pageMm])).toEqual([
        [1, 62],
        [2, 62],
      ]);
      const [guides, plain] = result.pages[0].views;
      expect(guides).toMatchObject({ x: 0, y: 0, px: 620, guides: true });
      expect(plain).toMatchObject({ px: 310, guides: false });
      // the die line 3 mm in, over the red half
      expect(isMagenta(await pixelAt(guides.png, 100, 30))).toBe(true);
      expect(await pixelAt(plain.png, 50, 15)).toEqual([255, 0, 0]);
    });

    it('takes a PNG canvas as card plus bleed, and refuses what it cannot draw', async () => {
      const result = await CardPreviews.getInstance().dieLines({ file: await white(620), views: '[{"px":620}]' });
      expect(result.pages[0].pageMm).toBe(62);
      expect(isMagenta(await pixelAt(result.pages[0].views[0].png, 310, 30))).toBe(true);

      const dl = (input: Parameters<CardPreviews['dieLines']>[0]) => CardPreviews.getInstance().dieLines(input);
      await expect(dl({})).rejects.toThrow(/a file or a paymentHasPlaylistId/);
      await expect(dl({ file: Buffer.from('not a picture') })).rejects.toThrow(/a PDF, PNG or JPEG/);
      await expect(dl({ file: await white(620), pageMm: 40 })).rejects.toThrow(/smaller than the 56 mm card/);
      await expect(dl({ file: await white(620), views: '[{"px":400,"x":60,"y":0,"sizeMm":9}]' })).rejects.toThrow(/runs off the 62.0 mm page/);
      await expect(dl({ file: Buffer.from('%PDF-1.4 broken') })).rejects.toThrow(/does not render/);
    });
  });

  describe('previewSource', () => {
    it('reads the printer PDF only while it is current', () => {
      expect(previewSource(true, 'abc', 'abc')).toBe('pdf');
      expect(previewSource(true, 'abc', 'def')).toBe('render');
      expect(previewSource(false, 'abc', 'abc')).toBe('render');
      expect(previewSource(true, null, 'abc')).toBe('render');
    });
  });

  describe('previewName', () => {
    const parts = { source: 'pdf', template: 'asito', version: 1, file: null, cardSizeMm: 56, card: 'f00', pdf: 'a.pdf:1:2' };

    it('names the line and stays the same for the same picture', () => {
      expect(previewName(10286, parts)).toMatch(/^10286-[0-9a-f]{32}$/);
      expect(previewName(10286, { ...parts })).toBe(previewName(10286, parts));
    });

    it('changes with everything the picture shows', () => {
      const base = previewName(10286, parts);
      for (const change of [
        { source: 'render', pdf: null },
        { version: 2 },
        { template: 'sportstuif', version: null, file: 1760000000000 },
        { card: 'f01' },
        { cardSizeMm: 60 },
        { pdf: 'a.pdf:3:2' },
      ]) {
        expect(previewName(10286, { ...parts, ...change })).not.toBe(base);
      }
      expect(previewName(10287, parts)).not.toBe(base);
    });

    it('cannot be worked out without the secret', () => {
      const secret = process.env['JWT_SECRET'];
      const base = previewName(10286, parts);
      process.env['JWT_SECRET'] = `${secret}-other`;
      try {
        expect(previewName(10286, parts)).not.toBe(base);
      } finally {
        process.env['JWT_SECRET'] = secret;
      }
    });
  });
});
