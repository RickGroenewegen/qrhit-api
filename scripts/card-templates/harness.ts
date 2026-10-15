/**
 * Shared by compare.ts and render.ts: fixture cards and designs, loading a
 * template folder, a local static server standing in for the API (assets,
 * uploads, QR pictures and the rendered pages, the stored-template ones with
 * their CSP), and printing a page to PDF the way the PDF Lambda does
 * (puppeteer, networkidle2, fonts, 500 ms, @page, page.pdf).
 */
import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import { promisify } from 'util';
import sharp from 'sharp';
import { buildFontFaces, CardTemplateVersion, checkAsset, checkSource } from '../../src/cardTemplates';

const run = promisify(execFile);
export const REPO = path.resolve(__dirname, '../..');
export const VIEWS = path.join(REPO, 'src/views');
export const CHROME = process.env['CHROME_PATH'] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ------------------------------------------------------------------ fixtures

export const TRACKS = [
  { trackId: 'fx01', artist: 'ABBA', name: 'Dancing Queen', year: 1976, extraArtistAttribute: '', extraNameAttribute: '' },
  {
    trackId: 'fx02',
    artist: 'Earth, Wind & Fire with The Emotions',
    name: 'Boogie Wonderland - Single Version Remastered 2010',
    year: 1979,
    extraArtistAttribute: '',
    extraNameAttribute: '',
  },
  { trackId: 'fx03', artist: 'Doe Maar', name: 'Is Dit Alles', year: 1983, extraArtistAttribute: 'Nederpop', extraNameAttribute: 'Live <b>1983</b>' },
  { trackId: 'fx04', artist: 'Beyoncé', name: 'Crazy In Love (feat. JAY-Z)', year: 2003, extraArtistAttribute: '', extraNameAttribute: '' },
  { trackId: 'fx05', artist: 'Måneskin', name: 'ZITTI E BUONI', year: 2021, extraArtistAttribute: '', extraNameAttribute: '' },
  {
    trackId: 'fx06',
    artist: 'Wolfgang Amadeus Mozart, Berliner Philharmoniker, Herbert von Karajan',
    name: 'Eine kleine Nachtmusik, K. 525: I. Allegro',
    year: 1787,
    extraArtistAttribute: '',
    extraNameAttribute: '',
  },
  { trackId: 'fx07', artist: 'Queen', name: 'Bohemian Rhapsody', year: 1975, extraArtistAttribute: '', extraNameAttribute: '' },
  {
    trackId: 'fx08',
    artist: 'Supercalifragilisticexpialidocious Orchestra',
    name: 'Pneumonoultramicroscopicsilicovolcanoconiosis',
    year: 1964,
    extraArtistAttribute: '',
    extraNameAttribute: '',
  },
];

export const BASE_DESIGN: Record<string, any> = {
  emoji: '',
  background: null,
  logo: null,
  selectedFont: 'Arial, sans-serif',
  selectedFontSize: '16px',
  hideCircle: true,
  qrBackgroundType: 'none',
  qrColor: '#000000',
  qrBackgroundColor: '#ffffff',
  qrLogo: null,
  qrLogoScale: 25,
  backgroundFrontType: 'image',
  backgroundFrontColor: '#ffffff',
  useFrontGradient: false,
  gradientFrontColor: '#ffffff',
  gradientFrontDegrees: 180,
  gradientFrontPosition: 50,
  frontOpacity: 100,
  backgroundBackType: 'image',
  backgroundBack: null,
  backgroundBackColor: '#ffffff',
  fontColor: '#000000',
  useGradient: false,
  gradientBackgroundColor: '#ffffff',
  gradientDegrees: 180,
  gradientPosition: 50,
  backOpacity: 100,
  sameAsFront: false,
  addHowToCard: false,
  addHowToCardLocale: 'en',
  howToCardImage: null,
  howToCardRulesImage: null,
  howToCardNumberColor: null,
  doubleSided: true,
  paymentHasPlaylistId: 12345,
};

