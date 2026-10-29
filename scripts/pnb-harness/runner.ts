import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { color } from 'console-log-colors';
import Log from '../../src/logger';
import {
  PbCustomerInfo,
  QUOTE_POSTCODES,
  buildOrderRequest,
} from '../../src/printers/printenbindV2Request';
import { orderFrom, pbCall } from './client';
import {
  API_ROOT,
  REFERENCE_PREFIX,
  REPORTS_DIR,
  TEST_ORDER_COMMENT,
  addresses,
  host,
} from './config';
import { buildCases } from './cases';
import { loadFixtures } from './fixtures';
import { LedgerEvent, record } from './ledger';
import { checkHost, publicIp } from './preflight';
import { renderReport } from './report';
import type {
  Attempt,
  EnvName,
  Exchange,
  HarnessCase,
  Host,
  RunOptions,
  RunResult,
} from './types';

const logger = new Log();
const CANCELLED = 'Geannuleerd';
/** How long after a failed POST /orders the harness looks for the order anyway. */
const ORPHAN_SEARCH_DELAY_MS = 5000;
const DELETE_TRIES = 3;
const DELETE_RETRY_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function runIdNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: API_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function statusColor(exchange: Exchange): (text: string) => string {
  if (exchange.status === null || exchange.status >= 500) return color.red.bold;
  if (exchange.status >= 400) return color.yellow.bold;
  return color.green.bold;
}

interface State {
  runId: string;
  runDir: string;
  hosts: Record<EnvName, Host>;
  reachable: Set<EnvName>;
  liveConfirmed: boolean;
  liveBlocked: string | null;
  liveOrders: number;
  stopping: boolean;
  fileCounter: Map<string, number>;
}

/**
 * Write one exchange to requests/ (the full answer, and the request body on
 * its own for the curl line) and return it without the full body.
 */
function save(state: State, attempt: Attempt, exchange: Exchange & { fullBody?: unknown }): Exchange {
  const { fullBody, ...kept } = exchange;
  const base = `${attempt.caseId}-${attempt.env}-${attempt.n}-${exchange.step}`;
  const count = (state.fileCounter.get(base) ?? 0) + 1;
  state.fileCounter.set(base, count);
  const name = count > 1 ? `${base}-${count}` : base;
  const dir = path.join(state.runDir, 'requests');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    `${JSON.stringify({ ...kept, body: fullBody ?? kept.body }, null, 2)}\n`
  );
  if (exchange.requestBody !== undefined) {
    fs.writeFileSync(path.join(dir, `${name}.body.json`), `${JSON.stringify(exchange.requestBody, null, 2)}\n`);
  }
  const at = new Date(exchange.at).toISOString().slice(11, 19);
  logger.log(
    color.blue.bold(`[${attempt.env}] `) +
      color.white.bold(`${attempt.caseId} #${attempt.n} `) +
      color.blue.bold(`${exchange.step.padEnd(9)} `) +
      statusColor(exchange)(exchange.status === null ? exchange.networkError || 'no answer' : `${exchange.status}`) +
      color.gray(` ${exchange.ms} ms, ${at} UTC`)
  );
  return { ...kept, file: `requests/${name}.json` };
}

function ledger(
  state: State,
  attempt: Attempt,
  event: LedgerEvent,
  extra: { orderId?: string; status?: string | null } = {}
): void {
  record({
    runId: state.runId,
    env: attempt.env,
    baseUrl: state.hosts[attempt.env].baseUrl,
    caseId: attempt.caseId,
    reference: attempt.reference,
    event,
    ...extra,
  });
}

/** An order found by reference is only touched when it is the harness's own. */
const isHarnessOrder = (order: any): boolean =>
  !!order?.id && String(order.reference ?? '').startsWith(REFERENCE_PREFIX);

/** The address a case ships to on a host: ours when configured, otherwise a placeholder. */
export function customerFor(c: HarnessCase, configured: Record<string, PbCustomerInfo>): PbCustomerInfo {
  const own = configured[c.country];
  const base: PbCustomerInfo = own ?? {
    email: 'orders@qrsong.io',
    zipcode: QUOTE_POSTCODES[c.country],
    countrycode: c.country,
  };
  return { ...base, ...(c.customerOverrides ?? {}), countrycode: c.country };
}

