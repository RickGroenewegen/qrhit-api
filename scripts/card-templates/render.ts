/**
 * A local proof of a stored-template folder: renders it with real cards the
 * way production does (QR pictures generated as qr.ts makes them, in the
 * order's QR colour, the page under its CSP) and prints it like the PDF
 * Lambda, with the local Google Chrome. Nothing touches the API or a database.
 *
 *   npx tsx scripts/card-templates/render.ts --dir <templates> <name>
 *        [--tracks <tracks.json>] [--design '{"qrColor":"#002b53"}'] [--printer schneiders]
 *        [--out <dir>] [--dpi 200]
 *
 * tracks.json: [{ "artist": "…", "name": "…", "year": 1983, "extraArtistAttribute"?, "extraNameAttribute"? }]
 * (default: the sample cards a proof uses). Writes <out>/<name>.pdf, a PNG per
 * page and <name>-sheet.png with every card's front and back side by side.
 */
import 'dotenv/config';
import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import ejs from 'ejs';
import QRCode from 'qrcode';
import puppeteer from 'puppeteer-core';
import {
  cardTemplateCsp,
  FIT_SCRIPT,
  newNonce,
  printerCardSizeMm,
  renderCards,
  sampleDesign,
  SAMPLE_TRACKS,
} from '../../src/cardTemplates';
import { getFontWeight, getGoogleFontName, getGoogleFontWeights, getYearFontSize } from '../../src/fonts';
import { CHROME, howtoTranslations, loadTemplate, Page, printPdf, rasterise, startServer, VIEWS } from './harness';

const run = promisify(execFile);
const argv = process.argv.slice(2);
function option(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
}
const templatesDir = path.resolve(option('dir') || '.');
const tracksFile = option('tracks');
const designJson = option('design');
const printerType = option('printer', 'schneiders')!;
const dpi = parseInt(option('dpi', '200')!);
const name = argv[0];
const outDir = path.resolve(option('out', path.join(os.tmpdir(), 'card-template-render', name || ''))!);
if (!name) {
  console.error('usage: render.ts --dir <templates> <name> [--tracks t.json] [--design json] [--printer x] [--out D] [--dpi 200]');
  process.exit(2);
}

async function main() {
  const { template, files } = await loadTemplate(templatesDir, name);
  const tracks: Record<string, any>[] = (tracksFile ? JSON.parse(readFileSync(tracksFile, 'utf8')) : SAMPLE_TRACKS).map(
    (t: Record<string, any>, i: number) => ({
      extraArtistAttribute: null,
      extraNameAttribute: null,
      ...t,
      // As getTracks gives them: a database id (the QR link) and a Spotify id (the picture's name).
      id: 1_000_000 + i,
      trackId: t.trackId || `render${String(i + 1).padStart(3, '0')}`,
    })
  );
  const php = { ...sampleDesign(), printerType, paymentHasPlaylistId: 100_000, ...(designJson ? JSON.parse(designJson) : {}) };

  const staticFiles = new Map<string, Buffer>();
  const pages = new Map<string, Page>();
  const { server, origin } = await startServer(staticFiles, pages);
  process.env['API_URI'] = origin;
  for (const [file, bytes] of files) staticFiles.set(`/public/card-templates/${name}/${file}`, bytes);
  for (const t of tracks) {
    // qr.ts generateQR: 600 px, quiet zone 4, transparent light, level H, the /qr2 link.
    staticFiles.set(
      `/public/qr/render/${t.trackId}.png`,
      await QRCode.toBuffer(`${origin}/qr2/${t.id}/${php.paymentHasPlaylistId}`, {
        width: 600,
        color: { dark: php.qrColor || '#000000', light: '#0000' },
        errorCorrectionLevel: 'H',
      })
    );
  }

  const stored = renderCards(
    template,
    {
      php,
      designs: [php],
      cardDesignIndexes: tracks.map(() => 0),
      tracks,
      subdir: 'render',
      eco: !!php.eco,
      startIndex: 0,
      batchNumber: String(php.paymentHasPlaylistId),
      apiUri: origin,
    },
    { cacheable: false }
  );
  const nonce = newNonce();
  const html = await ejs.renderFile(
    path.join(VIEWS, 'stored_card_page.ejs'),
    {
      php,
      designs: [php],
      startIndex: 0,
      howtoTranslations: howtoTranslations(),
      getYearFontSize,
      getGoogleFontWeights,
      getGoogleFontName,
      getFontWeight,
      stored,
      fitNonce: nonce,
      fitScript: FIT_SCRIPT,
    },
    { async: false }
  );
  pages.set('/page', { html, csp: cardTemplateCsp(origin, nonce) });

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const sizeMm = template.cardSizeMm ?? printerCardSizeMm(printerType);
  const pdf = path.join(outDir, `${name}.pdf`);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--font-render-hinting=none'] });
  try {
    const problems = await printPdf(browser, `${origin}/page`, sizeMm, pdf);
    for (const p of problems) console.log(`  ${p}`);
  } finally {
    await browser.close();
    server.close();
  }
  const pngs = await rasterise(pdf, path.join(outDir, name), dpi);
  // Front and back of each card side by side, one card per row.
  const sheet = path.join(outDir, `${name}-sheet.png`);
  await run('magick', ['montage', ...pngs, '-tile', '2x', '-geometry', '+8+8', '-background', '#888888', sheet]);
  console.log(JSON.stringify({ pdf, pages: pngs.length, sheet, cardSizeMm: sizeMm }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
