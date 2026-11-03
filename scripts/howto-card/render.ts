/**
 * Proof of our standard how-to card (views/partials/howto_card.ejs): renders
 * it through the 60 mm printer layout and the 56 mm Schneiders layout, in
 * the given languages and on a solid and a picture background, prints each
 * like the PDF Lambda with the local Chrome, and checks
 *
 *   - that the front (title, QR code, caption) and the six steps on the back
 *     stay inside the safe zone, 3 mm inside the cut;
 *   - that the QR code is at least 16 mm and reads back (ZXing, as finalCheck
 *     reads cards) as exactly https://www.qrsong.io/how-to.
 *
 *   npx tsx scripts/howto-card/render.ts [--locales nl,en,de] [--font 'Montserrat, Arial, sans-serif'] [--out <dir>] [--dpi 300]
 *
 * Default: every site language. Writes <out>/<locale>-<size>mm-<background>-front.png
 * and -back.png, and sheet.png with the safe zone drawn in cyan. Exit code 1
 * on a problem. Nothing touches the API or a database.
 */
import 'dotenv/config';
import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import ejs from 'ejs';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { getFontWeight, getGoogleFontName, getGoogleFontWeights, getYearFontSize } from '../../src/fonts';
import { HOWTO_APP_URL, howtoQrSvg } from '../../src/howtoCard';
import { getQrTotalModules } from '../../src/qr';
import { readQrCodes } from '../../src/qrRead';
import { BASE_DESIGN, CHROME, fixtureImage, howtoTranslations, Page, printPdf, rasterise, REPO, startServer, VIEWS } from '../card-templates/harness';

const run = promisify(execFile);
const argv = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}
const siteLocales = JSON.parse(readFileSync(path.join(REPO, 'src/data/shared/locales.json'), 'utf8'))
  .locales.filter((l: any) => l.site)
  .map((l: any) => l.code as string);
const locales = option('locales', siteLocales.join(',')).split(',');
const font = option('font', '');
const outDir = path.resolve(option('out', path.join(os.tmpdir(), 'howto-card-render')));
const dpi = parseInt(option('dpi', '300'));

const SAFE_MM = 3;
const MIN_QR_MM = 16;
const LAYOUTS = [
  { template: 'schneiders', sizeMm: 56 },
  { template: 'printer', sizeMm: 60 },
];
const BACKGROUNDS: { name: string; design: Record<string, any> }[] = [
  {
    // White text on a dark gradient: the plate must carry the code.
    name: 'solid',
    design: {
      backgroundBackType: 'solid',
      backgroundBackColor: '#203040',
      useGradient: true,
      gradientBackgroundColor: '#405060',
      gradientDegrees: 90,
      gradientPosition: 60,
      fontColor: '#ffffff',
    },
  },
  { name: 'picture', design: { backgroundBack: 'fx_back.png', backOpacity: 60, fontColor: '#1a237e' } },
];

/** Where the content of the how-to card's two sides sits, in mm from the cut. */
async function measure(browser: any, url: string, sizeMm: number) {
  const page = await browser.newPage();
  const px = Math.ceil(sizeMm * (96 / 25.4));
  await page.setViewport({ width: px, height: px, deviceScaleFactor: 1 });
  // tsx names the arrow functions below with a helper the page does not have.
  await page.evaluateOnNewDocument('window.__name = (fn) => fn;');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.evaluate(() => (document as any).fonts.ready);
  const sides = await page.evaluate(() => {
    const mm = (v: number) => (v * 25.4) / 96;
    return [...document.querySelectorAll('.card-back')].slice(0, 2).map((card) => {
      const box = card.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(card.lastElementChild as Element);
      const content = range.getBoundingClientRect();
      const qr = card.querySelector('.howto-qr')?.getBoundingClientRect();
      return {
        top: mm(content.top - box.top),
        bottom: mm(box.bottom - content.bottom),
        left: mm(content.left - box.left),
        right: mm(box.right - content.right),
        qrMm: qr ? mm(Math.min(qr.width, qr.height)) : null,
        steps: card.querySelectorAll('.howto-step').length,
      };
    });
  });
  await page.close();
  return sides;
}

