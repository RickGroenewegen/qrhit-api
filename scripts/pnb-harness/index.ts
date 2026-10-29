/**
 * Print&Bind REST API (V2) test harness: real printer PDFs from production
 * orders, sent as production sends them, to the sandbox and to live; every
 * live order is deleted the moment it exists. Writes an HTML report that
 * puts the differences between the two hosts first, and when something went
 * wrong a PDF for Print&Bind (timestamps, requests, responses, headers).
 *
 *   npm run pnb-harness -- fixtures                      # pick real orders + PDFs (prod DB, read-only)
 *   npm run pnb-harness -- cases                         # list the cases, sends nothing
 *   npm run pnb-harness -- run                           # all cases on the sandbox
 *   npm run pnb-harness -- run --env live --cases deck-s-nl   # the canary alone on live
 *   npm run pnb-harness -- run --env sandbox,live --repeat 3
 *   npm run pnb-harness -- run --mode calculate --env live    # /orders/calculate only: creates nothing
 *   npm run pnb-harness -- cleanup --env live            # delete anything the harness left open
 *   npm run pnb-harness -- report reports/pnb-harness/<run>/run.json
 *   npm run pnb-harness -- pdf reports/pnb-harness/<run> [--lang nl|en]   # the report for Print&Bind
 *   npm run pnb-harness -- place --env live [--case deck-s-nl]   # ONE order, NOT deleted (to look at in the portal)
 *   npm run pnb-harness -- status --env live <order id or reference>
 *
 * run options: --env sandbox|live|sandbox,live  --cases all|id,id  --repeat N
 *   --mode calculate|place|both (default both)  --concurrency N (default 1)
 *   --max-live-orders N (default 30)  --timeout <seconds> (default 120)
 *   --yes-live (skip the prompt)  --no-open
 *
 * .env: PNB_HARNESS_SANDBOX_KEY, PNB_HARNESS_LIVE_KEY, PNB_HARNESS_ADDRESS
 * (JSON, the NL address live test orders go to), optional
 * PNB_HARNESS_ADDRESSES ({"DE": {...}}) and PNB_HARNESS_{SANDBOX,LIVE}_URL.
 * Writes nothing to any database and never touches the API version toggle.
 * See "Print&Bind test harness" in CLAUDE.md.
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { createInterface } from 'readline/promises';
import { color } from 'console-log-colors';
import Log from '../../src/logger';
import { orderFrom, pbCall } from './client';
import { REFERENCE_PREFIX, REPORTS_DIR, TEST_ORDER_COMMENT, addresses, host } from './config';
import { buildOrderRequest } from '../../src/printers/printenbindV2Request';
import { buildCases } from './cases';
import { buildFixtures, loadFixtures } from './fixtures';
import { readLedger, record } from './ledger';
import { findings, writeIncidentPdf, type Lang } from './incident';
import { checkHost, publicIp } from './preflight';
import { renderReport } from './report';
import { customerFor, run, runIdNow } from './runner';
import type { EnvName, Host, RunOptions, RunResult } from './types';

const logger = new Log();
const args = process.argv.slice(2);
const command = args[0];

const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};
/** The first argument after the command that is neither an option nor an option's value. */
const positional = (): string => {
  for (let i = 1; i < args.length; i++) {
    if (!args[i].startsWith('--')) return args[i];
    if (args[i + 1] && !args[i + 1].startsWith('--') && !['--yes-live', '--no-open'].includes(args[i])) i++;
  }
  return '';
};

function parseEnvs(raw: string): EnvName[] {
  const envs = raw.split(',').map((e) => e.trim()).filter(Boolean);
  for (const env of envs) {
    if (env !== 'sandbox' && env !== 'live') throw new Error(`Unknown --env ${env}: use sandbox, live or sandbox,live`);
  }
  return envs as EnvName[];
}

function openFile(file: string): void {
  if (flag('no-open') || process.platform !== 'darwin') return;
  execFile('open', [file]);
}

function parseLangs(): Lang[] {
  const value = option('lang', 'nl');
  const langs = value === 'both' ? ['nl', 'en'] : value.split(',');
  for (const lang of langs) {
    if (lang !== 'nl' && lang !== 'en') throw new Error(`Unknown --lang ${lang}: use nl, en or both`);
  }
  return langs as Lang[];
}

/** The PDF for Print&Bind; a missing Chrome costs the PDF, never the run. */
async function writePdfs(result: RunResult, runDir: string, langs: Lang[]): Promise<string[]> {
  const files: string[] = [];
  for (const lang of langs) {
    try {
      files.push(await writeIncidentPdf(result, runDir, lang));
    } catch (error: any) {
      logger.log(color.yellow.bold(`No PDF (${lang}): ${color.white.bold(error?.message || String(error))}`));
    }
  }
  for (const file of files) logger.log(color.green.bold(`PDF for Print&Bind: ${color.white.bold(file)}`));
  return files;
}

