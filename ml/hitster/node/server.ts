/**
 * Small local pages for trying the detector, on the same hitster.ts the API
 * would run, with any model in ../runs/<name>/hitster.onnx:
 *
 *   /        drop pictures, see the verdict, the score per mark, the cells
 *   /browse  step through every downloaded upload with its verdict, and
 *            label it (H / N), into ../data/labels/labels_ui.txt
 *
 *   npx tsx server.ts            # http://localhost:5197
 *
 * /browse lists the scores score.py wrote to ../data/review/<model>/ranking.tsv.
 */
import http from 'http';
import { appendFile, readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import { CLASSES, HitsterDetector, SIZE, STRIDE, preprocess } from './hitster';

const PORT = Number(process.env['PORT'] || 5197);
const ROOT = path.join(__dirname, '..');
const RUNS = path.join(ROOT, 'runs');
const LABELS = path.join(ROOT, 'data', 'labels');
const PAGES: Record<string, string> = {
  '/': path.join(__dirname, 'web', 'index.html'),
  '/browse': path.join(__dirname, 'web', 'browse.html'),
};
const MAX_BYTES = 40 * 1024 * 1024;
const GRID = SIZE / STRIDE;
// The pages serve customer uploads and write labels: only to this machine's
// own browser tabs. A site that points its name at 127.0.0.1 (DNS
// rebinding) arrives with its own Host; a cross-site POST with its Origin.
const OWN_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const OWN_ORIGINS = new Set([...OWN_HOSTS].map((host) => `http://${host}`));
const NAME = /^[a-z0-9]{8,64}$/i;
const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** Upload name (no extension) -> where it is and what it was used for. */
let uploadIndex: Map<string, { path: string; kinds: string[]; fields: string[]; lines: number }> | null = null;

async function uploads() {
  if (!uploadIndex) {
    uploadIndex = new Map();
    const text = await readFile(path.join(ROOT, 'data', 'prod', 'images.jsonl'), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.status !== 200 || !r.path) continue;
      uploadIndex.set(path.parse(r.name).name, { path: path.join(ROOT, r.path), kinds: r.kinds, fields: r.fields, lines: r.lines });
    }
  }
  return uploadIndex;
}

async function names(file: string): Promise<Set<string>> {
  try {
    const text = await readFile(path.join(LABELS, file), 'utf8');
    return new Set(text.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.split(/\s+/)[0]));
  } catch {
    return new Set();
  }
}

/** Rick's page verdicts, the last line per picture winning (same rule as synth.ui_labels). */
async function uiLabels(): Promise<Map<string, string>> {
  const verdicts = new Map<string, string>();
  try {
    const text = await readFile(path.join(LABELS, 'labels_ui.txt'), 'utf8');
    for (const line of text.split('\n')) {
      const [name, verdict] = line.split(/\s+/);
      if (!name || !verdict || line.startsWith('#')) continue;
      if (verdict === 'clear') verdicts.delete(name);
      else verdicts.set(name, verdict);
    }
  } catch {}
  return verdicts;
}

interface BrowseRow {
  name: string;
  group: string;
  kinds: string[];
  fields: string[];
  lines: number;
  scores: number[];
  score: number;
  label: string;
}

/** Every scored upload of a model with its label, best scores first. */
async function browseList(model: string): Promise<BrowseRow[]> {
  const ranking = await readFile(path.join(ROOT, 'data', 'review', model, 'ranking.tsv'), 'utf8');
  const index = await uploads();
  const [rick, reviewedPos, reviewedNeg, unknown, ui] = await Promise.all([
    names('positives_rick.txt'), names('positives.txt'), names('negatives.txt'), names('unknown.txt'), uiLabels(),
  ]);
  const rows: BrowseRow[] = [];
  for (const line of ranking.split('\n').slice(1)) {
    const [, name, group, , ...scores] = line.split('\t');
    if (!name) continue;
    const values = scores.map(Number);
    const verdict = ui.get(name);
    const label = verdict === 'pos' ? 'you: Hitster' : verdict === 'neg' ? 'you: not Hitster'
      : rick.has(name) ? 'your example' : reviewedPos.has(name) ? 'reviewed: Hitster'
      : reviewedNeg.has(name) ? 'reviewed: not Hitster' : unknown.has(name) || group === 'unknown' ? 'unchecked' : '';
    const info = index.get(name);
    rows.push({ name, group, kinds: info?.kinds ?? [], fields: info?.fields ?? [], lines: info?.lines ?? 0, scores: values, score: Math.max(...values), label });
  }
  return rows.sort((a, b) => b.score - a.score);
}

const detectors = new Map<string, Promise<HitsterDetector>>();

interface Model {
  name: string;
  modified: string;
  mb: number;
}

