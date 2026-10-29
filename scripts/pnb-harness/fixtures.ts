import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { color } from 'console-log-colors';
import Log from '../../src/logger';
import { API_ROOT, FILES_DIR, FIXTURES_FILE, DEFAULT_FILE_BASE } from './config';
import type { FileInfo, FixtureLine, Fixtures, ReplayFixture } from './types';

const logger = new Log();

/** How far back to look for orders of each shape. */
const WINDOW_DAYS = 120;

/** Address fields taken out of a replayed request before it is stored. */
const PERSONAL_FIELDS = [
  'contact',
  'company',
  'street',
  'number',
  'number_ext',
  'postalcode',
  'city',
  'province',
  'email',
  'delivery_instruction',
];

/**
 * One read-only query against production through _scripts/ro-query.sh
 * (the read-only user, 10 s statement limit). Rows come back as objects.
 */
function query(sql: string): Record<string, string | null>[] {
  const output = execFileSync(
    path.join(API_ROOT, '_scripts', 'ro-query.sh'),
    ['--batch', sql],
    { cwd: API_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const lines = output.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t').map(unescapeBatch);
    return Object.fromEntries(header.map((name, i) => [name, cells[i] ?? null]));
  });
}

/** mysql --batch escapes tab, newline, NUL and backslash; NULL is literal. */
function unescapeBatch(cell: string): string | null {
  if (cell === 'NULL') return null;
  return cell.replace(/\\(.)/g, (_, char) => {
    switch (char) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '0':
        return '\0';
      case 'b':
        return '\b';
      default:
        return char;
    }
  });
}

const LINE_COLUMNS = `
  p.id AS paymentDbId, DATE_FORMAT(p.createdAt, '%Y-%m-%d') AS created,
  p.countrycode, p.fast,
  php.id AS phpId, pl.name AS playlistName, php.numberOfTracks, php.amount,
  php.subType, php.addHowToCard, php.boxEnabled, php.boxQuantity,
  php.boxFilename, php.printerPageCount, php.filename,
  (SELECT GROUP_CONCAT(i.filename ORDER BY i.\`index\` SEPARATOR '|')
     FROM payment_has_playlist_item i WHERE i.paymentHasPlaylistId = php.id) AS itemFiles,
  (SELECT COUNT(*) FROM payment_has_playlist x
     WHERE x.paymentId = p.id AND x.type = 'physical') AS physicalLines`;

const LINE_FROM = `
  FROM payment_has_playlist php
  JOIN payments p ON p.id = php.paymentId
  JOIN playlists pl ON pl.id = php.playlistId
  WHERE p.status = 'paid' AND php.type = 'physical' AND php.printerType = 'printnbind'`;

function toLine(row: Record<string, string | null>): FixtureLine {
  const itemFiles = (row['itemFiles'] || '').split('|').filter(Boolean);
  const usesItems = itemFiles.length > 0;
  const amount = parseInt(row['amount'] || '1', 10) || 1;
  return {
    paymentDbId: Number(row['paymentDbId']),
    created: row['created'] || '',
    countrycode: (row['countrycode'] || 'NL').toUpperCase(),
    fast: row['fast'] === '1',
    phpId: Number(row['phpId']),
    playlistName: row['playlistName'] || '',
    numberOfTracks: Number(row['numberOfTracks']),
    amount,
    subType: row['subType'] || 'none',
    addHowToCard: row['addHowToCard'] === '1',
    boxEnabled: row['boxEnabled'] === '1',
    boxQuantity: Number(row['boxQuantity'] || 0),
    boxFilename: row['boxFilename'] || null,
    printerPageCount: Number(row['printerPageCount'] || 0),
    cardFiles: usesItems
      ? itemFiles
      : Array.from({ length: amount }, () => row['filename'] || '').filter(Boolean),
    usesItems,
    physicalLines: Number(row['physicalLines'] || 1),
  };
}

export const cardsUrl = (base: string, file: string) => `${base}/public/pdf/${file}`;
export const insertUrl = (base: string, file: string) => `${base}/public/box-insert/${file}`;

const totalBoxes = (line: FixtureLine) =>
  line.boxEnabled ? line.boxQuantity * line.amount : 0;

