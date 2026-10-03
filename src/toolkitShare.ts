import crypto from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';

/**
 * Secret download links for files too large to mail (Rick, 2026-10-03: zip
 * it, put it on our server, put the link in the mail, and mail me when it is
 * downloaded). A file lands in PRIVATE_DIR/share/<token>/<name> with a
 * meta.json next to it; GET /share/:token/:name (public) serves it, logs the
 * download in downloads.jsonl and mails the share's `notify` address. The
 * token is 128 random bits, so the link is the only way to the file. Created,
 * listed and removed by the qrsong toolkit (admin only).
 */

export const SHARE_EXTENSIONS = ['zip', 'pdf'];
const TOKEN = /^[a-f0-9]{32}$/;
/** One mail per share in this window: download managers and resumes make several requests. */
export const NOTIFY_WINDOW_MS = 10 * 60 * 1000;

export class ShareError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface ShareMeta {
  token: string;
  name: string;
  size: number;
  createdAt: string;
  /** What it is, for the notification ("Order Revant, drukbestanden voor Schneiders"). */
  label: string | null;
  /** Who gets a mail on every download (at most one per NOTIFY_WINDOW_MS); INFO_EMAIL by default. */
  notify: string | null;
}

export interface ShareDownload {
  at: string;
  ip: string;
  userAgent: string;
  method: string;
  notified: boolean;
}

export function shareRoot(): string {
  return path.join(process.env['PRIVATE_DIR'] as string, 'share');
}

/** A file name safe for a URL and a file system: letters, digits, dot, dash, underscore. */
export function safeShareName(original: string): string {
  const base = path.basename(original || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const ext = path.extname(base).slice(1).toLowerCase();
  if (!SHARE_EXTENSIONS.includes(ext)) throw new ShareError(`only ${SHARE_EXTENSIONS.join(', ')} files`);
  const stem = base
    .slice(0, base.length - ext.length - 1)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 100);
  return `${stem || 'download'}.${ext}`;
}

export function shareUrl(token: string, name: string): string {
  return `${process.env['API_URI']}/share/${token}/${encodeURIComponent(name)}`;
}

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

export async function saveShare(
  original: string,
  buffer: Buffer,
  opts: { label?: string | null; notify?: string | null } = {}
): Promise<ShareMeta & { url: string }> {
  const name = safeShareName(original);
  // Every share notifies someone: info@ (INFO_EMAIL) unless the toolkit names another address.
  const notify = opts.notify?.trim() || process.env['INFO_EMAIL'] || null;
  if (notify && !isEmail(notify)) throw new ShareError('notify must be an email address');
  const token = crypto.randomBytes(16).toString('hex');
  const dir = path.join(shareRoot(), token);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), buffer);
  const meta: ShareMeta = {
    token,
    name,
    size: buffer.length,
    createdAt: new Date().toISOString(),
    label: opts.label?.trim().slice(0, 200) || null,
    notify,
  };
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return { ...meta, url: shareUrl(token, name) };
}

async function readMeta(token: string): Promise<ShareMeta | null> {
  if (!TOKEN.test(token)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(shareRoot(), token, 'meta.json'), 'utf8')) as ShareMeta;
  } catch {
    return null;
  }
}

async function readDownloads(token: string): Promise<ShareDownload[]> {
  try {
    const raw = await fs.readFile(path.join(shareRoot(), token, 'downloads.jsonl'), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ShareDownload);
  } catch {
    return [];
  }
}

/** The file for a download link, or null when token and name do not match a share exactly. */
export async function findShare(token: string, name: string): Promise<{ meta: ShareMeta; file: string } | null> {
  const meta = await readMeta(token);
  if (!meta || meta.name !== name) return null;
  const file = path.join(shareRoot(), token, meta.name);
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  return { meta, file };
}

export function shareStream(file: string) {
  return createReadStream(file);
}

/**
 * Logs a download and says whether to mail about it: a GET (not a HEAD) with
 * a notify address and no mail sent for this share in the last window.
 */
export async function recordDownload(
  meta: ShareMeta,
  request: { ip: string; userAgent: string; method: string },
  now = new Date()
): Promise<{ notify: boolean; count: number }> {
  const previous = await readDownloads(meta.token);
  const lastMail = previous.filter((d) => d.notified).map((d) => Date.parse(d.at)).sort().pop() ?? 0;
  const notify = !!meta.notify && request.method === 'GET' && now.getTime() - lastMail >= NOTIFY_WINDOW_MS;
  const entry: ShareDownload = {
    at: now.toISOString(),
    ip: request.ip,
    userAgent: request.userAgent.slice(0, 300),
    method: request.method,
    notified: notify,
  };
  await fs.appendFile(path.join(shareRoot(), meta.token, 'downloads.jsonl'), JSON.stringify(entry) + '\n');
  return { notify, count: previous.length + 1 };
}

export function downloadMail(meta: ShareMeta, d: { ip: string; userAgent: string }, count: number, now = new Date()) {
  const when = now.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'long', timeStyle: 'short' });
  const subject = `Gedownload: ${meta.label || meta.name}`;
  const message = [
    `${meta.name} (${(meta.size / 1048576).toFixed(1)} MB) is gedownload op ${when}.`,
    meta.label ? `Wat: ${meta.label}` : '',
    `IP-adres: ${d.ip}`,
    `Browser: ${d.userAgent || '(onbekend)'}`,
    count > 1 ? `Dit is download ${count} van deze link.` : 'Dit is de eerste download van deze link.',
    '',
    'Let op: virusscanners van mailservers (bijvoorbeeld Microsoft Safe Links) openen links soms zelf, vlak nadat de mail is aangekomen. Kijk bij twijfel naar de browser hierboven.',
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
  return { subject, message };
}

export async function listShares() {
  let tokens: string[] = [];
  try {
    tokens = (await fs.readdir(shareRoot())).filter((t) => TOKEN.test(t));
  } catch {
    return [];
  }
  const out = [];
  for (const token of tokens) {
    const meta = await readMeta(token);
    if (!meta) continue;
    const downloads = await readDownloads(token);
    out.push({
      ...meta,
      url: shareUrl(token, meta.name),
      downloads: downloads.filter((d) => d.method === 'GET').length,
      lastDownloadAt: downloads.length ? downloads[downloads.length - 1].at : null,
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteShare(token: string): Promise<void> {
  if (!TOKEN.test(token)) throw new ShareError('invalid token');
  const dir = path.join(shareRoot(), token);
  try {
    await fs.access(dir);
  } catch {
    throw new ShareError('no such share', 404);
  }
  await fs.rm(dir, { recursive: true, force: true });
}
