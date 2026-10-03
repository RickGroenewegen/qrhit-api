import ExcelJS from 'exceljs';
import { PDFParse } from 'pdf-parse';
import sharp from 'sharp';

/**
 * Thumbnails for the asset store (companyFiles.ts decides which file gets
 * which and caches the result next to the file):
 *
 * - images: sharp, as they are;
 * - PDF and Illustrator (an .ai file is a PDF inside): the first page;
 * - PSD: the merged image Photoshop saves next to the layers;
 * - spreadsheets (xlsx, csv): the top-left corner, drawn as an SVG that the
 *   browser renders with its own fonts (the API servers have none to speak of).
 *
 * Raster previews are made at twice the thumbnail size and scaled down by
 * sharp, so text and lines stay smooth.
 */

export const THUMB_SIZE = 480;
const RENDER_SIZE = THUMB_SIZE * 2;

/**
 * Limits, because brand kits come from the public /business form: every
 * renderer here must stay bounded in memory and time whatever a file claims.
 * 100 megapixels is a 10,000 px square, more than an A1 poster at 300 dpi.
 */
const MAX_INPUT_PIXELS = 100_000_000;
/** PSB's own limit (PSD's is 30,000). */
const PSD_MAX_SIDE = 300_000;
/** A preview needs the first rows only. */
const CSV_MAX_BYTES = 256 * 1024;
/** What an xlsx may unpack to, by its own directory; more is refused unread. */
const XLSX_MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

