import { promises as fs } from 'fs';
import sharp from 'sharp';
import { prepareZXingModule, readBarcodes, type ReaderOptions } from 'zxing-wasm/reader';

/**
 * The decoder is ZXing-C++ (zxing-wasm), the closest to the app's Google ML
 * Kit that runs here; jsQR missed clean codes at some render sizes (see
 * CLAUDE.md, "The QR code on the print"). The wasm binary is read from
 * node_modules: left alone, the package fetches it from a CDN.
 */
let zxing: Promise<unknown> | null = null;

function loadZxing(): Promise<unknown> {
  zxing ??= fs
    .readFile(require.resolve('zxing-wasm/reader/zxing_reader.wasm'))
    .then((wasm) =>
      prepareZXingModule({
        overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer },
        fireImmediately: true,
      })
    )
    .catch((e) => {
      zxing = null;
      throw e;
    });
  return zxing;
}

// Light on dark is tried too: the QRSong! app scans inverted codes. A sheet
// page holds twelve.
const OPTIONS: ReaderOptions = { formats: ['QRCode'], tryHarder: true, tryInvert: true, maxNumberOfSymbols: 12 };

/**
 * The texts of the QR codes in a picture, empty when none reads (or the
 * picture is no picture). Transparency is flattened onto white, as paper
 * does. A decoder that cannot load throws: that is no verdict on the code.
 */
export async function readQrCodes(picture: Buffer): Promise<string[]> {
  let pixels: { data: Buffer; info: sharp.OutputInfo };
  try {
    pixels = await sharp(picture)
      .flatten({ background: '#ffffff' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    return [];
  }
  await loadZxing();
  const { data, info } = pixels;
  const results = await readBarcodes(
    { data: new Uint8ClampedArray(data), width: info.width, height: info.height, colorSpace: 'srgb' },
    OPTIONS
  );
  return results.filter((result) => result.isValid).map((result) => result.text);
}

/** The link a card of this order line carries (generator.ts generateQRCodes): /qr2/<track>/<php>. */
export function isCardLink(text: string, paymentHasPlaylistId: number): boolean {
  return new RegExp(`/qr2/\\d+/${paymentHasPlaylistId}$`).test(text.trim());
}
