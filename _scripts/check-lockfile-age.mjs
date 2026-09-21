#!/usr/bin/env node
// Supply-chain gate: lists every package in a package-lock.json whose resolved
// version was published less than N days ago (default 7). Exit code 1 when any.
// Uses only Node built-ins and the public registry, so it runs no code from the
// node_modules it is checking.
//
// Usage: node _scripts/check-lockfile-age.mjs [repoDir] [--days 7]

import { readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 7;
const repo = path.resolve(args.find((a, i) => !a.startsWith('--') && (daysIdx < 0 || i !== daysIdx + 1)) ?? '.');
const cutoff = Date.now() - days * 86400000;
const REGISTRY = 'https://registry.npmjs.org/';
const CONCURRENCY = 16;

const lock = JSON.parse(readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));

// name -> Set(version); links, local files and bundled deps are not registry installs
const wanted = new Map();
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  if (!key || entry.link || entry.inBundle || !entry.version) continue;
  if (entry.resolved && !entry.resolved.startsWith(REGISTRY)) continue;
  const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  if (!wanted.has(name)) wanted.set(name, new Set());
  wanted.get(name).add(entry.version);
}

const tooNew = [];
const failed = [];
const queue = [...wanted.keys()];
let done = 0;

async function worker() {
  while (queue.length) {
    const name = queue.shift();
    try {
      const res = await fetch(REGISTRY + name.replace('/', '%2f'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { time = {} } = await res.json();
      for (const version of wanted.get(name)) {
        const published = Date.parse(time[version]);
        if (Number.isNaN(published)) failed.push(`${name}@${version}: no publish time`);
        else if (published > cutoff) tooNew.push({ pkg: `${name}@${version}`, published: time[version], ageDays: ((Date.now() - published) / 86400000).toFixed(1) });
      }
    } catch (e) {
      failed.push(`${name}: ${e.message}`);
    }
    if (++done % 100 === 0) process.stderr.write(`  ${done}/${wanted.size}\n`);
  }
}

console.log(`${repo}: ${wanted.size} packages, cutoff ${new Date(cutoff).toISOString()} (${days} days)`);
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

tooNew.sort((a, b) => b.published.localeCompare(a.published));
if (tooNew.length) {
  console.log(`\n${tooNew.length} version(s) younger than ${days} days:`);
  console.table(tooNew);
} else {
  console.log(`\nAll resolved versions are at least ${days} days old.`);
}
if (failed.length) console.log(`\nCould not check ${failed.length}:\n  ${failed.join('\n  ')}`);
process.exit(tooNew.length || failed.length ? 1 : 0);