async function confirmLive(): Promise<boolean> {
  if (flag('yes-live')) return true;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(
    color.yellow.bold('This places REAL orders on Print&Bind live, each deleted at once. Type LIVE to go on: ')
  );
  prompt.close();
  return answer.trim() === 'LIVE';
}

function summarize(result: RunResult, reportFile: string): void {
  const placed = result.attempts.filter((a) => a.orderId && a.cancelled === true);
  const failed = result.attempts.filter((a) =>
    [a.calculate, a.place].some((e) => e && (e.status === null || e.status >= 500))
  );
  logger.log(
    color.blue.bold(
      `${color.white.bold(result.attempts.length)} attempts, ${color.white.bold(placed.length)} orders placed and deleted, ${color.white.bold(failed.length)} with a 5xx or no answer`
    )
  );
  if (result.uncancelled.length) {
    for (const u of result.uncancelled) {
      logger.log(color.red.bold(`NOT CANCELLED: ${u.env} order ${color.white.bold(u.orderId)} (${u.reference})`));
    }
  }
  logger.log(color.green.bold(`Report: ${color.white.bold(path.relative(process.cwd(), reportFile))}`));
}

/**
 * Delete one order if it is still open and read it back; true when it ends
 * cancelled. Only ever an order whose reference is the harness's own.
 */
async function closeOrder(target: Host, orderId: string): Promise<boolean> {
  const before = await pbCall(target, 'verify', 'GET', `/orders/${orderId}`);
  if (before.status === 404) return true;
  const order = orderFrom(before);
  const status = order?.status;
  if (!String(order?.reference ?? '').startsWith(REFERENCE_PREFIX)) {
    logger.log(color.yellow.bold(`[${target.env}] order ${color.white.bold(orderId)} is not a harness order (reference ${color.white.bold(String(order?.reference))}): left alone`));
    return true;
  }
  if (status === 'Geannuleerd') return true;
  logger.log(color.yellow.bold(`[${target.env}] order ${color.white.bold(orderId)} is ${color.white.bold(String(status))}: deleting`));
  const deleted = await pbCall(target, 'delete', 'DELETE', `/orders/${orderId}`);
  const after = await pbCall(target, 'verify', 'GET', `/orders/${orderId}`);
  const ok = after.status === 404 || orderFrom(after)?.status === 'Geannuleerd';
  logger.log(
    ok
      ? color.green.bold(`[${target.env}] order ${color.white.bold(orderId)} cancelled`)
      : color.red.bold(`[${target.env}] order ${color.white.bold(orderId)} NOT cancelled (DELETE ${deleted.status}, now ${orderFrom(after)?.status})`)
  );
  return ok;
}

async function cleanup(env: EnvName): Promise<number> {
  const target = host(env);
  const check = await checkHost(target, await publicIp());
  if (!check.reachable) {
    logger.log(color.red.bold(`[${env}] not usable: ${check.problem}`));
    return 1;
  }
  const entries = readLedger().filter((e) => e.env === env && (e.baseUrl ?? target.baseUrl) === target.baseUrl);
  const orderIds = new Set(entries.filter((e) => e.orderId).map((e) => e.orderId!));
  const references = new Set(entries.filter((e) => e.reference).map((e) => e.reference!));

  for (const reference of references) {
    const search = await pbCall(target, 'search', 'POST', '/orders/search', { reference });
    const found = search.status === 200 ? orderFrom(search) : null;
    if (found?.id) orderIds.add(String(found.id));
  }
  const list = await pbCall(target, 'list', 'GET', '/orders');
  const listed: any[] = Array.isArray((list.fullBody as any)?.data) ? (list.fullBody as any).data : [];
  for (const order of listed) {
    if (String(order?.reference ?? '').startsWith(REFERENCE_PREFIX)) orderIds.add(String(order.id));
  }

  logger.log(color.blue.bold(`[${env}] checking ${color.white.bold(orderIds.size)} harness order(s) from ${color.white.bold(references.size)} reference(s)`));
  let open = 0;
  for (const orderId of orderIds) {
    if (!(await closeOrder(target, orderId))) open++;
  }
  logger.log(
    open
      ? color.red.bold(`[${env}] ${open} order(s) could not be cancelled: delete them in Print&Bind's portal`)
      : color.green.bold(`[${env}] nothing left open`)
  );
  return open ? 2 : 0;
}

function describeOrder(order: any): string {
  const articles = Array.isArray(order?.articles) ? order.articles : [];
  const waiting = articles.filter((a: any) => a?.waiting_for_file).length;
  return (
    `order ${color.white.bold(order?.id)} ${color.white.bold(order?.status ?? '?')}, ` +
    `reference ${color.white.bold(order?.reference ?? '?')}, amount ${color.white.bold(order?.amount ?? '?')} ` +
    `+ delivery ${color.white.bold(order?.delivery_amount ?? '?')}, ${articles.length} article(s)` +
    (waiting ? `, ${waiting} still waiting for its file` : '')
  );
}

