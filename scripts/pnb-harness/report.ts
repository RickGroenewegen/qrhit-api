import { statusClass } from './client';
import type { Attempt, EnvName, Exchange, HarnessCase, RunResult } from './types';

const ENVS: EnvName[] = ['sandbox', 'live'];
const STEPS = ['calculate', 'place', 'delete'] as const;

export const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const json = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);

export const amsterdam = (iso: string): string =>
  new Date(iso).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });

export const utc = (iso: string): string => `${iso.slice(0, 19).replace('T', ' ')} UTC`;

export const mb = (bytes: number | null): string => (bytes ? `${(bytes / 1e6).toFixed(1)} MB` : '?');

/** The label a status chip shows: the code, or the network error's first word. */
export function label(exchange: Exchange): string {
  if (exchange.status === null) {
    return (exchange.networkError || 'no answer').startsWith('timeout') ? 'timeout' : 'network';
  }
  return String(exchange.status);
}

export function tone(exchange: Exchange): string {
  const cls = statusClass(exchange);
  return cls === '2xx' ? 'ok' : cls === '4xx' ? 'warn' : 'bad';
}

/** Print&Bind's message and validation errors, on one line. */
export function errorText(exchange: Exchange): string {
  const body: any = exchange.body;
  if (exchange.status === null) return exchange.networkError || 'no answer';
  if (body && typeof body === 'object') {
    const parts: string[] = [];
    if (body.message) parts.push(String(body.message));
    const errors = body.errors;
    if (Array.isArray(errors)) {
      for (const entry of errors) parts.push(Array.isArray(entry) ? entry.join(': ') : String(entry));
    } else if (errors && typeof errors === 'object') {
      for (const [field, messages] of Object.entries(errors)) {
        parts.push(`${field}: ${Array.isArray(messages) ? messages.join('; ') : String(messages)}`);
      }
    }
    return parts.join(' | ');
  }
  return typeof body === 'string' ? body.replace(/\s+/g, ' ').slice(0, 300) : '';
}

function exchangesOf(attempt: Attempt, step: (typeof STEPS)[number]): Exchange[] {
  if (step === 'delete') return attempt.deletes.slice(-1);
  const exchange = attempt[step];
  return exchange ? [exchange] : [];
}

/** "500 ×2 · 200 ×3" chips plus the median time, for one cell of the matrix. */
function cell(attempts: Attempt[], step: (typeof STEPS)[number]): string {
  const exchanges = attempts.flatMap((a) => exchangesOf(a, step));
  if (exchanges.length === 0) {
    if (attempts.length > 0 && attempts.every((a) => a.skipped?.startsWith('host not reachable'))) {
      return '<span class="muted">not reachable</span>';
    }
    const skipped = attempts.find((a) => a.skipped && step !== 'calculate');
    return skipped ? `<span class="muted" title="${esc(skipped.skipped)}">skipped</span>` : '<span class="muted">–</span>';
  }
  const counts = new Map<string, { n: number; tone: string }>();
  for (const exchange of exchanges) {
    const key = label(exchange);
    const entry = counts.get(key) ?? { n: 0, tone: tone(exchange) };
    entry.n++;
    counts.set(key, entry);
  }
  const times = exchanges.map((e) => e.ms).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const chips = [...counts.entries()]
    .map(([key, { n, tone: t }]) => `<span class="chip ${t}">${esc(key)}${n > 1 ? ` ×${n}` : ''}</span>`)
    .join(' ');
  return `${chips} <span class="ms">${median} ms</span>`;
}

export interface Difference {
  caseId: string;
  step: string;
  sides: Record<EnvName, { summary: string; example?: Exchange }>;
}

/** Cases whose answers differ between sandbox and live, step by step. */
export function differences(result: RunResult): Difference[] {
  const found: Difference[] = [];
  for (const c of result.cases) {
    for (const step of STEPS) {
      const sides = {} as Difference['sides'];
      const signatures: Record<string, string> = {};
      for (const env of ENVS) {
        const exchanges = result.attempts
          .filter((a) => a.caseId === c.id && a.env === env)
          .flatMap((a) => exchangesOf(a, step));
        if (exchanges.length === 0) continue;
        const classes = [...new Set(exchanges.map((e) => statusClass(e)))].sort();
        const messages = [...new Set(exchanges.filter((e) => statusClass(e) === '4xx').map(errorText))].sort();
        signatures[env] = `${classes.join(',')}|${messages.join(',')}`;
        const example = exchanges.find((e) => statusClass(e) !== '2xx') ?? exchanges[0];
        sides[env] = {
          summary: [...new Set(exchanges.map(label))].join(', '),
          example,
        };
      }
      if (signatures['sandbox'] && signatures['live'] && signatures['sandbox'] !== signatures['live']) {
        found.push({ caseId: c.id, step, sides });
      }
    }
  }
  return found;
}

