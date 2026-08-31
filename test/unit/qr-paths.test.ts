import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

/**
 * Unit tests for src/qrPaths.ts.
 *
 * These guard the fix for the collision where two decks in one order that share
 * a song overwrote each other's QR PNGs (the files are named after the Spotify
 * track id, which is global), so the deck generated last imposed its qrColor and
 * its /qr2/<track>/<php> link on the other deck's cards.
 */

import { qrSubDirForItem, resolveQrSubDir } from '../../src/qrPaths';

const BASE = '307a5066dbe33450';

describe('qrSubDirForItem', () => {
  it('gives two items in the same payment different directories', () => {
    expect(qrSubDirForItem(BASE, 9059)).not.toBe(qrSubDirForItem(BASE, 9060));
  });

  it('derives the directory from the payment subdir and the item id', () => {
    expect(qrSubDirForItem(BASE, 9059)).toBe(`${BASE}_9059`);
  });

  it('is stable across calls', () => {
    expect(qrSubDirForItem(BASE, 9059)).toBe(qrSubDirForItem(BASE, 9059));
  });

  it('falls back to the flat directory without an item id', () => {
    expect(qrSubDirForItem(BASE, undefined)).toBe(BASE);
    expect(qrSubDirForItem(BASE, null)).toBe(BASE);
    expect(qrSubDirForItem(BASE, 0)).toBe(BASE);
  });

  it('returns an empty string when the payment has no subdir', () => {
    expect(qrSubDirForItem(null, 9059)).toBe('');
    expect(qrSubDirForItem('', 9059)).toBe('');
  });

  it('produces a single path segment so it survives the /qr/pdf route', () => {
    expect(qrSubDirForItem(BASE, 9059)).not.toContain('/');
  });
});

describe('resolveQrSubDir', () => {
  let publicDir: string;
  let previousPublicDir: string | undefined;

  beforeAll(async () => {
    publicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qrpaths-'));
    previousPublicDir = process.env['PUBLIC_DIR'];
    process.env['PUBLIC_DIR'] = publicDir;
    // Only item 9059 has been regenerated into a per-item directory.
    await fs.mkdir(path.join(publicDir, 'qr', `${BASE}_9059`), {
      recursive: true,
    });
    await fs.mkdir(path.join(publicDir, 'qr', BASE), { recursive: true });
  });

  afterAll(async () => {
    if (previousPublicDir === undefined) {
      delete process.env['PUBLIC_DIR'];
    } else {
      process.env['PUBLIC_DIR'] = previousPublicDir;
    }
    await fs.rm(publicDir, { recursive: true, force: true });
  });

  it('uses the per-item directory when it exists', async () => {
    await expect(resolveQrSubDir(BASE, 9059)).resolves.toBe(`${BASE}_9059`);
  });

  it('falls back to the flat directory for orders generated before the fix', async () => {
    await expect(resolveQrSubDir(BASE, 9060)).resolves.toBe(BASE);
  });

  it('falls back when the caller has no item id', async () => {
    await expect(resolveQrSubDir(BASE, undefined)).resolves.toBe(BASE);
  });

  it('returns an empty string when the payment has no subdir', async () => {
    await expect(resolveQrSubDir(null, 9059)).resolves.toBe('');
  });
});