export async function webpThumb(input: Buffer | string): Promise<Buffer> {
  return sharp(input, { animated: false, limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

export function isPdfData(buffer: Buffer): boolean {
  return buffer.subarray(0, 1024).includes('%PDF-');
}

export async function pdfThumb(buffer: Buffer): Promise<Buffer> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    // Scale by the longer side: a page 1 pt wide and 14,400 pt tall would
    // otherwise get a canvas of millions of pixels high.
    const info = await parser.getInfo({ parsePageInfo: true, first: 1 });
    const page1 = info.pages?.[0];
    const longest = Math.max(page1?.width ?? 0, page1?.height ?? 0);
    if (!Number.isFinite(longest) || longest <= 0) throw new Error('The PDF has no first page size');
    const result = await parser.getScreenshot({
      first: 1,
      scale: RENDER_SIZE / longest,
      imageBuffer: true,
      imageDataUrl: false,
    });
    const page = result.pages?.[0];
    if (!page?.data) throw new Error('The PDF has no first page to render');
    return webpThumb(Buffer.from(page.data));
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

// ---- PSD ------------------------------------------------------------------

/**
 * ag-psd was tried first and refuses CMYK, which is what print files are.
 * This reads the merged image itself: grayscale, RGB and CMYK, 8 or 16 bits,
 * raw or RLE, PSD and PSB. Only every n-th row and column is decoded (about
 * twice the thumbnail size), so a 300 dpi box file costs a few MB, not
 * hundreds. The result is wrapped in an uncompressed TIFF with the file's own
 * ICC profile, so sharp converts CMYK the way Photoshop shows it.
 *
 * A file saved without "Maximise compatibility" has a blank merged image;
 * then, and for anything this does not read (bitmap, indexed, Lab, 32 bit),
 * the small JPEG preview Photoshop stores in the file is used instead.
 */
export async function psdThumb(buffer: Buffer): Promise<Buffer> {
  const psd = readPsdStructure(buffer);
  let image: Buffer | null = null;
  try {
    image = psdComposite(buffer, psd);
  } catch {
    image = null;
  }
  image ??= psd.thumbnail;
  if (!image) throw new Error('The PSD has no merged image or preview');
  return webpThumb(image);
}

interface PsdStructure {
  psb: boolean;
  channels: number;
  width: number;
  height: number;
  depth: number;
  mode: number;
  icc: Buffer | null;
  thumbnail: Buffer | null;
  /** The merged image's channels carry transparency as the first extra one. */
  alpha: boolean;
  imageDataStart: number;
}

const PSD_GRAYSCALE = 1;
const PSD_RGB = 3;
const PSD_CMYK = 4;
const PSD_DUOTONE = 8;

export function readPsdStructure(buffer: Buffer): PsdStructure {
  if (buffer.length < 26 || buffer.toString('latin1', 0, 4) !== '8BPS') {
    throw new Error('Not a Photoshop file');
  }
  const version = buffer.readUInt16BE(4);
  if (version !== 1 && version !== 2) throw new Error(`Unknown PSD version ${version}`);
  const psb = version === 2;
  const readLength = (at: number) =>
    psb ? Number(buffer.readBigUInt64BE(at)) : buffer.readUInt32BE(at);
  const lengthSize = psb ? 8 : 4;

  let pos = 26;
  pos += 4 + buffer.readUInt32BE(pos); // colour mode data

  const resourcesLength = buffer.readUInt32BE(pos);
  const resources = readImageResources(buffer, pos + 4, pos + 4 + resourcesLength);
  pos += 4 + resourcesLength;

  // A negative layer count means the merged image has a transparency channel.
  const layerMaskLength = readLength(pos);
  const layerMaskStart = pos + lengthSize;
  let layerCount = 0;
  if (layerMaskLength >= lengthSize + 2 && readLength(layerMaskStart) >= 2) {
    layerCount = buffer.readInt16BE(layerMaskStart + lengthSize);
  }

  const thumbResource = resources.get(1036);
  const thumbnail =
    thumbResource && thumbResource.length > 28 && thumbResource.readUInt32BE(0) === 1
      ? thumbResource.subarray(28)
      : null;

  return {
    psb,
    channels: buffer.readUInt16BE(12),
    height: buffer.readUInt32BE(14),
    width: buffer.readUInt32BE(18),
    depth: buffer.readUInt16BE(22),
    mode: buffer.readUInt16BE(24),
    icc: resources.get(1039) ?? null,
    thumbnail,
    alpha: layerCount < 0,
    imageDataStart: layerMaskStart + layerMaskLength,
  };
}

function readImageResources(buffer: Buffer, start: number, end: number): Map<number, Buffer> {
  const resources = new Map<number, Buffer>();
  let pos = start;
  while (pos + 12 <= end) {
    const id = buffer.readUInt16BE(pos + 4);
    const nameLength = buffer[pos + 6];
    let at = pos + 7 + nameLength;
    if ((nameLength + 1) % 2) at++;
    const size = buffer.readUInt32BE(at);
    at += 4;
    resources.set(id, buffer.subarray(at, Math.min(at + size, end)));
    pos = at + size + (size % 2);
  }
  return resources;
}

function psdComposite(buffer: Buffer, psd: PsdStructure): Buffer | null {
  const colourChannels =
    psd.mode === PSD_RGB ? 3 : psd.mode === PSD_CMYK ? 4 : psd.mode === PSD_GRAYSCALE || psd.mode === PSD_DUOTONE ? 1 : 0;
  if (!colourChannels || (psd.depth !== 8 && psd.depth !== 16) || psd.channels < colourChannels) return null;
  const { width, height } = psd;
  if (!width || !height || width > PSD_MAX_SIDE || height > PSD_MAX_SIDE) return null;

  let pos = psd.imageDataStart;
  const compression = buffer.readUInt16BE(pos);
  pos += 2;
  if (compression !== 0 && compression !== 1) return null;

  const alpha = psd.alpha && psd.channels > colourChannels;
  const samples = colourChannels + (alpha ? 1 : 0);
  const step = Math.max(1, Math.floor(Math.max(width, height) / RENDER_SIZE));
  const outWidth = Math.ceil(width / step);
  const outHeight = Math.ceil(height / step);
  const bytesPerSample = psd.depth / 8;
  const rowBytes = width * bytesPerSample;
  const rows = samples * height;

  // The header's size is a claim: the data it describes must be in the file
  // before anything is allocated or looped over for it.
  const countSize = psd.psb ? 4 : 2;
  const firstRow = compression === 0 ? pos : pos + psd.channels * height * countSize;
  if (compression === 0 ? firstRow + rows * rowBytes > buffer.length : firstRow > buffer.length) return null;

  // Where each row of each channel starts (and the next one begins).
  const rowStart = new Float64Array(rows + 1);
  if (compression === 0) {
    for (let i = 0; i <= rows; i++) rowStart[i] = pos + i * rowBytes;
  } else {
    let offset = firstRow;
    for (let i = 0; i < rows; i++) {
      rowStart[i] = offset;
      offset += psd.psb ? buffer.readUInt32BE(pos + i * 4) : buffer.readUInt16BE(pos + i * 2);
    }
    rowStart[rows] = offset;
  }
  if (rowStart[rows] > buffer.length) return null;

  const out = Buffer.alloc(outWidth * outHeight * samples);
  const row = Buffer.alloc(rowBytes);
  let first = -1;
  let uniform = true;
  for (let c = 0; c < samples; c++) {
    for (let oy = 0; oy < outHeight; oy++) {
      const index = c * height + oy * step;
      const source =
        compression === 0
          ? buffer.subarray(rowStart[index], rowStart[index] + rowBytes)
          : unpackBits(buffer, rowStart[index], rowStart[index + 1], row);
      for (let ox = 0; ox < outWidth; ox++) {
        // 16-bit samples are big-endian: the first byte is the top 8 bits.
        const value = source[ox * step * bytesPerSample];
        out[(oy * outWidth + ox) * samples + c] = value;
        if (c < colourChannels) {
          if (first === -1) first = value;
          else if (value !== first) uniform = false;
        }
      }
    }
  }
  if (uniform) return null;

  if (psd.mode === PSD_CMYK) {
    // Photoshop stores ink inverted (255 is no ink); TIFF's CMYK is not.
    for (let i = 0; i < out.length; i += samples) {
      for (let c = 0; c < 4; c++) out[i + c] = 255 - out[i + c];
    }
  }

  const photometric = psd.mode === PSD_RGB ? 2 : psd.mode === PSD_CMYK ? 5 : 1;
  return uncompressedTiff(out, outWidth, outHeight, samples, photometric, alpha, psd.icc);
}

/** PackBits, as PSD uses it for each row; never writes past the row. */
function unpackBits(src: Buffer, start: number, end: number, row: Buffer): Buffer {
  let i = start;
  let o = 0;
  row.fill(0);
  while (i < end && o < row.length) {
    const n = src.readInt8(i++);
    if (n >= 0) {
      const length = n + 1;
      src.copy(row, o, i, Math.min(i + length, end));
      i += length;
      o += length;
    } else if (n !== -128) {
      const length = 1 - n;
      row.fill(src[i++], o, Math.min(o + length, row.length));
      o += length;
    }
  }
  return row;
}

/** A baseline little-endian TIFF: one strip, no compression, optional ICC profile. */
export function uncompressedTiff(
  pixels: Buffer,
  width: number,
  height: number,
  samples: number,
  photometric: number,
  alpha: boolean,
  icc: Buffer | null
): Buffer {
  const SHORT = 3;
  const LONG = 4;
  const UNDEFINED = 7;
  type Entry = { tag: number; type: number; count: number; value?: number; data?: Buffer };
  const shorts = (values: number[]) => {
    const data = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => data.writeUInt16LE(v, i * 2));
    return data;
  };
  const bits = new Array(samples).fill(8);
  const entries: Entry[] = [
    { tag: 256, type: LONG, count: 1, value: width },
    { tag: 257, type: LONG, count: 1, value: height },
    { tag: 258, type: SHORT, count: samples, data: shorts(bits) },
    { tag: 259, type: SHORT, count: 1, value: 1 },
    { tag: 262, type: SHORT, count: 1, value: photometric },
    { tag: 273, type: LONG, count: 1, value: 0 }, // strip offset, filled in below
    { tag: 277, type: SHORT, count: 1, value: samples },
    { tag: 278, type: LONG, count: 1, value: height },
    { tag: 279, type: LONG, count: 1, value: pixels.length },
    { tag: 284, type: SHORT, count: 1, value: 1 },
  ];
  if (photometric === 5) entries.push({ tag: 332, type: SHORT, count: 1, value: 1 });
  if (alpha) entries.push({ tag: 338, type: SHORT, count: 1, value: 2 });
  if (icc?.length) entries.push({ tag: 34675, type: UNDEFINED, count: icc.length, data: icc });

  const ifdSize = 2 + entries.length * 12 + 4;
  let external = 8 + ifdSize;
  const blocks: Buffer[] = [];
  const offsets = new Map<Entry, number>();
  for (const entry of entries) {
    if (!entry.data || entry.data.length <= 4) continue;
    offsets.set(entry, external);
    blocks.push(entry.data);
    external += entry.data.length;
    if (external % 2) {
      blocks.push(Buffer.alloc(1));
      external++;
    }
  }
  const stripOffset = external;

  const head = Buffer.alloc(8 + ifdSize);
  head.write('II', 0, 'latin1');
  head.writeUInt16LE(42, 2);
  head.writeUInt32LE(8, 4);
  head.writeUInt16LE(entries.length, 8);
  entries.forEach((entry, i) => {
    const at = 10 + i * 12;
    head.writeUInt16LE(entry.tag, at);
    head.writeUInt16LE(entry.type, at + 2);
    head.writeUInt32LE(entry.count, at + 4);
    if (entry.tag === 273) head.writeUInt32LE(stripOffset, at + 8);
    else if (offsets.has(entry)) head.writeUInt32LE(offsets.get(entry)!, at + 8);
    else if (entry.data) entry.data.copy(head, at + 8);
    else if (entry.type === SHORT) head.writeUInt16LE(entry.value!, at + 8);
    else head.writeUInt32LE(entry.value!, at + 8);
  });
  return Buffer.concat([head, ...blocks, pixels]);
}

// ---- Spreadsheets ---------------------------------------------------------

export interface SheetCell {
  text: string;
  bold?: boolean;
  number?: boolean;
  fill?: string;
  color?: string;
}

export interface SheetPreview {
  name: string;
  /** Column widths in Excel's character units. */
  widths: number[];
  rows: SheetCell[][];
}

const SHEET = {
  width: 640,
  height: 480,
  header: 32,
  gutter: 48,
  row: 36,
  tabBar: 40,
  font: 17,
  /** Excel draws a character unit as about 7 px; this preview is zoomed in. */
  charPx: 9.5,
  maxColumnPx: 360,
  ink: '#1f2937',
  muted: '#6b7280',
  line: '#e5e7eb',
  chrome: '#f3f4f6',
  green: '#107c41',
};

const VISIBLE_ROWS = Math.floor((SHEET.height - SHEET.header - SHEET.tabBar) / SHEET.row) + 1;
const MAX_COLUMNS = 12;

export async function xlsxThumb(buffer: Buffer): Promise<string> {
  // exceljs unpacks the whole workbook; a zip bomb would take the process with it.
  const unpacked = zipUnpackedSize(buffer);
  if (unpacked === null || unpacked > XLSX_MAX_UNPACKED_BYTES) {
    throw new Error('The workbook is too large to preview');
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const sheet =
    workbook.worksheets.find(ws => ws.state !== 'hidden' && ws.state !== 'veryHidden') ??
    workbook.worksheets[0];
  if (!sheet) throw new Error('The workbook has no sheets');

  const columnCount = Math.min(Math.max(sheet.columnCount, 1), MAX_COLUMNS);
  const defaultWidth = sheet.properties.defaultColWidth || 9;
  const widths: number[] = [];
  for (let c = 1; c <= columnCount; c++) {
    const column = sheet.getColumn(c);
    widths.push(column.hidden ? 0 : column.width || defaultWidth);
  }

  const rows: SheetCell[][] = [];
  for (let r = 1; r <= VISIBLE_ROWS; r++) {
    const row = sheet.getRow(r);
    const cells: SheetCell[] = [];
    for (let c = 1; c <= columnCount; c++) {
      const cell = row.getCell(c);
      const value = cell.value;
      const result = value && typeof value === 'object' && 'result' in value ? value.result : value;
      const fill = cell.fill as any;
      cells.push({
        text: cellText(value),
        bold: !!cell.font?.bold,
        number: typeof result === 'number',
        fill: fill?.type === 'pattern' && fill.pattern === 'solid' ? argbColour(fill.fgColor?.argb) : undefined,
        color: argbColour(cell.font?.color?.argb),
      });
    }
    rows.push(cells);
  }
  return sheetSvg({ name: sheet.name, widths, rows });
}

/**
 * What a zip says its entries unpack to, from its central directory; null
 * when there is none or it is ZIP64 (sizes beyond 4 GB), which no preview
 * needs.
 */
export function zipUnpackedSize(buffer: Buffer): number | null {
  const EOCD = 0x06054b50;
  const ENTRY = 0x02014b50;
  // The end record sits in the last 22 bytes plus at most a 64 KB comment.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || pos === 0xffffffff) return null;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== ENTRY) return null;
    const size = buffer.readUInt32LE(pos + 24);
    if (size === 0xffffffff) return null;
    total += size;
    pos += 46 + buffer.readUInt16LE(pos + 28) + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
  }
  return total;
}

export function csvThumb(source: Buffer | string, name = 'CSV'): string {
  // Only the first rows are drawn; a file without line breaks is not read to its end.
  const text = typeof source === 'string' ? source.slice(0, CSV_MAX_BYTES) : source.subarray(0, CSV_MAX_BYTES).toString('utf8');
  const rows = parseCsv(text, VISIBLE_ROWS);
  const columnCount = Math.min(Math.max(1, ...rows.map(r => r.length)), MAX_COLUMNS);
  const widths: number[] = [];
  for (let c = 0; c < columnCount; c++) {
    const longest = Math.max(0, ...rows.map(r => (r[c] ?? '').length));
    widths.push(Math.min(Math.max(longest + 1, 6), 40));
  }
  return sheetSvg({
    name,
    widths,
    rows: rows.map(r =>
      Array.from({ length: columnCount }, (_, c) => {
        const value = (r[c] ?? '').trim();
        return { text: value, number: value !== '' && /^-?[\d.,]+$/.test(value) };
      })
    ),
  });
}

/** RFC 4180-ish, delimiter guessed from the first line (; , or tab). */
export function parseCsv(text: string, maxRows: number): string[][] {
  const source = text.replace(/^﻿/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [';', '\t', ','].reduce(
    (best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best),
    ','
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length && rows.length < maxRows; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if ((field || row.length) && rows.length < maxRows) rows.push([...row, field]);
  return rows;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  if (typeof value !== 'object') return String(value);
  const v = value as any;
  if (Array.isArray(v.richText)) return v.richText.map((part: any) => part.text).join('');
  if ('result' in v) return cellText(v.result);
  if ('text' in v) return cellText(v.text);
  if ('error' in v) return String(v.error);
  return '';
}

function argbColour(argb: string | undefined): string | undefined {
  return typeof argb === 'string' && /^[0-9a-f]{8}$/i.test(argb) ? `#${argb.slice(2)}` : undefined;
}

function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/** Text for XML: escaped, without the control characters XML forbids, and short. */
function xmlText(value: string, max = 120): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, max)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function sheetSvg(preview: SheetPreview): string {
  const S = SHEET;
  const font = `font-family="Calibri, Carlito, 'Segoe UI', Arial, sans-serif"`;
  const columns: { x: number; width: number }[] = [];
  let x = S.gutter;
  for (const width of preview.widths) {
    const px = width ? Math.min(Math.round(width * S.charPx + 5), S.maxColumnPx) : 0;
    columns.push({ x, width: px });
    x += px;
    if (x >= S.width) break;
  }
  const gridBottom = S.height - S.tabBar;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S.width}" height="${S.height}" viewBox="0 0 ${S.width} ${S.height}" ${font}>`,
    `<rect width="${S.width}" height="${S.height}" fill="#ffffff"/>`
  );

  preview.rows.forEach((cells, r) => {
    const y = S.header + r * S.row;
    if (y >= gridBottom) return;
    columns.forEach((col, c) => {
      const cell = cells[c];
      if (!cell || !col.width) return;
      if (cell.fill) {
        parts.push(`<rect x="${col.x}" y="${y}" width="${col.width}" height="${S.row}" fill="${cell.fill}"/>`);
      }
      if (!cell.text) return;
      // Text runs on over empty cells to its right, as in Excel.
      let width = col.width;
      if (!cell.number) {
        for (let n = c + 1; n < columns.length && !cells[n]?.text && !cells[n]?.fill; n++) {
          width += columns[n].width;
        }
      }
      const anchor = cell.number ? `x="${width - 8}" text-anchor="end"` : 'x="8"';
      parts.push(
        `<svg x="${col.x}" y="${y}" width="${width}" height="${S.row}">` +
          `<text ${anchor} y="${S.row / 2 + S.font * 0.35}" font-size="${S.font}"` +
          `${cell.bold ? ' font-weight="700"' : ''} fill="${cell.color ?? S.ink}">${xmlText(cell.text)}</text></svg>`
      );
    });
  });

  // Grid, column letters and row numbers.
  parts.push(`<rect width="${S.width}" height="${S.header}" fill="${S.chrome}"/>`);
  parts.push(`<rect y="${S.header}" width="${S.gutter}" height="${gridBottom - S.header}" fill="${S.chrome}"/>`);
  columns.forEach((col, c) => {
    if (!col.width) return;
    parts.push(
      `<line x1="${col.x + col.width}" y1="0" x2="${col.x + col.width}" y2="${gridBottom}" stroke="${S.line}" stroke-width="1"/>`,
      `<text x="${col.x + col.width / 2}" y="${S.header / 2 + 5}" text-anchor="middle" font-size="14" fill="${S.muted}">${columnName(c)}</text>`
    );
  });
  for (let r = 0; S.header + r * S.row < gridBottom; r++) {
    const y = S.header + (r + 1) * S.row;
    parts.push(
      `<line x1="0" y1="${y}" x2="${S.width}" y2="${y}" stroke="${S.line}" stroke-width="1"/>`,
      `<text x="${S.gutter / 2}" y="${y - S.row / 2 + 5}" text-anchor="middle" font-size="14" fill="${S.muted}">${r + 1}</text>`
    );
  }
  parts.push(
    `<line x1="0" y1="${S.header}" x2="${S.width}" y2="${S.header}" stroke="#d1d5db" stroke-width="1"/>`,
    `<line x1="${S.gutter}" y1="0" x2="${S.gutter}" y2="${gridBottom}" stroke="#d1d5db" stroke-width="1"/>`
  );

  // The sheet tab, Excel's green.
  const name = xmlText(preview.name || 'Sheet1', 28);
  const tabWidth = Math.min(Math.max(name.length * 10 + 36, 96), 320);
  parts.push(
    `<rect y="${gridBottom}" width="${S.width}" height="${S.tabBar}" fill="${S.chrome}"/>`,
    `<line x1="0" y1="${gridBottom}" x2="${S.width}" y2="${gridBottom}" stroke="#d1d5db" stroke-width="1"/>`,
    `<rect x="${S.gutter}" y="${gridBottom}" width="${tabWidth}" height="${S.tabBar - 4}" fill="#ffffff"/>`,
    `<rect x="${S.gutter + 10}" y="${S.height - 7}" width="${tabWidth - 20}" height="3" rx="1.5" fill="${S.green}"/>`,
    `<text x="${S.gutter + tabWidth / 2}" y="${gridBottom + S.tabBar / 2 + 4}" text-anchor="middle" font-size="15" font-weight="700" fill="${S.green}">${name}</text>`,
    '</svg>'
  );
  return parts.join('');
}
