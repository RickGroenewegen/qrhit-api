import sharp from 'sharp';
import jsQR from 'jsqr';

/**
 * The text of the QR code in a picture, or null when none reads. Light on
 * dark is tried too: the QRSong! app scans inverted codes. Transparency is
 * flattened onto white, as paper does.
 */
export async function readQr(picture: Buffer): Promise<string | null> {
  try {
    const { data, info } = await sharp(picture)
      .flatten({ background: '#ffffff' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: 'attemptBoth' });
    return result?.data ?? null;
  } catch {
    return null;
  }
}

/** The link a card of this order line carries (generator.ts generateQRCodes): /qr2/<track>/<php>. */
export function isCardLink(text: string, paymentHasPlaylistId: number): boolean {
  return new RegExp(`/qr2/\\d+/${paymentHasPlaylistId}$`).test(text.trim());
}
