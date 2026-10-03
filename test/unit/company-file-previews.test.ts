import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import {
  csvThumb,
  isPdfData,
  parseCsv,
  psdThumb,
  readPsdStructure,
  sheetSvg,
  xlsxThumb,
} from '../../src/companyFilePreviews';

/**
 * The previews the asset store draws for files sharp cannot open itself.
 * PSDs are built byte by byte here: the reader is ours, so the format is
 * what it has to get right.
 */

function resource(id: number, data: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head.write('8BIM', 0, 'latin1');
  head.writeUInt16BE(id, 4);
  // Empty Pascal name, padded to two bytes.
  head.writeUInt32BE(data.length, 8);
  return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
}

function packBitsRow(row: Buffer): Buffer {
  const out: Buffer[] = [];
  for (let i = 0; i < row.length; i += 128) {
    const chunk = row.subarray(i, i + 128);
    out.push(Buffer.from([chunk.length - 1]), chunk);
  }
  return Buffer.concat(out);
}

function buildPsd(o: {
  width: number;
  height: number;
  mode: number;
  depth?: number;
  planes: Buffer[];
  rle?: boolean;
  layerCount?: number;
  resources?: Buffer;
}): Buffer {
  const depth = o.depth ?? 8;
  const header = Buffer.alloc(26);
  header.write('8BPS', 0, 'latin1');
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(o.planes.length, 12);
  header.writeUInt32BE(o.height, 14);
  header.writeUInt32BE(o.width, 18);
  header.writeUInt16BE(depth, 22);
  header.writeUInt16BE(o.mode, 24);

  const resources = o.resources ?? Buffer.alloc(0);
  const resourcesLength = Buffer.alloc(4);
  resourcesLength.writeUInt32BE(resources.length);

  let layerMask = Buffer.alloc(4);
  if (o.layerCount) {
    layerMask = Buffer.alloc(10);
    layerMask.writeUInt32BE(6, 0);
    layerMask.writeUInt32BE(2, 4);
    layerMask.writeInt16BE(o.layerCount, 8);
  }

  const rowBytes = o.width * (depth / 8);
  let imageData: Buffer;
  if (o.rle) {
    const rows: Buffer[] = [];
    for (const plane of o.planes) {
      for (let y = 0; y < o.height; y++) rows.push(packBitsRow(plane.subarray(y * rowBytes, (y + 1) * rowBytes)));
    }
    const counts = Buffer.alloc(rows.length * 2);
    rows.forEach((r, i) => counts.writeUInt16BE(r.length, i * 2));
    imageData = Buffer.concat([Buffer.from([0, 1]), counts, ...rows]);
  } else {
    imageData = Buffer.concat([Buffer.from([0, 0]), ...o.planes]);
  }

  return Buffer.concat([header, Buffer.alloc(4), resourcesLength, resources, layerMask, imageData]);
}

async function pixel(webp: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(webp).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return Array.from(data.subarray(at, at + info.channels));
}

