import fs from 'fs/promises';
import path from 'path';
import PrismaInstance from './prisma';
import { csvThumb, isPdfData, pdfThumb, psdThumb, webpThumb, xlsxThumb } from './companyFilePreviews';

/**
 * The company asset store: any file an admin, a client (brand kit from the
 * /business form) or boxd (box designs) puts there. Files live under
 * PRIVATE_DIR/company-files/<companyId>/ and are only served by the admin
 * routes in routes/businessRoutes.ts, never from /public.
 *
 * A file belongs to the company as a whole (logos, brand kit) or, with
 * companyListId, to one of its lists (that list's designs, track list and
 * printer files). The company's Assets tab shows the first kind, a list's
 * Assets tab the second.
 */

export const FILE_CATEGORIES = ['brand', 'design', 'generated', 'other'] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export const FILE_SOURCES = ['client', 'admin', 'boxd', 'migrated'] as const;
export type FileSource = (typeof FILE_SOURCES)[number];

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  psd: 'image/vnd.adobe.photoshop',
  pdf: 'application/pdf',
  ai: 'application/postscript',
  eps: 'application/postscript',
  indd: 'application/x-indesign',
  zip: 'application/zip',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  txt: 'text/plain',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** What an admin or boxd may store. */
export const ADMIN_EXTENSIONS = Object.keys(MIME_BY_EXTENSION);

/** What a visitor may send as a brand kit: artwork and documents, no video. */
export const BRAND_KIT_EXTENSIONS = [
  'pdf', 'ai', 'eps', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff', 'psd', 'zip', 'indd',
];

type ThumbKind = 'image' | 'pdf' | 'psd' | 'xlsx' | 'csv';

/** How each file type gets its thumbnail (companyFilePreviews.ts). */
const THUMB_KINDS: Record<string, ThumbKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  svg: 'image',
  tif: 'image',
  tiff: 'image',
  pdf: 'pdf',
  ai: 'pdf',
  psd: 'psd',
  xlsx: 'xlsx',
  csv: 'csv',
};

/**
 * SES SendRawEmail (API v1, which mail.ts uses) takes 10 MB per message after
 * base64 encoding. Base64 adds a third, and the message also carries the HTML,
 * the text part and the inline logo, so the attachments themselves stay
 * under 7 MB.
 */
export const MAIL_ATTACHMENT_LIMIT_BYTES = 7 * 1000 * 1000;

export const MAX_ADMIN_FILE_BYTES = 100 * 1024 * 1024;

export function extensionOf(filename: string): string {
  const ext = path.extname(filename || '').slice(1).toLowerCase();
  return ext;
}

export function isAllowedExtension(filename: string, allowed: string[]): boolean {
  return allowed.includes(extensionOf(filename));
}

export function mimeTypeFor(filename: string, reported?: string | null): string {
  return MIME_BY_EXTENSION[extensionOf(filename)] || reported || 'application/octet-stream';
}

export function companyFilesDir(companyId: number): string {
  return path.join(`${process.env['PRIVATE_DIR']}`, 'company-files', String(companyId));
}

/** A display name without path parts or control characters. */
export function cleanOriginalName(name: string): string {
  const base = path.basename(String(name || 'file').replace(/\\/g, '/'));
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || 'file').slice(-200);
}

function storedName(originalName: string): string {
  const safe = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
  const random = Math.random().toString(36).slice(2, 8);
  return `${Date.now()}_${random}_${safe}`;
}

function thumbKind(file: { originalName: string; filename: string }): ThumbKind | null {
  return THUMB_KINDS[extensionOf(file.filename || file.originalName)] ?? null;
}

export function hasThumb(file: { originalName: string; filename: string }): boolean {
  return thumbKind(file) !== null;
}

export interface CompanyFileDto {
  id: number;
  companyId: number;
  companyListId: number | null;
  quoteRequestId: number | null;
  category: string;
  source: string;
  originalName: string;
  mimeType: string;
  size: number;
  note: string | null;
  createdAt: Date;
  hasThumb: boolean;
}

export function toFileDto(row: any): CompanyFileDto {
  return {
    id: row.id,
    companyId: row.companyId,
    companyListId: row.companyListId ?? null,
    quoteRequestId: row.quoteRequestId ?? null,
    category: row.category,
    source: row.source,
    originalName: row.originalName,
    mimeType: row.mimeType,
    size: row.size,
    note: row.note ?? null,
    createdAt: row.createdAt,
    hasThumb: hasThumb(row),
  };
}

export interface IncomingFile {
  buffer: Buffer;
  originalName: string;
  mimeType?: string | null;
}

export interface FileMeta {
  category?: string;
  source?: string;
  companyListId?: number | null;
  quoteRequestId?: number | null;
  note?: string | null;
  legacyKey?: string | null;
}

function normalizeCategory(category?: string): FileCategory {
  return (FILE_CATEGORIES as readonly string[]).includes(category || '')
    ? (category as FileCategory)
    : 'other';
}

function normalizeSource(source?: string): FileSource {
  return (FILE_SOURCES as readonly string[]).includes(source || '')
    ? (source as FileSource)
    : 'admin';
}

/** Writes the file next to the company's others and records it. */
export async function saveCompanyFile(
  companyId: number,
  file: IncomingFile,
  meta: FileMeta = {}
): Promise<any> {
  const prisma = PrismaInstance.getInstance();
  const originalName = cleanOriginalName(file.originalName);
  const filename = storedName(originalName);
  const dir = companyFilesDir(companyId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), file.buffer);
  try {
    return await prisma.companyFile.create({
      data: {
        companyId,
        companyListId: meta.companyListId ?? null,
        quoteRequestId: meta.quoteRequestId ?? null,
        category: normalizeCategory(meta.category),
        source: normalizeSource(meta.source),
        filename,
        originalName,
        mimeType: mimeTypeFor(originalName, file.mimeType),
        size: file.buffer.length,
        note: meta.note ? String(meta.note).slice(0, 2000) : null,
        legacyKey: meta.legacyKey ?? null,
      },
    });
  } catch (error) {
    await fs.unlink(path.join(dir, filename)).catch(() => undefined);
    throw error;
  }
}

