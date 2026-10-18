/**
 * A local proof of the default playlists brochure (views/default_playlists.ejs):
 * renders it from a JSON file of rows, the way GET /business/default-playlists/view
 * does, and prints it like the PDF Lambda (viewport 1920x1080, A4, margin 0,
 * preferCSSPageSize) with the local Google Chrome. No database, no API, no
 * Spotify: the rows come from the file and the QR codes are made locally.
 *
 *   npx tsx scripts/default-playlists/render.ts [--fixture <rows.json>] [--locale nl,en,de]
 *        [--themes 80s-hits,christmas] [--sizes 48,96] [--ids 1,2,3]
 *        [--name proof] [--out <dir>] [--png 60]
 *
 * rows.json: DefaultPlaylistRow[] as GET /business/default-playlists answers
 * (default: scripts/default-playlists/fixture.json, 30 themes x 3 sizes).
 * Writes <out>/<name>-<locale>.pdf and, with --png > 0, a PNG per page at that
 * dpi. Before printing it checks in Chrome that nothing overflows a sheet, a
 * theme row or its text column, that every QR code is at least 16 mm and that
 * the PDF has the pages the view planned; any problem is listed and the exit
 * code is 1.
 */
import 'dotenv/config';
import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import ejs from 'ejs';
import { PDFDocument } from 'pdf-lib';
import puppeteer from 'puppeteer-core';
import {
  BROCHURE_LAYOUT,
  buildDefaultPlaylistsView,
  DefaultPlaylistRow,
  getDefaultPlaylistsTranslator,
} from '../../src/defaultPlaylists';
import Translation from '../../src/translation';
import { CHROME, Page, REPO, startServer, VIEWS } from '../card-templates/harness';

const run = promisify(execFile);
const argv = process.argv.slice(2);
function option(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
}
const list = (value?: string) => (value ? value.split(',').map((v) => v.trim()).filter(Boolean) : []);

const fixture = path.resolve(option('fixture', path.join(__dirname, 'fixture.json'))!);
const locales = list(option('locale', 'nl,en,de'));
const themes = list(option('themes'));
const sizes = list(option('sizes')).map(Number);
const ids = list(option('ids')).map(Number);
const name = option('name', 'default-playlists')!;
const outDir = path.resolve(option('out', path.join(os.tmpdir(), 'default-playlists-render'))!);
const dpi = parseInt(option('png', '60')!);

/** Runs in the page: everything that would make a printed sheet wrong. */
function layoutProblems(minQrMm: number, bodyMm: number): string[] {
  const problems: string[] = [];
  const mm = (px: number) => (px * 25.4) / 96;
  const label = (el: Element) => {
    const sheet = el.closest('.sheet, .cover, .closing');
    const all = Array.from(document.querySelectorAll('.cover, .sheet, .closing'));
    const theme = el.closest('.dp-theme')?.querySelector('.dp-name-text')?.textContent?.trim();
    return `page ${all.indexOf(sheet as Element) + 1}${theme ? ` "${theme}"` : ''} ${el.className}`;
  };
  const over = (el: Element, slack = 1) => {
    const h = el as HTMLElement;
    if (h.scrollHeight > h.clientHeight + slack) problems.push(`${label(el)}: ${h.scrollHeight - h.clientHeight}px too tall`);
    if (h.scrollWidth > h.clientWidth + slack) problems.push(`${label(el)}: ${h.scrollWidth - h.clientWidth}px too wide`);
  };
  document.querySelectorAll('.cover, .sheet, .closing').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (Math.abs(mm(r.height) - 297) > 0.5) problems.push(`${label(el)}: ${mm(r.height).toFixed(1)} mm tall, not 297`);
    over(el);
  });
  // The content of a sheet body must end above the footer, and a theme page
  // must really have the height the pagination counts on.
  document.querySelectorAll('.sheet-body').forEach((body) => {
    const bottom = body.getBoundingClientRect().bottom;
    const height = mm(body.getBoundingClientRect().height);
    if (body.querySelector('.dp-theme') && height < bodyMm) problems.push(`${label(body)}: ${height.toFixed(1)} mm, less than the ${bodyMm} mm counted on`);
    Array.from(body.children).forEach((child) => {
      const b = child.getBoundingClientRect().bottom;
      if (b > bottom + 0.5) problems.push(`${label(child)}: runs ${mm(b - bottom).toFixed(1)} mm into the footer`);
    });
  });
  // .dp-artists too: its names are cut to whole names beforehand, so a clamp there would cut one.
  document
    .querySelectorAll('.dp-theme, .dp-info, .dp-name, .dp-artists, .dp-chart, .dp-sizes, .b-panel:not(.disco), .b-format')
    .forEach((el) => over(el));
  // A clamped text must stop at a whole line.
  document.querySelectorAll('.dp-desc, .dp-name-text').forEach((el) => {
    const h = el as HTMLElement;
    const line = parseFloat(getComputedStyle(h).lineHeight);
    const lines = h.clientHeight / line;
    if (Math.abs(lines - Math.round(lines)) > 0.05) problems.push(`${label(el)}: cut mid-line (${lines.toFixed(2)} lines)`);
  });
  document.querySelectorAll('.dp-qr').forEach((el) => {
    // The symbol is 33 of the 41 modules; the rest is the quiet zone.
    const symbol = mm(el.getBoundingClientRect().width) * (33 / 41);
    if (symbol < minQrMm) problems.push(`${label(el)}: QR code only ${symbol.toFixed(1)} mm`);
  });
  return problems;
}