/** Designs that walk the branches the templates have. */
export const SCENARIOS: { name: string; eco: boolean; design: Record<string, any> }[] = [
  { name: 'default', eco: false, design: {} },
  {
    name: 'images',
    eco: false,
    design: {
      background: 'fx_front.png',
      backgroundBack: 'fx_back.png',
      logo: 'fx_logo.png',
      qrBackgroundType: 'square',
      hideCircle: false,
      qrBackgroundColor: '#fff3c4',
      frontOpacity: 80,
      backOpacity: 60,
      fontColor: '#1a237e',
      selectedFont: 'Oswald, Arial, sans-serif',
      selectedFontSize: '15px',
    },
  },
  {
    name: 'solid-howto-eco',
    eco: true,
    design: {
      backgroundFrontType: 'solid',
      backgroundFrontColor: '#ffe0e0',
      useFrontGradient: true,
      gradientFrontColor: '#a0c4ff',
      gradientFrontDegrees: 135,
      gradientFrontPosition: 40,
      backgroundBackType: 'solid',
      backgroundBackColor: '#203040',
      useGradient: true,
      gradientBackgroundColor: '#405060',
      gradientDegrees: 90,
      gradientPosition: 60,
      qrBackgroundType: 'circle',
      qrBackgroundColor: '#ffffff',
      fontColor: '#ffffff',
      logo: 'fx_logo.png',
      addHowToCard: true,
    },
  },
];

export async function fixtureImage(w: number, h: number, a: string, b: string, label: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <circle cx="${w * 0.25}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.18}" fill="#ffffff" fill-opacity="0.35"/>
    <rect x="${w * 0.55}" y="${h * 0.55}" width="${w * 0.3}" height="${h * 0.3}" fill="#000000" fill-opacity="0.2"/>
    <text x="${w / 2}" y="${h / 2}" font-size="${Math.min(w, h) / 6}" text-anchor="middle" fill="#ffffff" font-family="Arial">${label}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export function howtoTranslations(): Record<string, string> {
  const en = JSON.parse(readFileSync(path.join(REPO, 'src/locales/en.json'), 'utf8'));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(en)) if (k.startsWith('howto.')) out[k.slice(6)] = String(v);
  return out;
}

// ------------------------------------------------------------------ templates

export async function loadTemplate(templatesDir: string, name: string): Promise<{ template: CardTemplateVersion; files: Map<string, Buffer> }> {
  const dir = path.join(templatesDir, name);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'template.json'), 'utf8'));
  const source = {
    cardSizeMm: manifest.cardSizeMm === 'printer' ? null : Number(manifest.cardSizeMm),
    css: await fs.readFile(path.join(dir, 'styles.css'), 'utf8'),
    front: await fs.readFile(path.join(dir, 'front.liquid'), 'utf8'),
    back: await fs.readFile(path.join(dir, 'back.liquid'), 'utf8'),
    data: manifest.data ?? null,
    designFont: manifest.designFont,
  };
  const errors = checkSource(source);
  if (errors.length) throw new Error(`${name}: ${errors.join('; ')}`);
  const assets: Record<string, string> = {};
  const files = new Map<string, Buffer>();
  const byName = new Map<string, Buffer>();
  const assetDir = path.join(dir, 'assets');
  if (existsSync(assetDir)) {
    for (const file of (await fs.readdir(assetDir)).filter((f) => !f.startsWith('.'))) {
      const bytes = await fs.readFile(path.join(assetDir, file));
      const stored = await checkAsset({ name: file, bytes });
      assets[file] = stored;
      files.set(stored, bytes);
      byName.set(file, bytes);
    }
  }
  const fonts = buildFontFaces(manifest.fonts, byName);
  return { template: { name, version: 1, ...source, fonts, assets }, files };
}

// ------------------------------------------------------------------ server

export interface Page {
  html: string;
  csp?: string;
}