/** One order that is NOT deleted, to look at in Print&Bind's portal. */
async function placeKept(env: EnvName): Promise<number> {
  const caseId = option('case', 'deck-s-nl');
  const configured = addresses();
  const c = buildCases(loadFixtures(), new Set(Object.keys(configured))).find((x) => x.id === caseId);
  if (!c) throw new Error(`Unknown case ${caseId}: see npm run pnb-harness -- cases`);
  if (env === 'live' && !c.livePlaceable) throw new Error(`No address for ${c.country}: ${caseId} cannot go to live`);
  const target = host(env);
  const check = await checkHost(target, await publicIp());
  if (!check.reachable) throw new Error(`[${env}] not reachable: ${check.problem}`);
  logger.log(
    color.blue.bold(`[${env}] account ${color.white.bold(check.accountId)} ${color.white.bold(check.accountName ?? '')}, key ${color.white.bold(check.fingerprint)}`)
  );
  if (env === 'live') {
    logger.log(color.red.bold('This order is NOT deleted. Cancel it in the portal (or run cleanup) before Print&Bind produces it.'));
    if (!(await confirmLive())) {
      logger.log(color.yellow.bold('Not confirmed: nothing was sent.'));
      return 1;
    }
  }
  const runId = `${runIdNow()}-kept`;
  const request = buildOrderRequest(customerFor(c, configured), c.articles, {
    fast: c.fast,
    orderComment: [TEST_ORDER_COMMENT, c.orderComment].filter(Boolean).join(' | '),
    reference: `${REFERENCE_PREFIX}${runId}-${c.id}`,
  });
  const reference: string = request['reference'];
  const entry = { runId, env, baseUrl: target.baseUrl, caseId: c.id, reference };
  record({ ...entry, event: 'placing', detail: 'kept: not deleted by the harness' });
  const placed = await pbCall(target, 'place', 'POST', '/orders', request, 120000);

  const dir = path.join(REPORTS_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'request.json'), `${JSON.stringify(request, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'response.json'), `${JSON.stringify({ ...placed, body: placed.fullBody ?? placed.body, fullBody: undefined }, null, 2)}\n`);

  const order = placed.status !== null && placed.status < 300 ? orderFrom(placed) : null;
  const answer = placed.status === null ? placed.networkError : `HTTP ${placed.status}`;
  logger.log(color.blue.bold(`[${env}] POST /orders: ${color.white.bold(answer)} in ${color.white.bold(placed.ms)} ms (${placed.at} UTC)`));
  if (order?.id) {
    record({ ...entry, event: 'placed', orderId: String(order.id), status: order.status, detail: 'kept' });
    logger.log(color.green.bold(`[${env}] placed ${describeOrder(order)}`));
  } else {
    logger.log(color.yellow.bold(`[${env}] no order in the answer; looking it up by reference in 5 s`));
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const search = await pbCall(target, 'search', 'POST', '/orders/search', { reference });
    const found = search.status === 200 ? orderFrom(search) : null;
    if (found?.id) {
      record({ ...entry, event: 'orphan', orderId: String(found.id), status: found.status, detail: `kept; POST answered ${answer}` });
      logger.log(color.red.bold(`[${env}] it exists anyway: ${describeOrder(found)}`));
    } else {
      logger.log(color.yellow.bold(`[${env}] no order with reference ${reference}: nothing was created`));
    }
  }
  logger.log(color.gray(`Request and response: ${dir}`));
  return 0;
}

/** Read one order back, by id or by our reference. */
async function orderStatus(env: EnvName): Promise<number> {
  const key = positional();
  if (!key) throw new Error('usage: npm run pnb-harness -- status --env live <order id or reference>');
  const target = host(env);
  const exchange = /^\d+$/.test(key)
    ? await pbCall(target, 'verify', 'GET', `/orders/${key}`)
    : await pbCall(target, 'search', 'POST', '/orders/search', { reference: key });
  const order = exchange.status === 200 ? orderFrom(exchange) : null;
  if (!order) {
    const answer = exchange.status === null ? exchange.networkError : `HTTP ${exchange.status}`;
    logger.log(color.yellow.bold(`[${env}] ${key}: ${color.white.bold(answer)} ${JSON.stringify(exchange.body).slice(0, 200)}`));
    return exchange.status === 404 ? 0 : 1;
  }
  const cancelled = order.status === 'Geannuleerd';
  logger.log((cancelled ? color.green.bold : color.yellow.bold)(`[${env}] ${describeOrder(order)}`));
  return 0;
}

async function main(): Promise<number> {
  switch (command) {
    case 'fixtures': {
      await buildFixtures(option('file-base', '') || undefined);
      return 0;
    }
    case 'cases': {
      const configured = addresses();
      for (const c of buildCases(loadFixtures(), new Set(Object.keys(configured)))) {
        const mismatch = c.pageChecks.filter((p) => p.pages !== null && p.pages !== p.copies);
        const mb = c.files.reduce((sum, f) => sum + (f.bytes ?? 0), 0) / 1e6;
        console.log(
          `${color.white.bold(c.id.padEnd(18))} ${c.country} ${String(c.articles.length).padStart(2)} article(s) ${mb.toFixed(1).padStart(5)} MB  ` +
            `${c.livePlaceable ? color.green('live: place') : color.yellow('live: calculate only')}  ` +
            `${mismatch.length ? color.red(`copies≠pages on article ${mismatch.map((p) => p.article).join(',')}`) : color.gray('copies = pages')}  ` +
            color.gray(c.title)
        );
      }
      return 0;
    }
    case 'run': {
      const options: RunOptions = {
        envs: parseEnvs(option('env', 'sandbox')),
        cases: option('cases', 'all') === 'all' ? 'all' : option('cases', 'all').split(','),
        repeat: Math.max(1, parseInt(option('repeat', '1'), 10) || 1),
        mode: option('mode', 'both') as RunOptions['mode'],
        concurrency: Math.max(1, parseInt(option('concurrency', '1'), 10) || 1),
        maxLiveOrders: Math.max(1, parseInt(option('max-live-orders', '30'), 10) || 30),
        timeoutMs: Math.max(5, parseInt(option('timeout', '120'), 10) || 120) * 1000,
      };
      if (!['calculate', 'place', 'both'].includes(options.mode)) {
        throw new Error(`Unknown --mode ${options.mode}: use calculate, place or both`);
      }
      let liveConfirmed = false;
      if (options.envs.includes('live') && options.mode !== 'calculate') {
        liveConfirmed = await confirmLive();
        if (!liveConfirmed) {
          logger.log(color.yellow.bold('Not confirmed: nothing was sent. Use --mode calculate for a live run that creates nothing.'));
          return 1;
        }
      }
      const result = await run(options, liveConfirmed);
      const runDir = path.join(REPORTS_DIR, result.runId);
      const reportFile = path.join(runDir, 'report.html');
      summarize(result, reportFile);
      const found = findings(result);
      if (found.length) {
        logger.log(color.yellow.bold(`${color.white.bold(found.length)} finding(s) for Print&Bind: writing the PDF`));
        await writePdfs(result, runDir, parseLangs());
      }
      openFile(reportFile);
      return result.uncancelled.length ? 2 : 0;
    }
    case 'cleanup': {
      const envs = parseEnvs(option('env', 'live'));
      let code = 0;
      for (const env of envs) code = Math.max(code, await cleanup(env));
      return code;
    }
    case 'report': {
      const file = positional();
      if (!file || !fs.existsSync(file)) throw new Error('usage: npm run pnb-harness -- report <path to run.json>');
      const result = JSON.parse(fs.readFileSync(file, 'utf8')) as RunResult;
      const reportFile = path.join(path.dirname(file), 'report.html');
      fs.writeFileSync(reportFile, renderReport(result));
      logger.log(color.green.bold(`Report: ${color.white.bold(reportFile)}`));
      openFile(reportFile);
      return 0;
    }
    case 'place': {
      const [env, ...more] = parseEnvs(option('env', 'sandbox'));
      if (more.length) throw new Error('place sends to one host: --env sandbox or --env live');
      return placeKept(env);
    }
    case 'status': {
      const [env] = parseEnvs(option('env', 'live'));
      return orderStatus(env);
    }
    case 'pdf': {
      const target = positional();
      const file = target && fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, 'run.json') : target;
      if (!file || !fs.existsSync(file)) {
        throw new Error('usage: npm run pnb-harness -- pdf <run folder or run.json> [--lang nl|en|both]');
      }
      const result = JSON.parse(fs.readFileSync(file, 'utf8')) as RunResult;
      const files = await writePdfs(result, path.dirname(file), parseLangs());
      if (!findings(result).length) logger.log(color.gray('This run has no findings: the PDF says so, with the timings and the timeline.'));
      files.forEach(openFile);
      return files.length ? 0 : 1;
    }
    default:
      console.log(
        'usage: npm run pnb-harness -- fixtures | cases | run [--env sandbox,live] [--cases ...] [--repeat N] [--mode calculate|place|both] [--lang nl|en|both] | cleanup --env live | report <run.json> | pdf <run folder> [--lang nl|en|both]'
      );
      return command ? 1 : 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    logger.log(color.red.bold(String(error?.stack || error)));
    process.exit(1);
  });