async function main() {
  const all: DefaultPlaylistRow[] = JSON.parse(readFileSync(fixture, 'utf8'));
  const rows = all.filter(
    (row) =>
      (!themes.length || themes.includes(row.themeKey)) &&
      (!sizes.length || sizes.includes(row.cardCount)) &&
      (!ids.length || ids.includes(row.id))
  );
  if (!rows.length) throw new Error('no rows left after the filters');

  const pages = new Map<string, Page>();
  const { server, origin } = await startServer(new Map(), pages);
  const translation = new Translation();
  await fs.mkdir(outDir, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--font-render-hinting=none'] });
  let failed = false;
  try {
    for (const requested of locales) {
      const locale = translation.resolveBusinessLocale(requested);
      const view = buildDefaultPlaylistsView(rows, {
        locale,
        t: await getDefaultPlaylistsTranslator(translation, locale),
        intlTag: translation.getIntlTag(locale),
        baseUrl: origin,
      });
      const html = await ejs.renderFile(path.join(VIEWS, 'default_playlists.ejs'), view, { async: false });
      pages.set(`/${locale}`, { html });

      const page = await browser.newPage();
      const problems: string[] = [];
      page.on('requestfailed', (req: any) => problems.push(`request failed: ${req.url()} (${req.failure()?.errorText})`));
      page.on('response', (res: any) => {
        if (res.status() >= 400 && !res.url().endsWith('/favicon.ico')) problems.push(`HTTP ${res.status()}: ${res.url()}`);
      });
      // tsx (esbuild keepNames) wraps the named helpers in layoutProblems in __name().
      await page.evaluateOnNewDocument('window.__name = (fn) => fn;');
      await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
      await page.goto(`${origin}/${locale}`, { waitUntil: 'networkidle2', timeout: 120000 });
      await page.evaluate(() => (document as any).fonts.ready);
      await new Promise((r) => setTimeout(r, 500));
      await page.emulateMediaType('print');
      problems.push(...(await page.evaluate(layoutProblems, 16, BROCHURE_LAYOUT.BODY_MM)));
      const bodyMm = await page.evaluate(() => Math.min(...Array.from(document.querySelectorAll('.sheet-body')).map((b) => (b.getBoundingClientRect().height * 25.4) / 96)));

      const pdf = path.join(outDir, `${name}-${locale}.pdf`);
      await page.pdf({
        path: pdf,
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      });
      await page.close();

      const printed = (await PDFDocument.load(await fs.readFile(pdf))).getPageCount();
      if (printed !== view.pageCount) problems.push(`the PDF has ${printed} pages, the view planned ${view.pageCount}`);

      let pngs: string[] = [];
      if (dpi > 0) {
        const prefix = path.join(outDir, `${name}-${locale}`);
        await run('pdftoppm', ['-r', String(dpi), '-png', pdf, prefix]);
        pngs = (await fs.readdir(outDir))
          .filter((f) => f.startsWith(`${name}-${locale}-`) && f.endsWith('.png'))
          .sort((a, b) => parseInt(a.slice(name.length + locale.length + 2)) - parseInt(b.slice(name.length + locale.length + 2)))
          .map((f) => path.join(outDir, f));
      }
      failed ||= problems.length > 0;
      console.log(
        JSON.stringify(
          {
            locale,
            pdf,
            themes: view.themeCount,
            playlists: view.playlistCount,
            pages: printed,
            bodyMm: Number(bodyMm.toFixed(1)),
            perPage: view.pages.map((p) => p.items.filter((i) => i.kind === 'theme').length),
            pngs: pngs.length,
            problems,
          },
          null,
          2
        )
      );
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`layout: ${JSON.stringify(BROCHURE_LAYOUT)} (repo ${REPO})`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