/** Delete a placed order (with retries) and read it back. */
async function cancel(state: State, attempt: Attempt, target: Host, orderId: string): Promise<void> {
  let deleted = false;
  for (let i = 0; i < DELETE_TRIES && !deleted; i++) {
    if (i > 0) await sleep(DELETE_RETRY_MS);
    const result = save(state, attempt, await pbCall(target, 'delete', 'DELETE', `/orders/${orderId}`));
    attempt.deletes.push(result);
    deleted = result.status !== null && result.status < 300;
  }
  ledger(state, attempt, deleted ? 'deleted' : 'delete-failed', { orderId });

  const verify = await pbCall(target, 'verify', 'GET', `/orders/${orderId}`);
  attempt.verify = save(state, attempt, verify);
  const order = verify.status === 200 ? orderFrom(verify) : null;
  attempt.orderStatus = order?.status ?? (verify.status === 404 ? 'gone (404)' : null);
  attempt.cancelled = verify.status === 404 || order?.status === CANCELLED;
  const waiting = (order?.articles ?? []).filter((a: any) => a?.waiting_for_file).length;
  if (waiting > 0) attempt.notes.push(`${waiting} article(s) still waiting_for_file when read back`);
  ledger(state, attempt, attempt.cancelled ? 'verified' : 'not-cancelled', {
    orderId,
    status: attempt.orderStatus,
  });

  if (!attempt.cancelled) {
    logger.log(
      color.red.bold(
        `ORDER ${color.white.bold(orderId)} ON ${attempt.env.toUpperCase()} IS NOT CANCELLED (status ${color.white.bold(
          String(attempt.orderStatus)
        )}). Delete it in Print&Bind's portal or call them.`
      )
    );
    if (attempt.env === 'live') {
      state.liveBlocked = `order ${orderId} was not cancelled`;
    }
  }
}

function placeBlock(state: State, c: HarnessCase, env: EnvName, options: RunOptions): string | null {
  if (env !== 'live') return null;
  if (!state.liveConfirmed) return 'placing on live was not confirmed';
  if (state.liveBlocked) return `live placing stopped: ${state.liveBlocked}`;
  if (state.liveOrders >= options.maxLiveOrders) return `--max-live-orders ${options.maxLiveOrders} reached`;
  if (!c.livePlaceable) return `no address configured for ${c.country}: calculated only`;
  return null;
}

async function runAttempt(
  state: State,
  c: HarnessCase,
  env: EnvName,
  n: number,
  options: RunOptions,
  configured: Record<string, PbCustomerInfo>
): Promise<Attempt> {
  const attempt: Attempt = { caseId: c.id, env, n, reference: null, deletes: [], cancelled: null, notes: [] };
  if (!state.reachable.has(env)) {
    attempt.skipped = 'host not reachable (see the header)';
    return attempt;
  }
  const target = state.hosts[env];
  const request = buildOrderRequest(customerFor(c, configured), c.articles, {
    fast: c.fast,
    orderComment: [TEST_ORDER_COMMENT, c.orderComment].filter(Boolean).join(' | '),
    reference: `${REFERENCE_PREFIX}${state.runId}-${c.id}-${n}`,
  });
  attempt.reference = request['reference'];

  if (options.mode !== 'place') {
    attempt.calculate = save(
      state,
      attempt,
      await pbCall(target, 'calculate', 'POST', '/orders/calculate', request, options.timeoutMs)
    );
  }
  if (options.mode === 'calculate') return attempt;

  const blocked = placeBlock(state, c, env, options);
  if (blocked) {
    attempt.skipped = blocked;
    return attempt;
  }

  ledger(state, attempt, 'placing');
  if (env === 'live') state.liveOrders++;
  const placed = await pbCall(target, 'place', 'POST', '/orders', request, options.timeoutMs);
  attempt.place = save(state, attempt, placed);
  const order = placed.status !== null && placed.status < 300 ? orderFrom(placed) : null;

  if (order?.id !== undefined && order?.id !== null) {
    attempt.orderId = String(order.id);
    ledger(state, attempt, 'placed', { orderId: attempt.orderId, status: order.status });
    // Deleting is the first thing that happens to a placed order
    await cancel(state, attempt, target, attempt.orderId);
    return attempt;
  }

  // No order id: a 5xx, a timeout or a reset. Print&Bind may have created
  // the order anyway, so look it up by our reference before moving on.
  await sleep(ORPHAN_SEARCH_DELAY_MS);
  const search = await pbCall(target, 'search', 'POST', '/orders/search', { reference: attempt.reference });
  attempt.search = save(state, attempt, search);
  const found = search.status === 200 ? orderFrom(search) : null;
  if (isHarnessOrder(found)) {
    attempt.orderId = String(found.id);
    attempt.orphan = { orderId: attempt.orderId, status: found.status ?? null };
    ledger(state, attempt, 'orphan', { orderId: attempt.orderId, status: found.status });
    logger.log(
      color.yellow.bold(
        `[${env}] ${c.id}: POST /orders answered ${placed.status ?? placed.networkError} but order ${color.white.bold(
          attempt.orderId
        )} exists (status ${color.white.bold(String(found.status))}); deleting it`
      )
    );
    await cancel(state, attempt, target, attempt.orderId);
  }
  return attempt;
}

/**
 * Look up every reference this run tried to place once more and delete
 * whatever is still open: an order that appeared after its 5xx, or one whose
 * delete did not stick.
 */