describe('PSD previews', () => {
  it('reads an RLE CMYK file (inverted ink) and converts it to RGB', async () => {
    // Left half no ink at all (stored as 255), right half full black.
    const w = 8;
    const h = 4;
    const plane = (left: number, right: number) =>
      Buffer.from(Array.from({ length: w * h }, (_, i) => (i % w < w / 2 ? left : right)));
    const file = buildPsd({
      width: w,
      height: h,
      mode: 4,
      rle: true,
      planes: [plane(255, 255), plane(255, 255), plane(255, 255), plane(255, 0)],
    });
    const thumb = await psdThumb(file);
    const [lr, lg, lb] = await pixel(thumb, 0, 1);
    const [dr, dg, db] = await pixel(thumb, w - 1, 1);
    expect(Math.min(lr, lg, lb)).toBeGreaterThan(220);
    expect(Math.max(dr, dg, db)).toBeLessThan(80);
  });

  it('reads raw 16-bit RGB by its top byte', async () => {
    const w = 4;
    const h = 2;
    const plane16 = (value: number) => {
      const b = Buffer.alloc(w * h * 2);
      for (let i = 0; i < w * h; i++) b.writeUInt16BE(value, i * 2);
      return b;
    };
    // Not uniform, or the reader would take it for a blank composite.
    const red = plane16(0xffff);
    red.writeUInt16BE(0x8000, 0);
    const file = buildPsd({ width: w, height: h, mode: 3, depth: 16, planes: [red, plane16(0), plane16(0)] });
    const [r, g, b] = await pixel(await psdThumb(file), w - 1, h - 1);
    expect(r).toBeGreaterThan(230);
    expect(g).toBeLessThan(30);
    expect(b).toBeLessThan(30);
  });

  it('keeps transparency when the layer count says the merged image has it', async () => {
    const w = 4;
    const h = 2;
    const fill = (v: number) => Buffer.alloc(w * h, v);
    const alpha = Buffer.alloc(w * h, 255);
    alpha[0] = 0;
    const file = buildPsd({
      width: w,
      height: h,
      mode: 3,
      layerCount: -1,
      planes: [fill(200), fill(10), fill(10), alpha],
    });
    expect(readPsdStructure(file).alpha).toBe(true);
    const thumb = await psdThumb(file);
    expect((await sharp(thumb).metadata()).hasAlpha).toBe(true);
    expect((await pixel(thumb, 0, 0))[3]).toBe(0);
    expect((await pixel(thumb, 1, 0))[3]).toBe(255);
  });

  it('falls back to the stored JPEG preview when the merged image is blank', async () => {
    const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#2050c0' } })
      .jpeg()
      .toBuffer();
    const header = Buffer.alloc(28);
    header.writeUInt32BE(1, 0);
    const file = buildPsd({
      width: 4,
      height: 4,
      mode: 3,
      planes: [Buffer.alloc(16, 255), Buffer.alloc(16, 255), Buffer.alloc(16, 255)],
      resources: resource(1036, Buffer.concat([header, jpeg])),
    });
    const [r, g, b] = await pixel(await psdThumb(file), 8, 8);
    expect(b).toBeGreaterThan(150);
    expect(r).toBeLessThan(80);
    expect(g).toBeLessThan(120);
  });

  it('refuses something that is not a PSD', async () => {
    await expect(psdThumb(Buffer.from('not a photoshop file at all'))).rejects.toThrow();
  });
});

describe('PDF detection', () => {
  it('finds the PDF inside an Illustrator file', () => {
    expect(isPdfData(Buffer.from('%PDF-1.5\n%...'))).toBe(true);
    expect(isPdfData(Buffer.from('%!PS-Adobe-3.0 EPSF-3.0'))).toBe(false);
  });
});

describe('spreadsheet previews', () => {
  it('parses CSV with a guessed delimiter, quotes and CRLF', () => {
    expect(parseCsv('Titel;Artiest\r\n"Hier ""Aan"" De Kust";Bløf\r\n', 10)).toEqual([
      ['Titel', 'Artiest'],
      ['Hier "Aan" De Kust', 'Bløf'],
    ]);
    expect(parseCsv('a,b\n1,2', 10)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a\nb\nc\nd', 2)).toEqual([['a'], ['b']]);
  });

  it('escapes cell text and drops characters XML forbids', () => {
    const svg = sheetSvg({
      name: 'Blad <1>',
      widths: [12, 12],
      rows: [[{ text: '<script>alert(1)</script> & co\u0001' }, { text: '42', number: true }]],
    });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; co');
    expect(svg).not.toContain('\u0001');
    expect(svg).toContain('Blad &lt;1&gt;');
    expect(svg).toContain('text-anchor="end"');
  });

  it('draws the first sheet of a workbook with its own values', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Playlist');
    sheet.getColumn(2).width = 30;
    sheet.addRow(['Nr', 'Titel', 'Artiest']);
    sheet.getRow(1).font = { bold: true };
    sheet.addRow([1, 'Brabant', 'Guus Meeuwis']);
    sheet.addRow([2, { formula: 'B2', result: 'Brabant' }, new Date('2026-10-03')]);
    const svg = await xlsxThumb(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(svg).toContain('Guus Meeuwis');
    expect(svg).toContain('2026-10-03');
    expect(svg).toContain('font-weight="700"');
    expect(svg).toContain('>Playlist<');
    // It is an image a browser can draw.
    expect((await sharp(Buffer.from(svg)).metadata()).format).toBe('svg');
  });

  it('draws a CSV the same way', () => {
    const svg = csvThumb('Titel,Artiest\nBrabant,Guus Meeuwis\n');
    expect(svg).toContain('Guus Meeuwis');
    expect(svg).toContain('>CSV<');
  });
});