export async function findCompanyFile(companyId: number, fileId: number): Promise<any | null> {
  if (!Number.isInteger(companyId) || !Number.isInteger(fileId)) return null;
  const file = await PrismaInstance.getInstance().companyFile.findUnique({
    where: { id: fileId },
  });
  return file && file.companyId === companyId ? file : null;
}

export function companyFilePath(file: { companyId: number; filename: string }): string {
  return path.join(companyFilesDir(file.companyId), file.filename);
}

export async function readCompanyFile(file: { companyId: number; filename: string }): Promise<Buffer> {
  return fs.readFile(companyFilePath(file));
}

export interface CompanyFileThumb {
  data: Buffer;
  contentType: 'image/webp' | 'image/svg+xml';
}

/** Spreadsheets become SVG (drawn by the browser, with its fonts); everything else webp. */
const THUMB_SUFFIXES = ['.thumb.webp', '.thumb.svg'];

/**
 * Two renders at a time per process, and one per file: a page of dashboard
 * tiles asks for every thumbnail at once, and a PDF page or a PSD costs
 * a few hundred ms of CPU the first time.
 */
const RENDER_SLOTS = 2;
let rendersRunning = 0;
const renderQueue: Array<() => void> = [];
const rendersInFlight = new Map<string, Promise<CompanyFileThumb>>();

async function inRenderSlot<T>(work: () => Promise<T>): Promise<T> {
  if (rendersRunning >= RENDER_SLOTS) await new Promise<void>(resolve => renderQueue.push(resolve));
  else rendersRunning++;
  try {
    return await work();
  } finally {
    // Hand the slot straight to the next one waiting, or give it back.
    const next = renderQueue.shift();
    if (next) next();
    else rendersRunning--;
  }
}

async function renderThumb(kind: ThumbKind, source: string): Promise<CompanyFileThumb> {
  if (kind === 'image') return { data: await webpThumb(source), contentType: 'image/webp' };
  const buffer = await fs.readFile(source);
  switch (kind) {
    case 'pdf':
      // An Illustrator file saved without "Create PDF Compatible File" has no PDF to render.
      if (!isPdfData(buffer)) throw new Error('No PDF inside');
      return { data: await pdfThumb(buffer), contentType: 'image/webp' };
    case 'psd':
      return { data: await psdThumb(buffer), contentType: 'image/webp' };
    case 'xlsx':
      return { data: Buffer.from(await xlsxThumb(buffer)), contentType: 'image/svg+xml' };
    case 'csv':
      return { data: Buffer.from(csvThumb(buffer.toString('utf8'))), contentType: 'image/svg+xml' };
  }
}

/** A 480 px preview, made once and kept next to the file. */
export async function companyFileThumb(file: {
  companyId: number;
  filename: string;
  originalName: string;
}): Promise<CompanyFileThumb | null> {
  const kind = thumbKind(file);
  if (!kind) return null;
  const source = companyFilePath(file);
  const contentType = kind === 'xlsx' || kind === 'csv' ? 'image/svg+xml' : 'image/webp';
  const thumbPath = `${source}${contentType === 'image/svg+xml' ? '.thumb.svg' : '.thumb.webp'}`;
  try {
    return { data: await fs.readFile(thumbPath), contentType };
  } catch {
    /* not made yet */
  }

  let pending = rendersInFlight.get(thumbPath);
  if (!pending) {
    pending = inRenderSlot(async () => {
      const thumb = await renderThumb(kind, source);
      await fs.writeFile(thumbPath, thumb.data).catch(() => undefined);
      return thumb;
    }).finally(() => rendersInFlight.delete(thumbPath));
    rendersInFlight.set(thumbPath, pending);
  }
  return pending;
}

export async function deleteCompanyFile(file: { id: number; companyId: number; filename: string }): Promise<void> {
  const source = companyFilePath(file);
  await fs.unlink(source).catch(() => undefined);
  for (const suffix of THUMB_SUFFIXES) await fs.unlink(`${source}${suffix}`).catch(() => undefined);
  await PrismaInstance.getInstance().companyFile.delete({ where: { id: file.id } });
}

/** One of the company's lists, or null when the id is not. */
export async function findCompanyList(companyId: number, listId: number): Promise<{ id: number } | null> {
  if (!Number.isInteger(companyId) || !Number.isInteger(listId)) return null;
  const list = await PrismaInstance.getInstance().companyList.findUnique({
    where: { id: listId },
    select: { id: true, companyId: true },
  });
  return list && list.companyId === companyId ? { id: list.id } : null;
}

export async function updateCompanyFile(
  file: { id: number },
  patch: { category?: string; note?: string | null; originalName?: string; companyListId?: number | null }
): Promise<any> {
  const data: any = {};
  if (patch.companyListId !== undefined) data.companyListId = patch.companyListId;
  if (patch.category !== undefined) data.category = normalizeCategory(patch.category);
  if (patch.note !== undefined) data.note = patch.note ? String(patch.note).slice(0, 2000) : null;
  if (patch.originalName !== undefined && String(patch.originalName).trim()) {
    data.originalName = cleanOriginalName(patch.originalName);
  }
  return PrismaInstance.getInstance().companyFile.update({ where: { id: file.id }, data });
}

/** RFC 6266 Content-Disposition with an ASCII fallback and the UTF-8 name. */
export function contentDisposition(name: string, inline = false): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