/** Which production orders stand for which case, newest first. */
const SHAPES: Record<string, (line: FixtureLine) => boolean> = {
  deckSmall: (l) =>
    l.physicalLines === 1 && l.subType === 'none' && !l.boxEnabled &&
    !l.addHowToCard && l.amount === 1 && l.numberOfTracks >= 40 && l.numberOfTracks <= 150,
  deckLarge: (l) =>
    l.physicalLines === 1 && l.subType === 'none' && !l.boxEnabled &&
    l.amount === 1 && l.numberOfTracks >= 400 && l.numberOfTracks <= 700,
  deckXl: (l) =>
    l.physicalLines === 1 && l.subType === 'none' && l.amount === 1 &&
    l.numberOfTracks >= 900,
  howto: (l) => l.physicalLines === 1 && l.addHowToCard,
  sheets: (l) =>
    l.physicalLines === 1 && l.subType === 'sheets' && !l.boxEnabled && l.amount === 1,
  box1: (l) =>
    l.physicalLines === 1 && l.subType === 'none' && totalBoxes(l) === 1 &&
    l.amount === 1 && l.numberOfTracks >= 80 && l.numberOfTracks <= 400 && !!l.boxFilename,
  box2: (l) =>
    l.physicalLines === 1 && l.subType === 'none' && totalBoxes(l) === 2 && !!l.boxFilename,
  boxXl: (l) =>
    l.physicalLines === 1 && l.subType === 'none' && l.boxEnabled &&
    l.numberOfTracks >= 400 && !!l.boxFilename,
  twoCopies: (l) =>
    l.physicalLines === 1 && l.amount === 2 && l.usesItems && !l.boxEnabled,
  fast: (l) => l.physicalLines === 1 && l.fast && l.subType === 'none',
};

async function fetchFile(url: string, kind: FileInfo['kind']): Promise<FileInfo> {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const local = path.join(FILES_DIR, `${createHash('sha1').update(url).digest('hex')}.pdf`);
  try {
    if (!fs.existsSync(local)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) {
        return { url, kind, bytes: null, pages: null, fetch: `HTTP ${response.status}` };
      }
      fs.writeFileSync(local, Buffer.from(await response.arrayBuffer()));
    }
    const bytes = fs.readFileSync(local);
    // The same count production makes (PDF.countPDFPages: pdf-lib)
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return { url, kind, bytes: bytes.length, pages: doc.getPageCount(), fetch: 'HTTP 200' };
  } catch (error: any) {
    return { url, kind, bytes: null, pages: null, fetch: String(error?.message || error) };
  }
}

function lineUrls(base: string, line: FixtureLine): { url: string; kind: FileInfo['kind'] }[] {
  const urls: { url: string; kind: FileInfo['kind'] }[] = line.cardFiles.map((file) => ({
    url: cardsUrl(base, file),
    kind: 'cards',
  }));
  if (line.boxEnabled && line.boxFilename) {
    urls.push({ url: insertUrl(base, line.boxFilename), kind: 'insert' });
  }
  return urls;
}

/** Strip the address from a stored request and keep what Print&Bind saw otherwise. */
function replayFrom(row: Record<string, string | null>): ReplayFixture[] {
  let stored: any;
  try {
    stored = JSON.parse(row['printApiOrderResponse'] || '');
  } catch {
    return [];
  }
  const replays: ReplayFixture[] = [];
  for (const call of stored?.apiCalls ?? []) {
    if (!(call?.statusCode >= 500) || !call.body || !/\/orders(\/calculate)?$/.test(call.url || '')) {
      continue;
    }
    const request = { ...call.body };
    for (const field of PERSONAL_FIELDS) delete request[field];
    replays.push({
      paymentDbId: Number(row['id']),
      created: row['created'] || '',
      url: call.url,
      status: call.statusCode,
      responseBody: call.responseBody ?? null,
      request,
    });
  }
  return replays;
}

