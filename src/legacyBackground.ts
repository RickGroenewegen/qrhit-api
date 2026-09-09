import fs from 'fs/promises';
import path from 'path';

/**
 * Cutover from the old blue default card artwork to the cream brand artwork.
 *
 * Order lines never stored a background when the customer kept the default,
 * so the print and PDF templates fall back to a shared asset at render time.
 * That asset is now the brand artwork (assets/images/background_brand.png).
 * Orders placed before the switch were previewed, approved and possibly
 * printed with the blue artwork, so they must keep it on every later
 * regeneration or reprint. This module pins those rows to an explicit copy of
 * the blue artwork in the uploads folder, exactly like a custom background.
 */

/** File in PUBLIC_DIR/background that holds the pre-2026 blue default artwork. */
export const LEGACY_DEFAULT_BACKGROUND_FILE = 'legacy_default_blue.png';

/** The blue artwork, kept in the assets folder under its historical name. */
export const LEGACY_DEFAULT_BACKGROUND_ASSET = 'images/background_new.png';

/** app_settings key that records the one-time backfill. */
export const LEGACY_BACKGROUND_BACKFILL_KEY = 'legacy_default_background_backfill';

/**
 * Make sure the legacy artwork exists in the uploads folder. The uploads
 * folder is not in git, so this runs at every start and is a no-op once the
 * file is there. Returns true when the file was (re)created.
 */
export async function ensureLegacyDefaultBackgroundFile(
  assetsDir: string,
  publicDir: string
): Promise<boolean> {
  const target = path.join(publicDir, 'background', LEGACY_DEFAULT_BACKGROUND_FILE);
  try {
    await fs.access(target);
    return false;
  } catch {
    // Missing: fall through and copy it.
  }
  const source = path.join(assetsDir, LEGACY_DEFAULT_BACKGROUND_ASSET);
  try {
    await fs.access(source);
  } catch {
    // No artwork to copy (a stripped-down deploy or a test APP_ROOT). Startup
    // must not depend on it; legacy rows then fall back to the template default.
    console.warn(`Legacy default background asset not found, skipping: ${source}`);
    return false;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
  return true;
}

export interface LegacyBackfillPrisma {
  appSetting: {
    findUnique(args: { where: { key: string } }): Promise<unknown | null>;
    upsert(args: {
      where: { key: string };
      create: { key: string; value: string };
      update: { value: string };
    }): Promise<unknown>;
  };
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

/**
 * One-time backfill: every order line without a stored background (and not
 * using a solid colour) predates the brand artwork and gets the legacy file.
 * Guarded by an app_settings row so it runs once per database; the UPDATE is
 * idempotent anyway, so a race between cluster workers is harmless.
 *
 * Returns the number of rows updated, or null when the backfill had already
 * run.
 */
export async function backfillLegacyDefaultBackground(
  prisma: LegacyBackfillPrisma
): Promise<number | null> {
  const done = await prisma.appSetting.findUnique({
    where: { key: LEGACY_BACKGROUND_BACKFILL_KEY },
  });
  if (done) {
    return null;
  }

  const affected = await prisma.$executeRaw`
    UPDATE payment_has_playlist
    SET    background = ${LEGACY_DEFAULT_BACKGROUND_FILE}
    WHERE  (background IS NULL OR background = '')
    AND    (backgroundFrontType IS NULL OR backgroundFrontType <> 'solid')`;

  const value = `${new Date().toISOString()} rows=${affected}`;
  await prisma.appSetting.upsert({
    where: { key: LEGACY_BACKGROUND_BACKFILL_KEY },
    create: { key: LEGACY_BACKGROUND_BACKFILL_KEY, value },
    update: { value },
  });
  return affected;
}
