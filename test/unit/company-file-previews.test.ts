import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { PDFDocument, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { deflateRawSync } from 'zlib';
import {
  csvThumb,
  isPdfData,
  parseCsv,
  pdfThumb,
  psdThumb,
  readPsdStructure,
  sheetSvg,
  xlsxThumb,
  xlsxUnpacksWithin,
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

  it('does not believe a header whose image is not in the file', async () => {
    // A small file that claims to be 299,999 rows high, raw and RLE alike: it
    // must be refused at once, not looped over or allocated for.
    for (const rle of [false, true]) {
      const file = buildPsd({ width: 4, height: 4, mode: 3, rle, planes: [Buffer.alloc(16, 9), Buffer.alloc(16), Buffer.alloc(16)] });
      file.writeUInt32BE(299_999, 14);
      const started = Date.now();
      await expect(psdThumb(file)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1000);
    }
    const huge = buildPsd({ width: 4, height: 4, mode: 3, planes: [Buffer.alloc(16, 9), Buffer.alloc(16), Buffer.alloc(16)] });
    huge.writeUInt32BE(4_000_000_000, 18);
    await expect(psdThumb(huge)).rejects.toThrow();
  });
});

describe('PDF previews', () => {
  it('finds the PDF inside an Illustrator file', () => {
    expect(isPdfData(Buffer.from('%PDF-1.5\n%...'))).toBe(true);
    expect(isPdfData(Buffer.from('%!PS-Adobe-3.0 EPSF-3.0'))).toBe(false);
  });

  it('scales a very tall page by its longer side', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([2, 14400]).drawRectangle({ x: 0, y: 0, width: 2, height: 14400, color: rgb(0, 0, 0) });
    const meta = await sharp(await pdfThumb(Buffer.from(await pdf.save()))).metadata();
    expect(meta.height).toBeLessThanOrEqual(480);
    expect(meta.width).toBeLessThanOrEqual(480);
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

  it('reads only the start of a CSV', () => {
    const started = Date.now();
    const svg = csvThumb(Buffer.alloc(20 * 1024 * 1024, 'a'));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(svg).toContain('<svg');
  });

  it('measures a real workbook and lets it through', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Blad1').addRow(['a']);
    const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await xlsxUnpacksWithin(xlsx, 64 * MB)).toBe(true);
    await expect(xlsxThumb(Buffer.from('not a zip'))).rejects.toThrow();
  });

  it('stops counting a zip bomb that lies about its size', async () => {
    // Declares 100 bytes, unpacks to 70 MB; JSZip itself would only notice at the end.
    const bomb = zipOf([{ name: 'xl/worksheets/sheet1.xml', content: Buffer.alloc(70 * MB), declaredSize: 100 }]);
    expect(await xlsxUnpacksWithin(bomb, 64 * MB)).toBe(false);
    await expect(xlsxThumb(bomb)).rejects.toThrow(/too large/);
  });

  it('adds up every entry exceljs would read', async () => {
    const one = { name: 'xl/worksheets/sheet1.xml', content: Buffer.alloc(40 * MB), declaredSize: 40 * MB };
    expect(await xlsxUnpacksWithin(zipOf([one]), 64 * MB)).toBe(true);
    const two = zipOf([one, { ...one, name: 'xl/worksheets/sheet2.xml' }]);
    expect(await xlsxUnpacksWithin(two, 64 * MB)).toBe(false);
  });

  it('refuses a lying entry under the limit as well, as exceljs would fail on it', async () => {
    const liar = zipOf([{ name: 'xl/worksheets/sheet1.xml', content: Buffer.alloc(MB), declaredSize: 100 }]);
    await expect(xlsxUnpacksWithin(liar, 64 * MB)).rejects.toThrow(/size mismatch/);
  });

  it('does not open a workbook file over 10 MB', async () => {
    await expect(xlsxThumb(Buffer.alloc(11 * MB))).rejects.toThrow(/too large/);
  });
});

const MB = 1024 * 1024;

/** A zip of deflated files, each declaring `declaredSize` as what it unpacks to. */
function zipOf(files: { name: string; content: Buffer; declaredSize: number }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = deflateRawSync(file.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(file.declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(file.declaredSize, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(entry, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