async function models(): Promise<Model[]> {
  const found: Model[] = [];
  for (const name of await readdir(RUNS)) {
    try {
      const file = await stat(path.join(RUNS, name, 'hitster.onnx'));
      found.push({ name, modified: file.mtime.toISOString(), mb: Math.round(file.size / 1e5) / 10 });
    } catch {}
  }
  return found.sort((a, b) => b.modified.localeCompare(a.modified));
}

function detector(name: string): Promise<HitsterDetector> {
  if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error('bad model name');
  if (!detectors.has(name)) {
    const loading = HitsterDetector.load(path.join(RUNS, name, 'hitster.onnx'), 4);
    loading.catch(() => detectors.delete(name));
    detectors.set(name, loading);
  }
  return detectors.get(name)!;
}

function body(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(new Error('picture too large'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function send(response: http.ServerResponse, status: number, data: unknown, type = 'application/json') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(type === 'application/json' ? JSON.stringify(data) : (data as Buffer | string));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://localhost:${PORT}`);
  if (!OWN_HOSTS.has(request.headers.host || '')) {
    return send(response, 403, { error: 'only for localhost' });
  }
  const origin = request.headers.origin;
  if (request.method !== 'GET' && origin && !OWN_ORIGINS.has(origin)) {
    return send(response, 403, { error: 'not from this page' });
  }
  try {
    if (request.method === 'GET' && PAGES[url.pathname]) {
      return send(response, 200, await readFile(PAGES[url.pathname]), 'text/html; charset=utf-8');
    }
    if (request.method === 'GET' && url.pathname === '/models') {
      const all = await models();
      const scored = await Promise.all(all.map((m) => stat(path.join(ROOT, 'data', 'review', m.name, 'ranking.tsv')).then(() => true, () => false)));
      return send(response, 200, all.map((m, i) => ({ ...m, scored: scored[i] })));
    }
    if (request.method === 'GET' && url.pathname === '/uploads') {
      const model = url.searchParams.get('model') || '';
      if (!/^[a-z0-9_-]+$/i.test(model)) return send(response, 400, { error: 'bad model name' });
      try {
        return send(response, 200, await browseList(model));
      } catch {
        return send(response, 404, { error: `no ranking for ${model} yet: run score.py runs/${model}/last.pt` });
      }
    }
    if (request.method === 'GET' && url.pathname.startsWith('/image/')) {
      const name = url.pathname.slice('/image/'.length);
      const info = NAME.test(name) ? (await uploads()).get(name) : undefined;
      if (!info) return send(response, 404, { error: 'unknown picture' });
      response.writeHead(200, { 'Content-Type': TYPES[path.extname(info.path)] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' });
      return response.end(await readFile(info.path));
    }
    if (request.method === 'POST' && url.pathname === '/label') {
      // JSON only: a cross-site form or no-cors fetch cannot send it without
      // a preflight, and this server answers no preflight
      if (!(request.headers['content-type'] || '').startsWith('application/json')) {
        return send(response, 415, { error: 'JSON only' });
      }
      const { name, label } = JSON.parse((await body(request)).toString('utf8') || '{}');
      if (!NAME.test(name) || !['pos', 'neg', 'clear'].includes(label) || !(await uploads()).has(name)) {
        return send(response, 400, { error: 'name and label (pos, neg, clear) needed' });
      }
      await appendFile(path.join(LABELS, 'labels_ui.txt'), `${name} ${label} ${new Date().toISOString()}\n`);
      return send(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/check') {
      const name = url.searchParams.get('model') || (await models())[0]?.name;
      if (!name) return send(response, 404, { error: 'no model in runs/' });
      const picture = await body(request);
      const started = performance.now();
      const letterbox = await preprocess(picture);
      const prepared = performance.now();
      const probs = await (await detector(name)).probabilities(letterbox);
      const finished = performance.now();
      const grid = CLASSES.map((_, c) => Array.from(probs.subarray(c * GRID * GRID, (c + 1) * GRID * GRID), (p) => Math.round(p * 1000) / 1000));
      const scores = Object.fromEntries(CLASSES.map((cls, c) => [cls, Math.max(...grid[c])]));
      return send(response, 200, {
        model: name,
        scores,
        grid,
        gridSize: GRID,
        stride: STRIDE,
        letterbox: { scale: letterbox.scale, offsetX: letterbox.offsetX, offsetY: letterbox.offsetY, width: letterbox.width, height: letterbox.height },
        ms: { preprocess: Math.round(prepared - started), model: Math.round(finished - prepared) },
      });
    }
    send(response, 404, { error: 'not found' });
  } catch (e) {
    send(response, 400, { error: (e as Error).message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Hitster detector test page on http://localhost:${PORT}`));
