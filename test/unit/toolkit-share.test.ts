import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  deleteShare,
  downloadMail,
  findShare,
  listShares,
  NOTIFY_WINDOW_MS,
  recordDownload,
  safeShareName,
  saveShare,
  ShareError,
} from '../../src/toolkitShare';

describe('toolkit share links', () => {
  let dir: string;
  const env = { PRIVATE_DIR: process.env['PRIVATE_DIR'], API_URI: process.env['API_URI'] };

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'share-'));
    process.env['PRIVATE_DIR'] = dir;
    process.env['API_URI'] = 'https://api.example.test';
  });

  afterAll(async () => {
    process.env['PRIVATE_DIR'] = env.PRIVATE_DIR;
    process.env['API_URI'] = env.API_URI;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps only zip and pdf and makes the name URL-safe', () => {
    expect(safeShareName('Revant doos & kaarten (def).zip')).toBe('Revant_doos_kaarten_def.zip');
    expect(safeShareName('../../etc/kaärten.PDF')).toBe('kaarten.pdf');
    expect(() => safeShareName('script.js')).toThrow(ShareError);
    expect(() => safeShareName('noext')).toThrow(/only zip, pdf/);
  });

  it('stores privately under a random token and finds it only by exact token and name', async () => {
    const a = await saveShare('Revant.zip', Buffer.from('zip-bytes'), { label: 'Order Revant', notify: 'zakelijk@qrsong.io' });
    expect(a.token).toMatch(/^[a-f0-9]{32}$/);
    expect(a.url).toBe(`https://api.example.test/share/${a.token}/Revant.zip`);
    expect(await fs.readFile(path.join(dir, 'share', a.token, 'Revant.zip'), 'utf8')).toBe('zip-bytes');
    expect(await findShare(a.token, 'Revant.zip')).not.toBeNull();
    expect(await findShare(a.token, 'meta.json')).toBeNull();
    expect(await findShare(a.token, 'other.zip')).toBeNull();
    expect(await findShare('../' + a.token, 'Revant.zip')).toBeNull();
    await expect(saveShare('x.zip', Buffer.from('x'), { notify: 'not-an-email' })).rejects.toThrow(/email/);
  });

  it('mails on a download, not on HEAD, and at most once per window', async () => {
    const s = await saveShare('Order.zip', Buffer.from('z'), { label: 'Order X', notify: 'zakelijk@qrsong.io' });
    const t0 = new Date('2026-10-05T08:00:00Z');
    const req = { ip: '1.2.3.4', userAgent: 'Mozilla/5.0', method: 'GET' };
    expect(await recordDownload(s, { ...req, method: 'HEAD' }, t0)).toEqual({ notify: false, count: 1 });
    expect(await recordDownload(s, req, t0)).toEqual({ notify: true, count: 2 });
    expect(await recordDownload(s, req, new Date(t0.getTime() + 60_000))).toEqual({ notify: false, count: 3 });
    expect(await recordDownload(s, req, new Date(t0.getTime() + NOTIFY_WINDOW_MS + 1))).toEqual({ notify: true, count: 4 });

    const info = process.env['INFO_EMAIL'];
    process.env['INFO_EMAIL'] = 'info@qrsong.io';
    const byDefault = await saveShare('Default.zip', Buffer.from('d'));
    expect(byDefault.notify).toBe('info@qrsong.io');
    delete process.env['INFO_EMAIL'];
    const silent = await saveShare('Quiet.zip', Buffer.from('q'));
    process.env['INFO_EMAIL'] = info;
    expect((await recordDownload(silent, req, t0)).notify).toBe(false);

    const mail = downloadMail(s, req, 2, t0);
    expect(mail.subject).toBe('Gedownload: Order X');
    expect(mail.message).toContain('IP-adres: 1.2.3.4');
    expect(mail.message).toContain('Dit is download 2 van deze link.');
  });

  it('lists shares with their download count and deletes them', async () => {
    const listed = await listShares();
    const order = listed.find((s) => s.name === 'Order.zip')!;
    expect(order.downloads).toBe(3);
    await deleteShare(order.token);
    expect((await listShares()).some((s) => s.token === order.token)).toBe(false);
    await expect(deleteShare(order.token)).rejects.toThrow(/no such share/);
    await expect(deleteShare('../../x')).rejects.toThrow(/invalid token/);
  });
});
