/**
 * Renders a views/pdf_<name>.ejs company template and its stored-template
 * conversion (src/cardTemplates.ts) with the same cards and designs, prints
 * both to PDF the way the PDF Lambda does (puppeteer, networkidle2, fonts,
 * 500 ms, @page, page.pdf), rasterises them with pdftoppm and compares every
 * page pixel by pixel.
 *
 *   npx tsx scripts/card-templates/compare.ts --dir <templates> [--out <dir>] [--dpi 150] [name ...]
 *
 * <templates>/<name>/ holds template.json ({ cardSizeMm: 56|60|"printer",
 * note?, data? }), styles.css, front.liquid, back.liquid and assets/: the
 * layout `qrsong template push` sends. Without names every folder there is
 * compared. Needs Google Chrome (CHROME_PATH to override) and pdftoppm.
 *
 * Writes <out>/report.json and, for every page that differs, the two renders
 * and a diff picture (changed pixels in red).
 */
import 'dotenv/config';
import { existsSync, readdirSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import ejs from 'ejs';
import QRCode from 'qrcode';
import puppeteer from 'puppeteer-core';
import { cardTemplateCsp, FIT_SCRIPT, newNonce, printerCardSizeMm, renderCards } from '../../src/cardTemplates';
import { printerPageSizeMm } from '../../src/pdf';
import { getFontWeight, getGoogleFontName, getGoogleFontWeights, getYearFontSize } from '../../src/fonts';
import { getQrTotalModules } from '../../src/qr';
import {
  BASE_DESIGN,
  CHROME,
  comparePages,
  fixtureImage,
  howtoTranslations,
  loadTemplate,
  Page,
  printPdf,
  REPO,
  rasterise,
  SCENARIOS,
  startServer,
  TRACKS,
  VIEWS,
} from './harness';

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
function option(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
}
const dirArg = option('dir');
const templatesDir = path.resolve(dirArg || '.');
const outDir = path.resolve(option('out', path.join(os.tmpdir(), 'card-template-compare'))!);
const dpi = parseInt(option('dpi', '150')!);
if (!dirArg || !existsSync(templatesDir)) {
  console.error('usage: compare.ts --dir <templates> [--out <dir>] [--dpi 150] [name ...]');
  process.exit(2);
}
const names = argv.length ? argv : readdirSync(templatesDir).filter((n) => existsSync(path.join(templatesDir, n, 'template.json')));

// ------------------------------------------------------------------ main

async function main() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'card-compare-'));

  const staticFiles = new Map<string, Buffer>();
  staticFiles.set('/public/background/fx_front.png', await fixtureImage(1200, 1200, '#ff7a59', '#5b2a86', 'FRONT'));
  staticFiles.set('/public/background/fx_back.png', await fixtureImage(1200, 1200, '#0f9b8e', '#f6d365', 'BACK'));
  // ahaieee reads its back from the company-list upload folder.
  staticFiles.set('/public/companydata/backgrounds/fx_back.png', staticFiles.get('/public/background/fx_back.png')!);
  staticFiles.set('/public/logo/fx_logo.png', await fixtureImage(600, 200, '#222222', '#888888', 'LOGO'));
  for (const t of TRACKS) {
    staticFiles.set(
      `/public/qr/fixture/${t.trackId}.png`,
      await QRCode.toBuffer(`https://qrsong.io/qr2/${t.trackId}/12345`, { width: 600, margin: 1 })
    );
  }
  const pages = new Map<string, Page>();
  const { server, origin } = await startServer(staticFiles, pages);
  process.env['API_URI'] = origin;

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--font-render-hinting=none'] });
  const howto = howtoTranslations();
  const report: any[] = [];

  try {
    for (const name of names) {
      const ejsFile = path.join(VIEWS, `pdf_${name}.ejs`);
      const entry: any = { name, cases: [] };
      report.push(entry);
      if (!existsSync(ejsFile)) {
        entry.error = `no ${path.relative(REPO, ejsFile)}`;
        continue;
      }
      let loaded;
      try {
        loaded = await loadTemplate(templatesDir, name);
      } catch (error: any) {
        entry.error = error.message;
        console.log(`${name}: ${error.message}`);
        continue;
      }
      const { template, files } = loaded;
      for (const [file, bytes] of files) staticFiles.set(`/public/card-templates/${name}/${file}`, bytes);

      const printers = template.cardSizeMm === null ? ['schneiders', 'tromp'] : [template.cardSizeMm === 56 ? 'schneiders' : 'tromp'];
      for (const printerType of printers) {
        for (const scenario of SCENARIOS) {
          const label = `${name}/${printerType}/${scenario.name}`;
          const php = { ...BASE_DESIGN, ...scenario.design, printerType, eco: scenario.eco };
          const designs = [php];
          const cardDesignIndexes = TRACKS.map(() => 0);
          const common = {
            subdir: 'fixture',
            payment: { paymentId: 'fixture' },
            playlist: { name: 'Fixture playlist' },
            php,
            tracks: TRACKS,
            designs,
            cardDesigns: designs.map(() => php),
            cardDesignIndexes,
            user: {},
            eco: scenario.eco,
            emptyPages: 0,
            batchNumber: '12345',
            startIndex: 0,
            howtoTranslations: howto,
            getYearFontSize,
            getGoogleFontWeights,
            getGoogleFontName,
            getFontWeight,
            getQrTotalModules,
          };
          const caseEntry: any = { printerType, scenario: scenario.name };
          entry.cases.push(caseEntry);
          try {
            const oldHtml = await ejs.renderFile(ejsFile, common, { async: false });
            const stored = renderCards(template, {
              php,
              designs,
              cardDesignIndexes,
              tracks: TRACKS,
              subdir: 'fixture',
              eco: scenario.eco,
              startIndex: 0,
              batchNumber: '12345',
              apiUri: origin,
            }, { cacheable: false });
            const nonce = newNonce();
            const newHtml = await ejs.renderFile(
              path.join(VIEWS, 'stored_card_page.ejs'),
              { ...common, stored, fitNonce: nonce, fitScript: FIT_SCRIPT },
              { async: false }
            );
            const key = label.replace(/\//g, '__');
            pages.set(`/page/old/${key}`, { html: oldHtml });
            pages.set(`/page/new/${key}`, { html: newHtml, csp: cardTemplateCsp(origin, nonce) });

            const oldSize = printerPageSizeMm(name, printerType);
            const newSize = template.cardSizeMm ?? printerCardSizeMm(printerType);
            caseEntry.pageSizeMm = { old: oldSize, new: newSize };
            const caseDir = path.join(work, key);
            await fs.mkdir(caseDir, { recursive: true });
            const oldPdf = path.join(caseDir, 'old.pdf');
            const newPdf = path.join(caseDir, 'new.pdf');
            caseEntry.problems = {
              old: await printPdf(browser, `${origin}/page/old/${key}`, oldSize, oldPdf),
              new: await printPdf(browser, `${origin}/page/new/${key}`, newSize, newPdf),
            };
            const oldPages = await rasterise(oldPdf, path.join(caseDir, 'old'), dpi);
            const newPages = await rasterise(newPdf, path.join(caseDir, 'new'), dpi);
            caseEntry.pages = { old: oldPages.length, new: newPages.length };
            caseEntry.differing = [];
            // The first card of every case, to look at.
            for (let i = 0; i < Math.min(2, newPages.length); i++) {
              await fs.copyFile(newPages[newPages.length > 16 ? i + 2 : i], path.join(outDir, `${key}__sample${i + 1}.png`));
            }
            const count = Math.max(oldPages.length, newPages.length);
            for (let i = 0; i < count; i++) {
              if (!oldPages[i] || !newPages[i]) {
                caseEntry.differing.push({ page: i + 1, missing: !oldPages[i] ? 'old' : 'new' });
                continue;
              }
              const diffFile = path.join(outDir, `${key}__p${i + 1}_diff.png`);
              const result = await comparePages(oldPages[i], newPages[i], diffFile);
              if (!result.identical) {
                await fs.copyFile(oldPages[i], path.join(outDir, `${key}__p${i + 1}_old.png`));
                await fs.copyFile(newPages[i], path.join(outDir, `${key}__p${i + 1}_new.png`));
                caseEntry.differing.push({ page: i + 1, ...result });
              }
            }
            caseEntry.identical = caseEntry.differing.length === 0 && oldPages.length === newPages.length;
            const status = caseEntry.identical ? 'identical' : `${caseEntry.differing.length} of ${count} pages differ`;
            console.log(`${label}: ${status} (${oldPages.length} pages)`);
            const problems = [...caseEntry.problems.old.map((p: string) => `old ${p}`), ...caseEntry.problems.new.map((p: string) => `new ${p}`)];
            for (const p of problems) console.log(`  ${p}`);
          } catch (error: any) {
            caseEntry.error = error?.message || String(error);
            console.log(`${label}: ERROR ${caseEntry.error}`);
          }
        }
      }
      entry.identical = entry.cases.length > 0 && entry.cases.every((c: any) => c.identical);
    }
  } finally {
    await browser.close();
    server.close();
    await fs.rm(work, { recursive: true, force: true });
  }

  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const same = report.filter((r) => r.identical).map((r) => r.name);
  const other = report.filter((r) => !r.identical).map((r) => r.name);
  console.log(`\n${same.length} identical: ${same.join(', ') || '-'}`);
  console.log(`${other.length} not identical: ${other.join(', ') || '-'}`);
  console.log(`report: ${path.join(outDir, 'report.json')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
