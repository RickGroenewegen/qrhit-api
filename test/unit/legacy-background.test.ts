import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  backfillLegacyDefaultBackground,
  ensureLegacyDefaultBackgroundFile,
  LEGACY_BACKGROUND_BACKFILL_KEY,
  LEGACY_DEFAULT_BACKGROUND_ASSET,
  LEGACY_DEFAULT_BACKGROUND_FILE,
} from '../../src/legacyBackground';

/**
 * Unit tests for the default-artwork cutover: the legacy file is copied into
 * the uploads folder once, and pre-cutover order lines are pinned to it
 * exactly once per database.
 */

describe('ensureLegacyDefaultBackgroundFile', () => {
  let assetsDir: string;
  let publicDir: string;

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-bg-'));
    assetsDir = path.join(root, 'assets');
    publicDir = path.join(root, 'public');
    await fs.mkdir(path.join(assetsDir, 'images'), { recursive: true });
    await fs.writeFile(path.join(assetsDir, LEGACY_DEFAULT_BACKGROUND_ASSET), 'blue-art');
  });

  it('copies the blue artwork into the uploads folder when missing', async () => {
    const created = await ensureLegacyDefaultBackgroundFile(assetsDir, publicDir);

    expect(created).toBe(true);
    const copied = await fs.readFile(
      path.join(publicDir, 'background', LEGACY_DEFAULT_BACKGROUND_FILE),
      'utf8'
    );
    expect(copied).toBe('blue-art');
  });

  it('leaves an existing file alone', async () => {
    await fs.mkdir(path.join(publicDir, 'background'), { recursive: true });
    await fs.writeFile(
      path.join(publicDir, 'background', LEGACY_DEFAULT_BACKGROUND_FILE),
      'already-there'
    );

    const created = await ensureLegacyDefaultBackgroundFile(assetsDir, publicDir);

    expect(created).toBe(false);
    const kept = await fs.readFile(
      path.join(publicDir, 'background', LEGACY_DEFAULT_BACKGROUND_FILE),
      'utf8'
    );
    expect(kept).toBe('already-there');
  });
});

describe('backfillLegacyDefaultBackground', () => {
  function makePrisma(alreadyDone: boolean) {
    return {
      appSetting: {
        findUnique: vi.fn(async () => (alreadyDone ? { key: LEGACY_BACKGROUND_BACKFILL_KEY } : null)),
        upsert: vi.fn(async () => ({})),
      },
      $executeRaw: vi.fn(async () => 17),
    };
  }

  it('pins every background-less, non-solid order line to the legacy file and records the run', async () => {
    const prisma = makePrisma(false);

    const affected = await backfillLegacyDefaultBackground(prisma);

    expect(affected).toBe(17);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = prisma.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join('?').replace(/\s+/g, ' ');
    expect(sql).toContain('UPDATE payment_has_playlist');
    expect(sql).toContain("(background IS NULL OR background = '')");
    expect(sql).toContain("backgroundFrontType <> 'solid'");
    expect(values).toEqual([LEGACY_DEFAULT_BACKGROUND_FILE]);
    expect(prisma.appSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: LEGACY_BACKGROUND_BACKFILL_KEY },
        create: expect.objectContaining({ value: expect.stringContaining('rows=17') }),
      })
    );
  });

  it('does nothing once the app_settings marker exists', async () => {
    const prisma = makePrisma(true);

    const affected = await backfillLegacyDefaultBackground(prisma);

    expect(affected).toBeNull();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.appSetting.upsert).not.toHaveBeenCalled();
  });
});