async function finalSweep(state: State, attempts: Attempt[]): Promise<void> {
  for (const attempt of attempts) {
    if (!attempt.place || attempt.cancelled === true || !attempt.reference) continue;
    const target = state.hosts[attempt.env];
    const search = await pbCall(target, 'search', 'POST', '/orders/search', { reference: attempt.reference });
    const found = search.status === 200 ? orderFrom(search) : null;
    if (!isHarnessOrder(found)) continue;
    attempt.search = save(state, attempt, search);
    if (found.status === CANCELLED) {
      attempt.cancelled = true;
      attempt.orderStatus = CANCELLED;
      continue;
    }
    if (!attempt.orderId) {
      attempt.orderId = String(found.id);
      attempt.orphan = { orderId: attempt.orderId, status: found.status ?? null };
      attempt.notes.push('order only showed up in the final sweep');
      ledger(state, attempt, 'orphan', { orderId: attempt.orderId, status: found.status });
    }
    await cancel(state, attempt, target, String(found.id));
  }
}

export async function run(options: RunOptions, liveConfirmed: boolean): Promise<RunResult> {
  const runId = runIdNow();
  const runDir = path.join(REPORTS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const configured = addresses();
  const fixtures = loadFixtures();
  let cases = buildCases(fixtures, new Set(Object.keys(configured)));
  if (options.cases !== 'all') {
    const wanted = options.cases;
    const unknown = wanted.filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length) {
      throw new Error(`Unknown case(s): ${unknown.join(', ')}. Known: ${cases.map((c) => c.id).join(', ')}`);
    }
    cases = cases.filter((c) => wanted.includes(c.id));
  }

  const ip = await publicIp();
  const hosts = { sandbox: host('sandbox'), live: host('live') };
  const hostReports = await Promise.all(options.envs.map((env) => checkHost(hosts[env], ip)));
  for (const report of hostReports) {
    logger.log(
      report.reachable
        ? color.green.bold(`[${report.env}] ${color.white.bold(report.baseUrl)} key ${color.white.bold(report.fingerprint)}, account ${color.white.bold(String(report.accountId))} (${report.accountName})`)
        : color.red.bold(`[${report.env}] ${color.white.bold(report.baseUrl)} not usable: ${report.problem}`)
    );
  }

  const state: State = {
    runId,
    runDir,
    hosts,
    reachable: new Set(hostReports.filter((h) => h.reachable).map((h) => h.env)),
    liveConfirmed,
    liveBlocked: null,
    liveOrders: 0,
    stopping: false,
    fileCounter: new Map(),
  };

  const result: RunResult = {
    runId,
    startedAt: new Date().toISOString(),
    gitSha: gitSha(),
    machine: os.hostname(),
    publicIp: ip,
    options,
    hosts: hostReports,
    cases,
    attempts: [],
    uncancelled: [],
  };

  // Ctrl-C: finish what is running, sweep, write the report. Twice: quit now.
  let interrupts = 0;
  const onInterrupt = () => {
    interrupts++;
    if (interrupts > 1) process.exit(130);
    state.stopping = true;
    logger.log(color.yellow.bold('Stopping after the running attempts; then cleaning up and writing the report (Ctrl-C again to quit at once)'));
  };
  process.on('SIGINT', onInterrupt);

  const queue: { c: HarnessCase; env: EnvName; n: number }[] = [];
  for (let n = 1; n <= options.repeat; n++) {
    for (const c of cases) {
      for (const env of options.envs) queue.push({ c, env, n });
    }
  }

  // The canary: one small order placed and deleted on live before anything
  // else. If it does not end up cancelled, nothing more is placed there.
  const placingLive =
    options.envs.includes('live') && options.mode !== 'calculate' && liveConfirmed && state.reachable.has('live');
  if (placingLive) {
    const canaryCase =
      cases.find((c) => c.id === 'deck-s-nl' && c.livePlaceable) ??
      cases.find((c) => c.livePlaceable && c.group !== 'replay');
    if (canaryCase) {
      const index = queue.findIndex((q) => q.c === canaryCase && q.env === 'live' && q.n === 1);
      const [canary] = queue.splice(index, 1);
      logger.log(color.blue.bold(`Canary on live: ${color.white.bold(canary.c.id)}`));
      const attempt = await runAttempt(state, canary.c, 'live', 1, options, configured);
      attempt.notes.push('canary');
      result.attempts.push(attempt);
      if (attempt.cancelled !== true) {
        state.liveBlocked = state.liveBlocked ?? 'the canary order was not placed and cancelled';
        logger.log(color.red.bold(`Canary did not end cancelled: no further orders are placed on live (${state.liveBlocked})`));
      }
    }
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, options.concurrency) }, async () => {
      while (next < queue.length && !state.stopping) {
        const { c, env, n } = queue[next++];
        result.attempts.push(await runAttempt(state, c, env, n, options, configured));
      }
    })
  );
  if (state.stopping) result.aborted = 'stopped with Ctrl-C';
  else if (state.liveBlocked) result.aborted = `live: ${state.liveBlocked}`;

  await finalSweep(state, result.attempts);
  result.uncancelled = result.attempts
    .filter((a) => a.cancelled === false && a.orderId)
    .map((a) => ({ env: a.env, orderId: a.orderId!, reference: a.reference }));
  result.finishedAt = new Date().toISOString();
  process.off('SIGINT', onInterrupt);

  fs.writeFileSync(path.join(runDir, 'run.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, 'report.html'), renderReport(result));
  return result;
}
