import QRCode from 'qrcode';

export interface QrSvgOptions {
  /** Colour of the dark modules (default: the brochure's teal). */
  color?: string;
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
}

/**
 * A link as an inline SVG QR code, with a quiet zone of four modules on a
 * white square: crisp at any print size, no file or request needed. All dark
 * modules are one path, so a viewer shows no seams between them. Used by the
 * default playlists brochure, the gift voucher and the how-to card.
 */
export function qrSvg(text: string, { color = '#18565E', errorCorrectionLevel = 'M' }: QrSvgOptions = {}): string {
  const qr = QRCode.create(text, { errorCorrectionLevel });
  const size = qr.modules.size;
  const quiet = 4;
  const total = size + quiet * 2;
  let path = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!qr.modules.get(y, x)) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && qr.modules.get(y, x)) x++;
      path += `M${start + quiet} ${y + quiet}h${x - start}v1h-${x - start}z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" aria-hidden="true">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/><path fill="${color}" d="${path}"/></svg>`
  );
}