async function main() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const staticFiles = new Map<string, Buffer>([
    ['/public/background/fx_back.png', await fixtureImage(800, 800, '#ffd166', '#06d6a0', 'BACK')],
  ]);
  const pages = new Map<string, Page>();
  const { server, origin } = await startServer(staticFiles, pages);
  process.env['API_URI'] = origin;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--font-render-hinting=none'] });
  const problems: string[] = [];
  const sheetRows: string[] = [];

  try {
    for (const locale of locales) {
      for (const { template, sizeMm } of LAYOUTS) {
        for (const background of BACKGROUNDS) {
          const label = `${locale}-${sizeMm}mm-${background.name}`;
          const php = {
            ...BASE_DESIGN,
            ...background.design,
            ...(font ? { selectedFont: font } : {}),
            addHowToCard: true,
            addHowToCardLocale: locale,
            printerType: sizeMm === 56 ? 'schneiders' : 'tromp',
          };
          const html = await ejs.renderFile(
            path.join(VIEWS, `pdf_${template}.ejs`),
            {
              subdir: 'proof',
              payment: {},
              playlist: { name: 'Proof' },
              php,
              tracks: [],
              designs: [php],
              cardDesigns: [],
              cardDesignIndexes: [],
              user: {},
              eco: false,
              emptyPages: 0,
              batchNumber: '12345',
              startIndex: 0,
              howtoTranslations: howtoTranslations(locale),
              howtoQrSvg: howtoQrSvg(),
              getYearFontSize,
              getGoogleFontWeights,
              getGoogleFontName,
              getFontWeight,
              getQrTotalModules,
            },
            { async: false }
          );
          pages.set(`/page/${label}`, { html });
          const url = `${origin}/page/${label}`;

          const [front, back] = await measure(browser, url, sizeMm);
          for (const [side, m] of [['front', front], ['back', back]] as const) {
            const tightest = Math.min(m.top, m.bottom, m.left, m.right);
            if (tightest < SAFE_MM) problems.push(`${label} ${side}: content ${tightest.toFixed(2)} mm from the cut (safe zone ${SAFE_MM} mm)`);
          }
          if (!front.qrMm || front.qrMm < MIN_QR_MM) problems.push(`${label}: QR code ${front.qrMm} mm`);
          if (back.steps !== 6) problems.push(`${label}: ${back.steps} steps on the back`);

          const pdf = path.join(outDir, `${label}.pdf`);
          for (const p of await printPdf(browser, url, sizeMm, pdf)) problems.push(`${label}: ${p}`);
          const [frontPng, backPng] = await rasterise(pdf, path.join(outDir, label), dpi);
          await fs.rename(frontPng, path.join(outDir, `${label}-front.png`));
          await fs.rename(backPng, path.join(outDir, `${label}-back.png`));
          await fs.rm(pdf);
          const codes = await readQrCodes(await fs.readFile(path.join(outDir, `${label}-front.png`)));
          if (codes.length !== 1 || codes[0] !== HOWTO_APP_URL) problems.push(`${label}: QR reads ${JSON.stringify(codes)}`);

          const f = (v: number) => v.toFixed(1);
          console.log(
            `${label.padEnd(22)} front ${f(front.top)}/${f(front.bottom)} mm top/bottom, ${f(Math.min(front.left, front.right))} sides, QR ${f(front.qrMm || 0)} mm reads ${codes[0] === HOWTO_APP_URL ? 'ok' : 'NO'}` +
              ` | back ${f(back.top)}/${f(back.bottom)} top/bottom, ${f(Math.min(back.left, back.right))} sides`
          );

          // The sheet: both sides with the safe zone, small.
          for (const side of ['front', 'back']) {
            const png = path.join(outDir, `${label}-${side}.png`);
            const { width = 0, height = 0 } = await sharp(png).metadata();
            const inset = (SAFE_MM / sizeMm) * width;
            const guide = Buffer.from(
              `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${inset}" y="${inset}" width="${width - 2 * inset}" height="${height - 2 * inset}" fill="none" stroke="#00bcd4" stroke-width="${width / 300}"/></svg>`
            );
            const guided = path.join(outDir, `.${label}-${side}-guide.png`);
            // sharp resizes before it composites, hence two passes.
            const drawn = await sharp(png).composite([{ input: guide }]).png().toBuffer();
            await sharp(drawn).resize(Math.round((sizeMm / 60) * 360)).png().toFile(guided);
            sheetRows.push(guided);
          }
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  // Per language two rows, 56 mm then 60 mm: solid front and back, picture front and back.
  const sheet = path.join(outDir, 'sheet.png');
  await run('magick', ['montage', ...sheetRows, '-tile', '4x', '-geometry', '+6+6', '-background', '#888888', sheet]);
  for (const guided of sheetRows) await fs.rm(guided);
  console.log(`\n${outDir}\n${sheet}`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log(`  ${p}`);
    process.exit(1);
  }
  console.log('\nall inside the safe zone, every QR code reads');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