export async function buildFixtures(fileBase = DEFAULT_FILE_BASE): Promise<Fixtures> {
  logger.log(color.blue.bold(`Reading production orders of the last ${color.white.bold(WINDOW_DAYS)} days (read-only)`));
  const lines = query(
    `SELECT ${LINE_COLUMNS} ${LINE_FROM} AND p.createdAt > NOW() - INTERVAL ${WINDOW_DAYS} DAY ORDER BY p.id DESC LIMIT 1500`
  ).map(toLine);
  logger.log(color.blue.bold(`Found ${color.white.bold(lines.length)} physical Print&Bind order lines`));

  const files: Record<string, FileInfo> = {};
  const ensure = async (url: string, kind: FileInfo['kind']) => {
    if (!files[url]) {
      files[url] = await fetchFile(url, kind);
      const info = files[url];
      logger.log(
        (info.pages ? color.green.bold('  file ') : color.red.bold('  file ')) +
          color.white.bold(path.basename(url)) +
          color.gray(` ${info.fetch}, ${info.pages ?? '?'} pages, ${info.bytes ? (info.bytes / 1e6).toFixed(1) : '?'} MB`)
      );
    }
    return files[url];
  };
  const usable = async (line: FixtureLine) => {
    if (line.cardFiles.length === 0) return false;
    for (const { url, kind } of lineUrls(fileBase, line)) {
      if (!(await ensure(url, kind)).pages) return false;
    }
    return true;
  };

  const shapes: Record<string, FixtureLine[]> = {};
  for (const [shape, matches] of Object.entries(SHAPES)) {
    let candidates = lines.filter(matches);
    if (shape === 'deckXl' || shape === 'boxXl') {
      candidates = candidates.sort((a, b) => b.numberOfTracks - a.numberOfTracks);
    }
    for (const candidate of candidates.slice(0, 4)) {
      if (await usable(candidate)) {
        shapes[shape] = [candidate];
        break;
      }
    }
    logger.log(
      shapes[shape]
        ? color.blue.bold(`Shape ${color.white.bold(shape)}: payment ${color.white.bold(shapes[shape][0].paymentDbId)}, ${color.white.bold(shapes[shape][0].numberOfTracks)} cards`)
        : color.yellow.bold(`Shape ${color.white.bold(shape)}: no usable order found, its case is left out`)
    );
  }

  // Two playlists with boxes: production merges their inserts into one file
  // (box_merged_<paymentId>_<ms>.pdf); the name is only in the stored request.
  let mergedInsert: Fixtures['mergedInsert'] = null;
  const merged = query(
    `SELECT p.id, SUBSTRING(p.printApiOrderResponse, LOCATE('box_merged_', p.printApiOrderResponse), 120) AS tail
       FROM payments p
      WHERE p.createdAt > NOW() - INTERVAL ${WINDOW_DAYS} DAY AND p.status = 'paid'
        AND p.printApiOrderResponse LIKE '%box_merged_%'
      ORDER BY p.id DESC LIMIT 5`
  );
  for (const row of merged) {
    const name = (row['tail'] || '').match(/box_merged_[A-Za-z0-9_]+\.pdf/)?.[0];
    if (!name) continue;
    const paymentLines = query(
      `SELECT ${LINE_COLUMNS} ${LINE_FROM} AND p.id = ${Number(row['id'])} ORDER BY php.id`
    ).map(toLine);
    const url = insertUrl(fileBase, name);
    let ok = paymentLines.length >= 2 && !!(await ensure(url, 'insert')).pages;
    for (const line of paymentLines) {
      if (!ok) break;
      for (const file of line.cardFiles) {
        ok = ok && !!(await ensure(cardsUrl(fileBase, file), 'cards')).pages;
      }
    }
    if (ok) {
      mergedInsert = { paymentDbId: Number(row['id']), url, lines: paymentLines };
      logger.log(color.blue.bold(`Shape ${color.white.bold('twoDecksBox')}: payment ${color.white.bold(row['id'])}, ${color.white.bold(paymentLines.length)} playlists`));
      break;
    }
  }

  // Every stored V2 exchange that got a 5xx (the latest response per payment
  // is all production keeps; a later re-send overwrites it)
  const replayRows = query(
    `SELECT p.id, DATE_FORMAT(p.createdAt, '%Y-%m-%d %H:%i') AS created, p.printApiOrderResponse
       FROM payments p
      WHERE p.createdAt > NOW() - INTERVAL 365 DAY
        AND p.printApiOrderResponse LIKE '%/api/rest/orders%'
        AND p.printApiOrderResponse LIKE '%"statusCode":5%'
      ORDER BY p.id DESC LIMIT 25`
  );
  const replays = replayRows.flatMap(replayFrom);
  for (const replay of replays) {
    for (const article of replay.request.articles ?? []) {
      if (article.file_url) {
        await ensure(article.file_url, article.product === 'werkblad' ? 'insert' : 'cards');
      }
    }
  }
  logger.log(color.blue.bold(`Stored live 5xx answers to replay: ${color.white.bold(replays.length)}`));

  const fixtures: Fixtures = {
    generatedAt: new Date().toISOString(),
    fileBase,
    shapes,
    mergedInsert,
    replays,
    files,
  };
  fs.writeFileSync(FIXTURES_FILE, `${JSON.stringify(fixtures, null, 2)}\n`);
  logger.log(color.green.bold(`Fixtures written to ${color.white.bold(path.relative(API_ROOT, FIXTURES_FILE))}`));
  return fixtures;
}

export function loadFixtures(): Fixtures {
  if (!fs.existsSync(FIXTURES_FILE)) {
    throw new Error(
      `No fixtures yet: run \`npm run pnb-harness -- fixtures\` first (writes ${path.relative(API_ROOT, FIXTURES_FILE)})`
    );
  }
  return JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8')) as Fixtures;
}
