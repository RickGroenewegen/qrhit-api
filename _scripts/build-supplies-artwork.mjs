#!/usr/bin/env node
// Makes the print files for the packing supplies we order from Print&Bind
// (src/printers/printenbindSupplies.ts): the A4 with six bands and the round
// sticker, each as a PDF for the printer and a PNG for the order form.
//
//   node _scripts/build-supplies-artwork.mjs [--logo <white logo png>]
//
// Writes src/supplies/{band-a4,sticker-30mm}.{pdf,png}. They are committed:
// the build copies src/ along, and the API puts them in PUBLIC_DIR/supplies
// when an order needs them. Run it again after changing the sizes in
// printenbindSupplies.ts (keep the numbers below in step) or the look.
import { PDFDocument, rgb } from 'pdf-lib';
import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'supplies');

const logoArg = process.argv.indexOf('--logo');
const logoPath =
  logoArg >= 0
    ? process.argv[logoArg + 1]
    : path.join(root, '..', 'qrhit', 'src', 'assets', 'images', 'logo_white.png');

// The teal of the QRSong! logo
const TEAL = { r: 24, g: 86, b: 94 };
const MM = 72 / 25.4;
const BLEED = 3;

const BANDS = 6;
const BAND_WIDTH = 35;
const SHEET = { width: 297, height: 210 };
// Three logos per band, so one always lands on a face of the stack
const LOGOS_PER_BAND = 3;
const BAND_LOGO_WIDTH = 46;

const STICKER = 30;
const STICKER_ICON = 17;

// In the logo file the icon is the first block, up to this column
const ICON_END = 689;
const ICON_START = 18;

const teal = rgb(TEAL.r / 255, TEAL.g / 255, TEAL.b / 255);

async function logoParts() {
  const source = sharp(logoPath);
  const { width, height } = await source.metadata();
  const logo = await source.clone().resize({ width: 1600 }).png().toBuffer();
  const icon = await source
    .clone()
    .extract({ left: ICON_START, top: 0, width: ICON_END - ICON_START, height })
    .resize({ width: 800 })
    .png()
    .toBuffer();
  return {
    logo,
    logoRatio: height / width,
    icon,
    iconRatio: height / (ICON_END - ICON_START),
  };
}

/** Where each logo sits on the band sheet, in mm from the top left. */
function bandLogoBoxes(logoRatio) {
  const boxes = [];
  const logoHeight = BAND_LOGO_WIDTH * logoRatio;
  const step = SHEET.width / LOGOS_PER_BAND;
  for (let band = 0; band < BANDS; band++) {
    for (let index = 0; index < LOGOS_PER_BAND; index++) {
      boxes.push({
        x: step * (index + 0.5) - BAND_LOGO_WIDTH / 2,
        y: BAND_WIDTH * (band + 0.5) - logoHeight / 2,
        width: BAND_LOGO_WIDTH,
        height: logoHeight,
      });
    }
  }
  return boxes;
}

async function bandPdf(parts) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([
    (SHEET.width + 2 * BLEED) * MM,
    (SHEET.height + 2 * BLEED) * MM,
  ]);
  const pageHeight = SHEET.height + 2 * BLEED;
  page.setTrimBox(BLEED * MM, BLEED * MM, SHEET.width * MM, SHEET.height * MM);
  page.setBleedBox(0, 0, page.getWidth(), page.getHeight());
  page.drawRectangle({
    x: 0,
    y: 0,
    width: page.getWidth(),
    height: page.getHeight(),
    color: teal,
  });
  const logo = await pdf.embedPng(parts.logo);
  for (const box of bandLogoBoxes(parts.logoRatio)) {
    page.drawImage(logo, {
      x: (box.x + BLEED) * MM,
      y: (pageHeight - BLEED - box.y - box.height) * MM,
      width: box.width * MM,
      height: box.height * MM,
    });
  }
  return pdf.save();
}

async function stickerPdf(parts) {
  const pdf = await PDFDocument.create();
  const size = STICKER + 2 * BLEED;
  const page = pdf.addPage([size * MM, size * MM]);
  page.setTrimBox(BLEED * MM, BLEED * MM, STICKER * MM, STICKER * MM);
  page.setBleedBox(0, 0, page.getWidth(), page.getHeight());
  page.drawRectangle({
    x: 0,
    y: 0,
    width: page.getWidth(),
    height: page.getHeight(),
    color: teal,
  });
  const icon = await pdf.embedPng(parts.icon);
  const iconHeight = STICKER_ICON * parts.iconRatio;
  page.drawImage(icon, {
    x: ((size - STICKER_ICON) / 2) * MM,
    y: ((size - iconHeight) / 2) * MM,
    width: STICKER_ICON * MM,
    height: iconHeight * MM,
  });
  return pdf.save();
}

// The previews show the trimmed result: the sheet with its cut lines, the
// sticker as a circle.
async function bandPreview(parts) {
  const scale = 4; // pixels per mm
  const composites = [];
  for (const box of bandLogoBoxes(parts.logoRatio)) {
    composites.push({
      input: await sharp(parts.logo)
        .resize({ width: Math.round(box.width * scale) })
        .toBuffer(),
      left: Math.round(box.x * scale),
      top: Math.round(box.y * scale),
    });
  }
  const lines = [];
  for (let band = 1; band < BANDS; band++) {
    const y = band * BAND_WIDTH * scale;
    lines.push(
      `<line x1="0" y1="${y}" x2="${SHEET.width * scale}" y2="${y}" stroke="white" stroke-opacity="0.55" stroke-width="1.5" stroke-dasharray="10 8"/>`
    );
  }
  composites.push({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET.width * scale}" height="${SHEET.height * scale}">${lines.join('')}</svg>`
    ),
    left: 0,
    top: 0,
  });
  return sharp({
    create: {
      width: SHEET.width * scale,
      height: SHEET.height * scale,
      channels: 3,
      background: TEAL,
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

async function stickerPreview(parts) {
  const scale = 12;
  const size = STICKER * scale;
  const iconWidth = Math.round(STICKER_ICON * scale);
  const icon = await sharp(parts.icon).resize({ width: iconWidth }).toBuffer();
  const iconHeight = (await sharp(icon).metadata()).height;
  const circle = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="rgb(${TEAL.r},${TEAL.g},${TEAL.b})"/></svg>`
  );
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: circle, left: 0, top: 0 },
      {
        input: icon,
        left: Math.round((size - iconWidth) / 2),
        top: Math.round((size - iconHeight) / 2),
      },
    ])
    .png()
    .toBuffer();
}

const parts = await logoParts();
await fs.mkdir(outDir, { recursive: true });
const files = {
  'band-a4.pdf': await bandPdf(parts),
  'sticker-30mm.pdf': await stickerPdf(parts),
  'band-a4.png': await bandPreview(parts),
  'sticker-30mm.png': await stickerPreview(parts),
};
for (const [name, bytes] of Object.entries(files)) {
  await fs.writeFile(path.join(outDir, name), bytes);
  console.log(`${name.padEnd(18)} ${(bytes.length / 1024).toFixed(0)} kB`);
}