export async function startServer(staticFiles: Map<string, Buffer>, pages: Map<string, Page>) {
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.svg': 'image/svg+xml',
    '.css': 'text/css',
  };
  const server = http.createServer(async (req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const page = pages.get(url);
    if (page) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(page.csp ? { 'Content-Security-Policy': page.csp } : {}) });
      return res.end(page.html);
    }
    const mem = staticFiles.get(url);
    if (mem) {
      res.writeHead(200, { 'Content-Type': types[path.extname(url)] || 'application/octet-stream' });
      return res.end(mem);
    }
    if (url.startsWith('/assets/') && !url.includes('..')) {
      const file = path.join(REPO, 'assets', url.slice('/assets/'.length));
      if (existsSync(file)) {
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        return res.end(await fs.readFile(file));
      }
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  return { server, origin: `http://127.0.0.1:${port}` };
}

// ------------------------------------------------------------------ render + compare

export async function printPdf(browser: any, url: string, sizeMm: number, file: string): Promise<string[]> {
  const page = await browser.newPage();
  const problems: string[] = [];
  page.on('console', (msg: any) => {
    // A failed load is reported by the response handler, with its URL.
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) problems.push(`console: ${msg.text()}`);
  });
  page.on('requestfailed', (req: any) => problems.push(`request failed: ${req.url()} (${req.failure()?.errorText})`));
  page.on('response', (res: any) => {
    if (res.status() >= 400 && !res.url().endsWith('/favicon.ico')) problems.push(`HTTP ${res.status()}: ${res.url()}`);
  });
  const px = Math.ceil(sizeMm * (96 / 25.4));
  await page.setViewport({ width: px, height: px, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.evaluate(() => (document as any).fonts.ready);
  await new Promise((r) => setTimeout(r, 500));
  await page.addStyleTag({
    content: `@page { size: ${sizeMm}mm ${sizeMm}mm; margin: 0; } html, body { margin: 0; padding: 0; }`,
  });
  await page.pdf({
    path: file,
    printBackground: true,
    outline: false,
    tagged: false,
    preferCSSPageSize: true,
    margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    width: `${sizeMm}mm`,
    height: `${sizeMm}mm`,
  });
  await page.close();
  return problems;
}

export async function rasterise(pdf: string, prefix: string, dpi: number): Promise<string[]> {
  await run('pdftoppm', ['-r', String(dpi), '-png', pdf, prefix]);
  const dir = path.dirname(prefix);
  const base = path.basename(prefix);
  return (await fs.readdir(dir))
    .filter((f) => f.startsWith(`${base}-`) && f.endsWith('.png'))
    .sort((a, b) => parseInt(a.slice(base.length + 1)) - parseInt(b.slice(base.length + 1)))
    .map((f) => path.join(dir, f));
}

export async function comparePages(a: string, b: string, diffFile: string) {
  const [ia, ib] = await Promise.all([
    sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (ia.info.width !== ib.info.width || ia.info.height !== ib.info.height) {
    return { identical: false, changed: 1, maxDelta: 255, size: `${ia.info.width}x${ia.info.height} vs ${ib.info.width}x${ib.info.height}` };
  }
  const n = ia.info.width * ia.info.height;
  const diff = Buffer.alloc(n * 4);
  let changed = 0;
  let maxDelta = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs(ia.data[o] - ib.data[o]),
      Math.abs(ia.data[o + 1] - ib.data[o + 1]),
      Math.abs(ia.data[o + 2] - ib.data[o + 2])
    );
    if (d > maxDelta) maxDelta = d;
    if (d > 0) {
      changed++;
      diff[o] = 255;
      diff[o + 3] = 255;
    } else {
      const grey = Math.round((ia.data[o] + ia.data[o + 1] + ia.data[o + 2]) / 3);
      diff[o] = diff[o + 1] = diff[o + 2] = Math.round(255 - (255 - grey) * 0.25);
      diff[o + 3] = 255;
    }
  }
  if (changed) {
    await sharp(diff, { raw: { width: ia.info.width, height: ia.info.height, channels: 4 } }).png().toFile(diffFile);
  }
  return { identical: changed === 0, changed: changed / n, maxDelta };
}

