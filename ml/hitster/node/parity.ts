/**
 * Does the Node pipeline answer what the Python one answers? Reads
 * ../data/parity.json (parity_ref.py), runs every picture through
 * hitster.ts and through the API's own src/hitsterDetector.ts, and prints
 * the largest differences, the verdicts that flip at 0.5, and the time per
 * picture.
 *
 *   npx tsx parity.ts
 */
import { readFile } from 'fs/promises';
import path from 'path';
import { CLASSES, HitsterDetector } from './hitster';
import ApiDetector from '../../../src/hitsterDetector';

async function main() {
  const reference = JSON.parse(await readFile(path.join(__dirname, '..', 'data', 'parity.json'), 'utf8'));
  const detector = await HitsterDetector.load(reference.model, 1);
  let worst = 0;
  let flips = 0;
  const diffs: number[] = [];
  const times: number[] = [];
  for (const row of reference.rows) {
    const verdict = await detector.detect(await readFile(row.path));
    times.push(verdict.ms);
    CLASSES.forEach((name, c) => {
      const diff = Math.abs(verdict.scores[name] - row.maxima[c]);
      diffs.push(diff);
      if (diff > worst) worst = diff;
    });
    const python = Math.max(row.maxima[0], row.maxima[1]) >= 0.5;
    const node = Math.max(verdict.scores.word, verdict.scores.rings) >= 0.5;
    if (python !== node) {
      flips++;
      console.log(`flip: ${path.basename(row.path)} python ${row.maxima.map((v: number) => v.toFixed(3))} node ${CLASSES.map((n) => verdict.scores[n].toFixed(3))}`);
    }
  }
  diffs.sort((a, b) => a - b);
  times.sort((a, b) => a - b);
  console.log(`${reference.rows.length} pictures: score difference median ${diffs[diffs.length >> 1].toFixed(4)}, p99 ${diffs[Math.floor(diffs.length * 0.99)].toFixed(4)}, max ${worst.toFixed(4)}; ${flips} verdicts flip at 0.5`);
  console.log(`time per picture (decode + preprocess + model, 1 thread): median ${times[times.length >> 1]} ms, p90 ${times[Math.floor(times.length * 0.9)]} ms`);

  // The API's copy, on the same model file
  process.env['HITSTER_MODEL'] = reference.model;
  const api = ApiDetector.getInstance();
  let apiWorst = 0;
  let apiFlips = 0;
  for (const row of reference.rows) {
    const verdict = await api.detect(await readFile(row.path), 0.5);
    CLASSES.forEach((name, c) => {
      apiWorst = Math.max(apiWorst, Math.abs(verdict.scores[name] - row.maxima[c]));
    });
    const python = Math.max(...row.maxima) >= 0.5;
    if (python !== verdict.marks.length > 0) apiFlips++;
  }
  console.log(`API src/hitsterDetector.ts: max score difference ${apiWorst.toFixed(4)}; ${apiFlips} verdicts flip at 0.5`);
}

main();