export function curl(result: RunResult, exchange: Exchange): string {
  const hostUrl = result.hosts.find((h) => exchange.url.startsWith(h.baseUrl))?.baseUrl ?? '';
  const urlPath = exchange.url.slice(hostUrl.length);
  const bodyFile = exchange.file?.replace(/\.json$/, '.body.json');
  return [
    `curl -sS -X ${exchange.method} "$PNB_URL${urlPath}"`,
    `-H "Authorization: Bearer $PNB_TOKEN" -H "Accept: application/json"`,
    ...(exchange.requestBody !== undefined
      ? [`-H "Content-Type: application/json" --data @${bodyFile}`]
      : []),
  ].join(' \\\n  ');
}

function exchangeBlock(result: RunResult, exchange: Exchange): string {
  const headers = Object.entries(exchange.headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
  return `
  <details class="exchange">
    <summary><span class="chip ${tone(exchange)}">${esc(label(exchange))}</span>
      <b>${esc(exchange.step)}</b> ${esc(exchange.method)} ${esc(exchange.url)}
      <span class="ms">${exchange.ms} ms · ${esc(utc(exchange.at))}</span></summary>
    ${exchange.status !== null && exchange.status >= 300 ? `<p class="err">${esc(errorText(exchange))}</p>` : ''}
    ${exchange.networkError ? `<p class="err">${esc(exchange.networkError)}</p>` : ''}
    <div class="grid2">
      <div><h5>Request ${exchange.file ? `<a href="${esc(exchange.file.replace(/\.json$/, '.body.json'))}">body</a>` : ''}</h5>
        ${exchange.requestBody !== undefined ? `<pre>${esc(json(exchange.requestBody))}</pre>` : '<p class="muted">no body</p>'}
        <h5>curl <button class="copy" data-copy="${esc(curl(result, exchange))}">copy</button></h5>
        <pre>${esc(curl(result, exchange))}</pre></div>
      <div><h5>Response ${exchange.file ? `<a href="${esc(exchange.file)}">full exchange</a>` : ''} · ${exchange.bodyBytes} bytes</h5>
        <pre>${esc(json(exchange.body))}</pre>
        <h5>Response headers</h5><pre>${esc(headers || '(none)')}</pre></div>
    </div>
  </details>`;
}

function attemptBlock(result: RunResult, attempt: Attempt): string {
  const exchanges = [attempt.calculate, attempt.place, ...attempt.deletes, attempt.verify, attempt.search].filter(
    (e): e is Exchange => !!e
  );
  const outcome =
    attempt.cancelled === true
      ? `<span class="chip ok">order ${esc(attempt.orderId)} cancelled</span>`
      : attempt.cancelled === false
        ? `<span class="chip bad">order ${esc(attempt.orderId)} NOT cancelled (${esc(attempt.orderStatus)})</span>`
        : '';
  return `
  <div class="attempt">
    <div class="attempt-head"><b>${esc(attempt.env)}</b> #${attempt.n}
      ${attempt.reference ? `<code>${esc(attempt.reference)}</code>` : ''} ${outcome}
      ${attempt.orphan ? `<span class="chip warn">orphan: created behind a failed POST</span>` : ''}
      ${attempt.skipped ? `<span class="muted">place skipped: ${esc(attempt.skipped)}</span>` : ''}
      ${attempt.notes.map((n) => `<span class="muted">· ${esc(n)}</span>`).join(' ')}</div>
    ${exchanges.map((e) => exchangeBlock(result, e)).join('')}
  </div>`;
}

function caseBlock(result: RunResult, c: HarnessCase): string {
  const attempts = result.attempts.filter((a) => a.caseId === c.id);
  const files = c.files
    .map(
      (f) =>
        `<tr><td>${esc(f.kind)}</td><td><a href="${esc(f.url)}">${esc(f.url.split('/').pop())}</a></td><td>${mb(f.bytes)}</td><td>${f.pages ?? '?'}</td><td>${esc(f.fetch)}</td></tr>`
    )
    .join('');
  const checks = c.pageChecks
    .map((p) => {
      const mismatch = p.pages !== null && p.pages !== p.copies;
      return `<span class="chip ${mismatch ? 'warn' : 'ok'}">article ${p.article}: copies ${p.copies} / PDF ${p.pages ?? '?'} pages</span>`;
    })
    .join(' ');
  return `
  <details class="case" id="case-${esc(c.id)}">
    <summary><b>${esc(c.id)}</b> ${esc(c.title)} <span class="muted">${esc(c.country)}${c.fast ? ' · fast' : ''} · ${c.articles.length} article(s)</span></summary>
    <p class="muted">From ${esc(c.source)}${c.notes.length ? ` · ${c.notes.map(esc).join(' · ')}` : ''}</p>
    <div class="scroll"><table class="files"><tr><th>file</th><th>name</th><th>size</th><th>pages</th><th>download</th></tr>${files}</table></div>
    <p>${checks}</p>
    <p class="muted">Order comment as production sends it: ${esc(c.orderComment || '(none)')}</p>
    <details><summary>Articles (REST payload)</summary><pre>${esc(json(c.articles))}</pre></details>
    ${attempts.map((a) => attemptBlock(result, a)).join('')}
  </details>`;
}

/** Every 5xx, network failure and orphan, for the mail to Print&Bind. */
function forPrintAndBind(result: RunResult): { rows: string; text: string } {
  const items: { exchange: Exchange; attempt: Attempt; why: string }[] = [];
  for (const attempt of result.attempts) {
    for (const exchange of [attempt.calculate, attempt.place, ...attempt.deletes, attempt.verify, attempt.search]) {
      if (exchange && (exchange.status === null || exchange.status >= 500)) {
        items.push({ exchange, attempt, why: exchange.status === null ? 'no answer' : `HTTP ${exchange.status}` });
      }
    }
    if (attempt.orphan && attempt.place) {
      items.push({
        exchange: attempt.place,
        attempt,
        why: `order ${attempt.orphan.orderId} was created although POST /orders answered ${attempt.place.status ?? attempt.place.networkError}`,
      });
    }
  }
  items.sort((a, b) => a.exchange.at.localeCompare(b.exchange.at));
  const rows = items
    .map(
      ({ exchange, attempt, why }) => `<tr>
        <td>${esc(utc(exchange.at))}<br><span class="muted">${esc(amsterdam(exchange.at))}</span></td>
        <td>${esc(attempt.env)}</td><td>${esc(exchange.method)} ${esc(new URL(exchange.url).pathname)}</td>
        <td><code>${esc(attempt.reference ?? '')}</code></td><td>${esc(why)}</td>
        <td>${esc(errorText(exchange))}</td>
        <td>${exchange.file ? `<a href="${esc(exchange.file.replace(/\.json$/, '.body.json'))}">${esc(exchange.file.replace(/\.json$/, '.body.json'))}</a>` : ''}</td></tr>`
    )
    .join('');
  const accounts = result.hosts
    .map((h) => `${h.env}: ${h.baseUrl}${h.accountId ? ` (account ${h.accountId})` : ''}`)
    .join('; ');
  const text = [
    `QRSong! REST API test run ${result.runId} from ${result.publicIp ?? 'unknown IP'}, ${accounts}`,
    ...items.map(
      ({ exchange, attempt, why }) =>
        `${utc(exchange.at)}  ${attempt.env}  ${exchange.method} ${new URL(exchange.url).pathname}  reference ${attempt.reference}  -> ${why} ${errorText(exchange)}`.trim()
    ),
  ].join('\n');
  return { rows, text };
}

export function renderReport(result: RunResult): string {
  const diffs = differences(result);
  const pnb = forPrintAndBind(result);
  const envs = ENVS.filter((env) => result.options.envs.includes(env));
  const orphans = result.attempts.filter((a) => a.orphan);
  const unreachable = result.hosts.filter((h) => !h.reachable).map((h) => h.env);
  const placedTotal = result.attempts.filter((a) => a.orderId).length;

  const hostCards = result.hosts
    .map(
      (h) => `<div class="card ${h.reachable ? '' : 'card-bad'}">
        <h3>${esc(h.env)}</h3>
        <p><code>${esc(h.baseUrl)}</code></p>
        <p>key sha256 <code>${esc(h.fingerprint)}</code></p>
        <p>${h.reachable ? `account <b>${esc(h.accountId)}</b> ${esc(h.accountName ?? '')}` : `<span class="err">${esc(h.problem)}</span>`}</p>
      </div>`
    )
    .join('');

  const matrixHead = envs
    .map((env) => `<th colspan="${STEPS.length}">${esc(env)}</th>`)
    .join('');
  const matrixSub = envs.map(() => STEPS.map((s) => `<th>${s}</th>`).join('')).join('');
  const matrixRows = result.cases
    .map((c) => {
      const cells = envs
        .map((env) => {
          const attempts = result.attempts.filter((a) => a.caseId === c.id && a.env === env);
          return STEPS.map((step) => `<td>${cell(attempts, step)}</td>`).join('');
        })
        .join('');
      const pdf = c.files.reduce((sum, f) => sum + (f.bytes ?? 0), 0);
      const mismatch = c.pageChecks.some((p) => p.pages !== null && p.pages !== p.copies);
      return `<tr><td><a href="#case-${esc(c.id)}"><b>${esc(c.id)}</b></a><br><span class="muted">${esc(c.title)}</span></td>
        <td>${esc(c.country)}</td><td>${c.articles.length}</td><td>${mb(pdf)}${mismatch ? ' <span class="chip warn">pages≠copies</span>' : ''}</td>${cells}</tr>`;
    })
    .join('');

  const diffRows = diffs
    .map(
      (d) => `<tr><td><a href="#case-${esc(d.caseId)}"><b>${esc(d.caseId)}</b></a></td><td>${esc(d.step)}</td>
        ${ENVS.map((env) => {
          const side = d.sides[env];
          return `<td>${side ? `<b>${esc(side.summary)}</b>${side.example && statusClass(side.example) !== '2xx' ? `<br><span class="err">${esc(errorText(side.example))}</span>` : ''}` : '–'}</td>`;
        }).join('')}</tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Print&amp;Bind Harness</title>
<style>
:root {
  --bg: #f7f5f0; --panel: #ffffff; --text: #1d2321; --muted: #69716e; --line: #dcd8cf;
  --ok: #1f7a4d; --ok-bg: #e2f3ea; --warn: #8a5a00; --warn-bg: #fbefd2; --bad: #b42318; --bad-bg: #fde4e1;
  --accent: #0f6b6b; --code: #f0ede6;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #141917; --panel: #1c2220; --text: #e6ebe8; --muted: #9aa5a0; --line: #2f3835;
    --ok: #6fd3a0; --ok-bg: #173527; --warn: #f2c46b; --warn-bg: #3a2e12; --bad: #ff8a7a; --bad-bg: #44201b;
    --accent: #5cc6c6; --code: #232a28;
  }
}
:root[data-theme="dark"] {
  --bg: #141917; --panel: #1c2220; --text: #e6ebe8; --muted: #9aa5a0; --line: #2f3835;
  --ok: #6fd3a0; --ok-bg: #173527; --warn: #f2c46b; --warn-bg: #3a2e12; --bad: #ff8a7a; --bad-bg: #44201b;
  --accent: #5cc6c6; --code: #232a28;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1400px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 32px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
h3 { margin: 0 0 6px; font-size: 15px; text-transform: capitalize; }
h5 { margin: 10px 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
a { color: var(--accent); }
code, pre { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
code { background: var(--code); padding: 1px 4px; border-radius: 4px; word-break: break-all; }
pre { background: var(--code); padding: 10px; border-radius: 6px; overflow: auto; max-height: 420px; margin: 0; white-space: pre-wrap; word-break: break-word; }
.muted { color: var(--muted); }
.err { color: var(--bad); }
.meta { color: var(--muted); margin: 0 0 16px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.card p { margin: 2px 0; }
.card-bad { border-color: var(--bad); }
.banner { border-radius: 8px; padding: 12px 14px; margin: 12px 0; font-weight: 600; }
.banner.bad { background: var(--bad-bg); color: var(--bad); }
.banner.warn { background: var(--warn-bg); color: var(--warn); }
.banner.ok { background: var(--ok-bg); color: var(--ok); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 600; white-space: nowrap; }
.chip { display: inline-block; padding: 0 7px; border-radius: 10px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.chip.ok { background: var(--ok-bg); color: var(--ok); }
.chip.warn { background: var(--warn-bg); color: var(--warn); }
.chip.bad { background: var(--bad-bg); color: var(--bad); }
.ms { color: var(--muted); font-size: 12px; white-space: nowrap; }
details.case { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; margin: 8px 0; }
details.case > summary { cursor: pointer; padding: 4px 0; }
.attempt { border-top: 1px dashed var(--line); margin-top: 10px; padding-top: 8px; }
.attempt-head { margin-bottom: 4px; }
details.exchange { margin: 4px 0 4px 8px; }
details.exchange > summary { cursor: pointer; }
.grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
@media (max-width: 800px) { .grid2 { grid-template-columns: minmax(0, 1fr); } }
button { font: inherit; font-size: 12px; border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 6px; padding: 1px 8px; cursor: pointer; }
.toolbar { display: flex; gap: 8px; margin: 8px 0; }
</style>
</head>
<body>
<main>
  <h1>Print&amp;Bind REST API harness</h1>
  <p class="meta">Run <b>${esc(result.runId)}</b> · ${esc(utc(result.startedAt))} → ${esc(result.finishedAt ? utc(result.finishedAt) : '…')}
    · ${esc(result.machine)} (${esc(result.publicIp ?? 'IP unknown')}) · git ${esc(result.gitSha)}
    · mode ${esc(result.options.mode)} · repeat ${result.options.repeat} · concurrency ${result.options.concurrency}</p>

  ${result.uncancelled.length
    ? `<div class="banner bad">Not cancelled: ${result.uncancelled.map((u) => `${esc(u.env)} order ${esc(u.orderId)} (${esc(u.reference)})`).join(', ')}. Run <code>npm run pnb-harness -- cleanup --env live</code> or delete them in Print&amp;Bind's portal.</div>`
    : placedTotal
      ? `<div class="banner ok">All ${placedTotal} placed order(s) were cancelled.</div>`
      : ''}
  ${orphans.length ? `<div class="banner warn">${orphans.length} order(s) were created although POST /orders failed: see "For Print&amp;Bind".</div>` : ''}
  ${result.aborted ? `<div class="banner warn">Run stopped early: ${esc(result.aborted)}</div>` : ''}

  <div class="cards">${hostCards}</div>

  <h2>Differences between sandbox and live</h2>
  ${diffs.length
    ? `<div class="scroll"><table><tr><th>case</th><th>step</th><th>sandbox</th><th>live</th></tr>${diffRows}</table></div>`
    : `<p class="muted">${
        envs.length < 2
          ? 'Only one host in this run.'
          : unreachable.length
            ? `Nothing to compare: ${unreachable.map(esc).join(' and ')} could not be reached.`
            : 'None: both hosts answered every case alike.'
      }</p>`}

  <h2>All cases</h2>
  <div class="scroll"><table>
    <tr><th rowspan="2">case</th><th rowspan="2">to</th><th rowspan="2">articles</th><th rowspan="2">PDFs</th>${matrixHead}</tr>
    <tr>${matrixSub}</tr>
    ${matrixRows}
  </table></div>

  <h2>For Print&amp;Bind</h2>
  ${pnb.rows
    ? `<p class="muted">Every 5xx, every request without an answer, and every order created behind a failed POST. Times in UTC and Amsterdam; the request files are in this run's folder.</p>
       <div class="scroll"><table><tr><th>time</th><th>host</th><th>call</th><th>reference</th><th>what</th><th>Print&amp;Bind said</th><th>request</th></tr>${pnb.rows}</table></div>
       <h5>As text <button class="copy" data-copy="${esc(pnb.text)}">copy</button></h5><pre>${esc(pnb.text)}</pre>`
    : '<p class="muted">Nothing to report: no 5xx and no failed requests.</p>'}

  <h2>Cases in detail</h2>
  <div class="toolbar"><button id="open-all">Open all</button><button id="close-all">Close all</button></div>
  ${result.cases.map((c) => caseBlock(result, c)).join('')}
</main>
<script>
document.addEventListener('click', function (event) {
  var target = event.target;
  if (target.matches && target.matches('button.copy')) {
    navigator.clipboard.writeText(target.getAttribute('data-copy')).then(function () {
      target.textContent = 'copied';
      setTimeout(function () { target.textContent = 'copy'; }, 1200);
    });
  }
  if (target.id === 'open-all' || target.id === 'close-all') {
    document.querySelectorAll('details.case').forEach(function (d) { d.open = target.id === 'open-all'; });
  }
});
</script>
</body>
</html>
`;
}
