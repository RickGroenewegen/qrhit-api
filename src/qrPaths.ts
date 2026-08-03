import * as fs from 'fs/promises';

/**
 * QR PNGs are stored per payment and named after the *Spotify* track id
 * (`qr/<subdir>/<trackId>.png`). That id is global, so two decks in the same
 * order that share a song resolved to the same file: whichever
 * payment_has_playlist was generated last overwrote the other's PNGs with its
 * own qrColor and its own `/qr2/<track>/<php>` link. A customer with a red deck
 * and a black deck in one order got a red deck whose shared cards were black
 * and pointed at the other deck.
 *
 * Each payment_has_playlist therefore gets its own directory, derived from the
 * payment-wide subdir so no extra column is needed.
 */
export function qrSubDirForItem(
  baseSubDir: string | null | undefined,
  paymentHasPlaylistId: number | null | undefined
): string {
  if (!baseSubDir) return '';
  if (!paymentHasPlaylistId) return baseSubDir;
  return `${baseSubDir}_${paymentHasPlaylistId}`;
}

/**
 * Read-side counterpart. Orders generated before per-item directories existed
 * only have the flat `qr/<subdir>/` directory, and their PDFs, host cards and
 * final checks are still re-rendered on demand, so fall back to it whenever the
 * per-item directory is not on disk.
 */
export async function resolveQrSubDir(
  baseSubDir: string | null | undefined,
  paymentHasPlaylistId: number | null | undefined
): Promise<string> {
  if (!baseSubDir) return '';
  const perItem = qrSubDirForItem(baseSubDir, paymentHasPlaylistId);
  if (perItem === baseSubDir) return baseSubDir;

  try {
    await fs.access(`${process.env['PUBLIC_DIR']}/qr/${perItem}`);
    return perItem;
  } catch {
    return baseSubDir;
  }
}
