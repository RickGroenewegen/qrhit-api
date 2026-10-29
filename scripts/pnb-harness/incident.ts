import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { statusClass } from './client';
import { curl, differences, errorText, esc, json, label, mb, tone } from './report';
import type { Attempt, EnvName, Exchange, HarnessCase, RunResult } from './types';

/** Same Chrome as the brochure and card template renders (scripts/card-templates/harness.ts). */
const CHROME =
  process.env['CHROME_PATH'] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Findings beyond this many are listed in a table instead of in full. */
const MAX_DETAILED = 20;

export type Lang = 'nl' | 'en';

type FindingKind = 'server-error' | 'no-answer' | 'orphan' | 'not-cancelled' | 'difference';

interface Finding {
  kind: FindingKind;
  attempt: Attempt;
  exchange: Exchange;
  /** the other host's answer to the same request */
  counterpart?: Exchange;
  /** what followed: the search, deletes and read-back */
  followUp: Exchange[];
}

const TEXT = {
  nl: {
    title: 'Print&Bind REST API: testrapport',
    subtitle: (run: string) => `Testrun ${run}, opgesteld door QRSong!`,
    summary: 'Samenvatting',
    method: 'Werkwijze',
    methodText: (ref: string) =>
      `We sturen orders zoals onze productie ze bouwt (dezelfde code), met de echte printer-PDF's van recente klantorders. ` +
      `Print&Bind haalt die bestanden zelf op via de URL in het artikel (add_file_method "url", api.qrsong.io/public/...). ` +
      `Per geval eerst POST /orders/calculate, daarna POST /orders. Elke order die zo ontstaat verwijderen we meteen met DELETE /orders/{id} ` +
      `en lezen we terug met GET. Na een 5xx of time-out zoeken we de order op via POST /orders/search met onze referentie, ` +
      `omdat hij soms toch bestaat. Al onze testorders hebben een referentie die begint met "${ref}" en het opmerkingveld ` +
      `"TESTORDER QRSong API-test, NIET PRODUCEREN, wordt direct geannuleerd". Het afleveradres is ons eigen adres.`,
    host: 'Omgeving',
    account: 'Account',
    key: 'Sleutel (sha256, eerste 12 tekens)',
    ip: 'Ons IP-adres',
    reachable: 'Bereikbaar',
    yes: 'ja',
    no: 'nee',
    requests: 'Verzoeken (calculate + place)',
    placed: 'Orders aangemaakt / geannuleerd',
    observations: 'Wat opviel',
    timing: 'Verwerkingstijd per geval',
    timingNote: 'Mediaan in milliseconden. Print&Bind haalt de PDF op terwijl het verzoek openstaat.',
    case: 'Geval',
    pdfs: "PDF's",
    pages: "pagina's",
    findings: 'Bevindingen',
    noFindings: 'Geen fouten in deze run: geen 5xx, geen verzoeken zonder antwoord, geen verschillen tussen sandbox en live.',
    moreFindings: (n: number) => `Nog ${n} bevinding(en), zonder details (de volledige gegevens staan in de bijbehorende bestanden):`,
    timeline: 'Tijdlijn van alle verzoeken',
    timelineNote: 'Om met jullie logs te vergelijken. Tijden in UTC, tot op de milliseconde.',
    time: 'Tijd',
    amsterdamTime: 'Tijd (Amsterdam)',
    duration: 'Duur',
    call: 'Verzoek',
    reference: 'Onze referentie',
    order: 'Order',
    status: 'Status',
    step: 'Stap',
    request: 'Verzoek (JSON)',
    response: 'Antwoord',
    headers: 'Antwoordheaders',
    files: 'Bestanden in dit verzoek',
    counterpart: (env: string) => `Antwoord van ${env} op hetzelfde verzoek`,
    followUp: 'Wat daarna gebeurde',
    reproduce: 'Opnieuw versturen (curl)',
    caseLabel: 'Geval',
    kind: {
      'server-error': (e: Exchange, env: string) => `HTTP ${e.status} op ${e.method} ${pathOf(e)} (${env})`,
      'no-answer': (e: Exchange, env: string) => `Geen antwoord op ${e.method} ${pathOf(e)} (${env}): ${e.networkError}`,
      orphan: (e: Exchange, env: string, a: Attempt) =>
        `Order ${a.orphan?.orderId} bestaat toch, terwijl POST /orders ${e.status === null ? `geen antwoord gaf (${e.networkError})` : `${e.status} gaf`} (${env})`,
      'not-cancelled': (e: Exchange, env: string, a: Attempt) =>
        `Order ${a.orderId} liet zich niet annuleren: DELETE gaf ${e.status ?? `geen antwoord (${e.networkError})`} (${env})`,
      difference: (e: Exchange, env: string, a: Attempt, other?: Exchange) =>
        `${a.caseId}: ${env} gaf ${label(e)}, de andere omgeving ${other ? label(other) : '?'} op ${e.method} ${pathOf(e)}`,
    } as Record<FindingKind, (e: Exchange, env: string, a: Attempt, other?: Exchange) => string>,
    obsFailed: (env: string, bad: number, total: number) =>
      `${env}: ${bad} van ${total} orderverzoeken (POST /orders) eindigden in een 5xx of zonder antwoord.`,
    obsCalcFailed: (env: string, bad: number, total: number) =>
      `${env}: ${bad} van ${total} berekeningen (POST /orders/calculate) eindigden in een 5xx of zonder antwoord.`,
    obsOrphans: (ids: string[]) =>
      `${ids.length} order(s) bestonden toch na een 5xx of time-out: ${ids.join(', ')}. Wij hebben ze meteen verwijderd.`,
    obsUncancelled: (ids: string[]) => `Niet te annuleren: order ${ids.join(', ')}. Willen jullie die verwijderen?`,
    obsSize: (env: string, small: string, large: string) =>
      `Verwerkingstijd groeit met de PDF (calculate, ${env}): ${small} tegenover ${large}.`,
    obsAllCancelled: (n: number) => `Alle ${n} aangemaakte testorders zijn geannuleerd.`,
    obsNoSandbox: 'De sandbox was niet bereikbaar vanaf ons IP-adres (nginx 403 vóór de API).',
  },
  en: {
    title: 'Print&Bind REST API: test report',
    subtitle: (run: string) => `Test run ${run}, prepared by QRSong!`,
    summary: 'Summary',
    method: 'How we tested',
    methodText: (ref: string) =>
      `We send orders the way our production builds them (the same code), with the real printer PDFs of recent customer orders. ` +
      `Print&Bind fetches those files itself from the URL in the article (add_file_method "url", api.qrsong.io/public/...). ` +
      `Per case first POST /orders/calculate, then POST /orders. Every order created that way is deleted at once with DELETE /orders/{id} ` +
      `and read back with GET. After a 5xx or a timeout we look the order up with POST /orders/search and our reference, ` +
      `because it sometimes exists anyway. All our test orders have a reference starting with "${ref}" and the comment ` +
      `"TESTORDER QRSong API-test, NIET PRODUCEREN, wordt direct geannuleerd". The delivery address is our own.`,
    host: 'Environment',
    account: 'Account',
    key: 'Key (sha256, first 12 characters)',
    ip: 'Our IP address',
    reachable: 'Reachable',
    yes: 'yes',
    no: 'no',
    requests: 'Requests (calculate + place)',
    placed: 'Orders created / cancelled',
    observations: 'What stood out',
    timing: 'Processing time per case',
    timingNote: 'Median in milliseconds. Print&Bind fetches the PDF while the request is open.',
    case: 'Case',
    pdfs: 'PDFs',
    pages: 'pages',
    findings: 'Findings',
    noFindings: 'No errors in this run: no 5xx, no requests without an answer, no differences between sandbox and live.',
    moreFindings: (n: number) => `${n} more finding(s), without details (the full data is in the run's files):`,
    timeline: 'Timeline of all requests',
    timelineNote: 'To compare with your logs. Times in UTC, to the millisecond.',
    time: 'Time',
    amsterdamTime: 'Time (Amsterdam)',
    duration: 'Duration',
    call: 'Request',
    reference: 'Our reference',
    order: 'Order',
    status: 'Status',
    step: 'Step',
    request: 'Request (JSON)',
    response: 'Response',
    headers: 'Response headers',
    files: 'Files in this request',
    counterpart: (env: string) => `What ${env} answered to the same request`,
    followUp: 'What happened next',
    reproduce: 'Send it again (curl)',
    caseLabel: 'Case',
    kind: {
      'server-error': (e: Exchange, env: string) => `HTTP ${e.status} on ${e.method} ${pathOf(e)} (${env})`,
      'no-answer': (e: Exchange, env: string) => `No answer to ${e.method} ${pathOf(e)} (${env}): ${e.networkError}`,
      orphan: (e: Exchange, env: string, a: Attempt) =>
        `Order ${a.orphan?.orderId} exists although POST /orders ${e.status === null ? `got no answer (${e.networkError})` : `answered ${e.status}`} (${env})`,
      'not-cancelled': (e: Exchange, env: string, a: Attempt) =>
        `Order ${a.orderId} could not be cancelled: DELETE ${e.status === null ? `got no answer (${e.networkError})` : `answered ${e.status}`} (${env})`,
      difference: (e: Exchange, env: string, a: Attempt, other?: Exchange) =>
        `${a.caseId}: ${env} answered ${label(e)}, the other environment ${other ? label(other) : '?'} to ${e.method} ${pathOf(e)}`,
    } as Record<FindingKind, (e: Exchange, env: string, a: Attempt, other?: Exchange) => string>,
    obsFailed: (env: string, bad: number, total: number) =>
      `${env}: ${bad} of ${total} order requests (POST /orders) ended in a 5xx or without an answer.`,
    obsCalcFailed: (env: string, bad: number, total: number) =>
      `${env}: ${bad} of ${total} calculations (POST /orders/calculate) ended in a 5xx or without an answer.`,
    obsOrphans: (ids: string[]) =>
      `${ids.length} order(s) existed anyway after a 5xx or timeout: ${ids.join(', ')}. We deleted them at once.`,
    obsUncancelled: (ids: string[]) => `Could not be cancelled: order ${ids.join(', ')}. Could you delete them?`,
    obsSize: (env: string, small: string, large: string) =>
      `Processing time grows with the PDF (calculate, ${env}): ${small} against ${large}.`,
    obsAllCancelled: (n: number) => `All ${n} test orders created were cancelled.`,
    obsNoSandbox: 'The sandbox could not be reached from our IP address (nginx 403 before the API).',
  },
};

function pathOf(exchange: Exchange): string {
  try {
    return new URL(exchange.url).pathname.replace(/^\/api\/rest/, '');
  } catch {
    return exchange.url;
  }
}

const utcMs = (iso: string) => `${iso.replace('T', ' ').replace('Z', '')} UTC`;
const amsterdamMs = (iso: string) =>
  `${new Date(iso).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}.${iso.slice(20, 23)}`;

const exchangesOfAttempt = (a: Attempt): Exchange[] =>
  [a.calculate, a.place, ...a.deletes, a.verify, a.search].filter((e): e is Exchange => !!e);

/** The other host's exchange for the same case, repeat and step. */
function counterpartOf(result: RunResult, attempt: Attempt, exchange: Exchange): Exchange | undefined {
  const other = result.attempts.find(
    (a) => a.caseId === attempt.caseId && a.n === attempt.n && a.env !== attempt.env
  );
  if (!other) return undefined;
  if (exchange.step === 'calculate') return other.calculate;
  if (exchange.step === 'place') return other.place;
  if (exchange.step === 'delete') return other.deletes[other.deletes.length - 1];
  return undefined;
}

/** Everything worth Print&Bind's time in a run, oldest first. */
export function findings(result: RunResult): Finding[] {
  const found: Finding[] = [];
  for (const attempt of result.attempts) {
    for (const exchange of exchangesOfAttempt(attempt)) {
      const failed = exchange.status === null || exchange.status >= 500;
      // An orphan's failed POST is told as the orphan, with what followed
      if (!failed || (attempt.orphan && exchange === attempt.place)) continue;
      found.push({
        kind: exchange.status === null ? 'no-answer' : 'server-error',
        attempt,
        exchange,
        counterpart: counterpartOf(result, attempt, exchange),
        followUp: [],
      });
    }
    if (attempt.orphan && attempt.place) {
      found.push({
        kind: 'orphan',
        attempt,
        exchange: attempt.place,
        counterpart: counterpartOf(result, attempt, attempt.place),
        followUp: [attempt.search, ...attempt.deletes, attempt.verify].filter((e): e is Exchange => !!e),
      });
    }
    if (attempt.cancelled === false && attempt.deletes.length) {
      const last = attempt.deletes[attempt.deletes.length - 1];
      found.push({
        kind: 'not-cancelled',
        attempt,
        exchange: last,
        followUp: [...attempt.deletes.slice(0, -1), attempt.verify].filter((e): e is Exchange => !!e),
      });
    }
  }
  // Differences not told above already (a 4xx on one host, a 2xx on the other)
  const told = new Set(found.flatMap((f) => [f.exchange, ...f.followUp]));
  for (const diff of differences(result)) {
    const sides = Object.values(diff.sides).map((s) => s.example).filter((e): e is Exchange => !!e);
    if (sides.some((e) => e.status === null || e.status >= 500 || told.has(e))) continue;
    const odd = sides.find((e) => statusClass(e) !== '2xx') ?? sides[0];
    const attempt = result.attempts.find((a) => exchangesOfAttempt(a).includes(odd));
    if (!attempt) continue;
    found.push({ kind: 'difference', attempt, exchange: odd, counterpart: counterpartOf(result, attempt, odd), followUp: [] });
  }
  return found.sort((a, b) => a.exchange.at.localeCompare(b.exchange.at));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function observations(result: RunResult, all: Finding[], t: (typeof TEXT)['nl']): string[] {
  const lines: string[] = [];
  for (const env of result.options.envs) {
    const attempts = result.attempts.filter((a) => a.env === env);
    const places = attempts.map((a) => a.place).filter((e): e is Exchange => !!e);
    const calcs = attempts.map((a) => a.calculate).filter((e): e is Exchange => !!e);
    const bad = (list: Exchange[]) => list.filter((e) => e.status === null || e.status >= 500).length;
    if (places.length) lines.push(t.obsFailed(env, bad(places), places.length));
    if (calcs.length && bad(calcs)) lines.push(t.obsCalcFailed(env, bad(calcs), calcs.length));
  }
  const orphans = all.filter((f) => f.kind === 'orphan').map((f) => f.attempt.orphan!.orderId);
  if (orphans.length) lines.push(t.obsOrphans(orphans));
  if (result.uncancelled.length) lines.push(t.obsUncancelled(result.uncancelled.map((u) => `${u.orderId} (${u.env})`)));
  const placed = result.attempts.filter((a) => a.orderId);
  if (placed.length && !result.uncancelled.length) lines.push(t.obsAllCancelled(placed.length));
  if (result.hosts.some((h) => h.env === 'sandbox' && !h.reachable && /nginx 403/.test(h.problem ?? ''))) {
    lines.push(t.obsNoSandbox);
  }
  // Time against file size, on the host with the most calculations
  const env = (result.options.envs.includes('live') ? 'live' : 'sandbox') as EnvName;
  const sized = result.cases
    .map((c) => ({
      c,
      bytes: c.files.reduce((sum, f) => sum + (f.bytes ?? 0), 0),
      ms: median(result.attempts.filter((a) => a.caseId === c.id && a.env === env && a.calculate?.status === 200).map((a) => a.calculate!.ms)),
    }))
    .filter((s) => s.ms !== null && s.bytes > 0)
    .sort((a, b) => a.bytes - b.bytes);
  const first = sized[0];
  const last = sized[sized.length - 1];
  // Only worth a line when the big file clearly takes longer
  if (sized.length >= 2 && last.ms! >= 2000 && last.ms! >= 2 * first.ms!) {
    lines.push(
      t.obsSize(env, `${mb(first.bytes)} ${(first.ms! / 1000).toFixed(1)} s`, `${mb(last.bytes)} ${(last.ms! / 1000).toFixed(1)} s`)
    );
  }
  return lines;
}

function fullBody(runDir: string, exchange: Exchange): unknown {
  if (exchange.file) {
    try {
      return JSON.parse(fs.readFileSync(path.join(runDir, exchange.file), 'utf8')).body;
    } catch {
      // the run folder was moved: fall back to the (possibly cut) copy in run.json
    }
  }
  return exchange.body;
}

function factsTable(rows: [string, string][]): string {
  return `<table class="facts">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</table>`;
}

function exchangeFacts(t: (typeof TEXT)['nl'], e: Exchange, a: Attempt): [string, string][] {
  return [
    [t.time, esc(utcMs(e.at))],
    [t.amsterdamTime, esc(amsterdamMs(e.at))],
    [t.duration, `${e.ms} ms`],
    [t.call, `<code>${esc(e.method)} ${esc(e.url)}</code>`],
    [t.status, `<span class="chip ${tone(e)}">${esc(label(e))}</span> ${esc(e.statusText)} ${e.status !== null && e.status >= 300 ? esc(errorText(e)) : esc(e.networkError ?? '')}`],
    [t.reference, `<code>${esc(a.reference ?? '')}</code>`],
    ...(a.orderId ? [[t.order, esc(a.orderId)] as [string, string]] : []),
  ];
}

function headersText(e: Exchange): string {
  const lines = Object.entries(e.headers).map(([k, v]) => `${k}: ${v}`);
  return lines.length ? lines.join('\n') : '(none)';
}

function findingBlock(
  result: RunResult,
  runDir: string,
  t: (typeof TEXT)['nl'],
  finding: Finding,
  index: number,
  c: HarnessCase | undefined
): string {
  const { exchange: e, attempt: a } = finding;
  const title = t.kind[finding.kind](e, a.env, a, finding.counterpart);
  const files = (c?.files ?? [])
    .map((f) => `<tr><td>${esc(f.url)}</td><td>${mb(f.bytes)}</td><td>${f.pages ?? '?'} ${t.pages}</td></tr>`)
    .join('');
  const other = finding.counterpart;
  const otherEnv = result.attempts.find((x) => x !== a && x.caseId === a.caseId && x.n === a.n)?.env;
  return `
  <section class="finding">
    <h3>${index}. ${esc(title)}</h3>
    ${factsTable([[t.caseLabel, `${esc(c?.id ?? a.caseId)}: ${esc(c?.title ?? '')}`], ...exchangeFacts(t, e, a)])}
    <h4>${t.response}</h4>
    <pre>${esc(json(fullBody(runDir, e)) || '(empty)')}</pre>
    <h4>${t.headers}</h4>
    <pre class="small">${esc(headersText(e))}</pre>
    ${e.requestBody !== undefined ? `<h4>${t.request}</h4><pre>${esc(json(e.requestBody))}</pre>` : ''}
    ${files ? `<h4>${t.files}</h4><table class="list">${files}</table>` : ''}
    ${other && otherEnv ? `<h4>${t.counterpart(otherEnv)}</h4>${factsTable(exchangeFacts(t, other, result.attempts.find((x) => exchangesOfAttempt(x).includes(other)) ?? a))}<pre class="small">${esc(json(fullBody(runDir, other)) || '(empty)')}</pre>` : ''}
    ${finding.followUp.length ? `<h4>${t.followUp}</h4><table class="list">${finding.followUp.map((f) => `<tr><td class="nowrap">${esc(utcMs(f.at))}</td><td class="nowrap"><code>${esc(f.method)} ${esc(pathOf(f))}</code></td><td><span class="chip ${tone(f)}">${esc(label(f))}</span></td><td>${esc(errorText(f) || (f.status && f.status < 300 ? json(f.body).slice(0, 160) : ''))}</td></tr>`).join('')}</table>` : ''}
    <h4>${t.reproduce}</h4>
    <pre class="small">${esc(curl(result, e))}</pre>
  </section>`;
}

export function renderIncidentHtml(result: RunResult, runDir: string, lang: Lang = 'nl'): string {
  const t = TEXT[lang];
  const all = findings(result);
  const detailed = all.slice(0, MAX_DETAILED);
  const rest = all.slice(MAX_DETAILED);
  const caseOf = (id: string) => result.cases.find((c) => c.id === id);

  const hostRows = result.hosts
    .map((h) => {
      const attempts = result.attempts.filter((a) => a.env === h.env);
      const calls = attempts.flatMap((a) => [a.calculate, a.place]).filter((e): e is Exchange => !!e);
      const count = (cls: string) => calls.filter((e) => statusClass(e) === cls).length;
      const placed = attempts.filter((a) => a.orderId);
      return `<tr><td><b>${esc(h.env)}</b><br><code>${esc(h.baseUrl)}</code></td>
        <td>${esc(h.accountId ?? '-')}</td><td><code>${esc(h.fingerprint)}</code></td>
        <td>${h.reachable ? t.yes : `${t.no}: ${esc(h.problem)}`}</td>
        <td>${calls.length}: 2xx ${count('2xx')} · 4xx ${count('4xx')} · 5xx ${count('5xx')} · none ${count('network')}</td>
        <td>${placed.length} / ${placed.filter((a) => a.cancelled === true).length}</td></tr>`;
    })
    .join('');

  const envs = result.options.envs;
  const timingRows = result.cases
    .map((c) => {
      const bytes = c.files.reduce((sum, f) => sum + (f.bytes ?? 0), 0);
      const pages = c.files.reduce((sum, f) => sum + (f.pages ?? 0), 0);
      const cells = envs
        .map((env) =>
          (['calculate', 'place'] as const)
            .map((step) => {
              const ms = median(
                result.attempts
                  .filter((a) => a.caseId === c.id && a.env === env)
                  .map((a) => a[step])
                  .filter((e): e is Exchange => !!e && e.status !== null)
                  .map((e) => e.ms)
              );
              return `<td class="num">${ms ?? '-'}</td>`;
            })
            .join('')
        )
        .join('');
      return `<tr><td>${esc(c.id)}</td><td class="num">${mb(bytes)}</td><td class="num">${pages}</td>${cells}</tr>`;
    })
    .join('');

  const timeline = result.attempts
    .flatMap((a) => exchangesOfAttempt(a).map((e) => ({ a, e })))
    .sort((x, y) => x.e.at.localeCompare(y.e.at))
    .map(
      ({ a, e }) =>
        `<tr><td>${esc(utcMs(e.at).replace(' UTC', ''))}</td><td>${esc(a.env)}</td><td>${esc(a.caseId)}</td><td><code>${esc(e.method)} ${esc(pathOf(e))}</code></td><td><span class="chip ${tone(e)}">${esc(label(e))}</span></td><td class="num">${e.ms}</td><td><code>${esc(a.reference ?? '')}</code></td></tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${esc(t.title)}</title>
<style>
@page { size: A4; margin: 14mm 12mm 16mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #1d2321; font: 9.5pt/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
h1 { font-size: 18pt; margin: 0 0 2pt; color: #0f4f4f; }
.subtitle { color: #5d6663; margin: 0 0 12pt; }
h2 { font-size: 12.5pt; margin: 16pt 0 6pt; padding-bottom: 3pt; border-bottom: 1.5pt solid #0f6b6b; color: #0f4f4f; break-after: avoid; }
h3 { font-size: 10.5pt; margin: 0 0 6pt; break-after: avoid; }
h4 { font-size: 8pt; text-transform: uppercase; letter-spacing: .05em; color: #5d6663; margin: 9pt 0 3pt; break-after: avoid; }
p { margin: 0 0 6pt; }
code, pre { font: 7.6pt/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { background: #f2efe8; border: .5pt solid #ddd8cc; border-radius: 3pt; padding: 6pt; margin: 0; white-space: pre-wrap; word-break: break-all; }
pre.small { font-size: 7pt; }
table { border-collapse: collapse; width: 100%; margin: 0 0 4pt; }
th, td { text-align: left; vertical-align: top; padding: 3pt 5pt; border-bottom: .5pt solid #ddd8cc; }
th { color: #5d6663; font-weight: 600; font-size: 8pt; }
table.facts th { width: 30%; }
table.list td, table.timeline td { font-size: 7.5pt; }
table.timeline { table-layout: fixed; }
table.timeline td { padding: 2pt 4pt; }
td.nowrap, table.timeline td:nth-child(-n+4) { white-space: nowrap; overflow: hidden; }
table.timeline code { font-size: 6.8pt; }
.num { text-align: right; white-space: nowrap; }
.chip { display: inline-block; padding: 0 5pt; border-radius: 6pt; font-size: 7.5pt; font-weight: 700; }
.chip.ok { background: #e2f3ea; color: #1f7a4d; }
.chip.warn { background: #fbefd2; color: #8a5a00; }
.chip.bad { background: #fde4e1; color: #b42318; }
ul { margin: 0 0 6pt 14pt; padding: 0; }
li { margin: 0 0 3pt; }
.finding { border-top: 1pt solid #ddd8cc; padding-top: 10pt; margin-top: 12pt; }
.finding:first-of-type { border-top: 0; margin-top: 0; padding-top: 0; }
.page-break { break-before: page; }
</style>
</head>
<body>
  <h1>${esc(t.title)}</h1>
  <p class="subtitle">${esc(t.subtitle(result.runId))} · ${esc(utcMs(result.startedAt))}${result.finishedAt ? ` → ${esc(utcMs(result.finishedAt))}` : ''} · ${t.ip}: ${esc(result.publicIp ?? '?')}</p>

  <h2>${t.summary}</h2>
  <table>
    <tr><th>${t.host}</th><th>${t.account}</th><th>${t.key}</th><th>${t.reachable}</th><th>${t.requests}</th><th>${t.placed}</th></tr>
    ${hostRows}
  </table>
  <h4>${t.observations}</h4>
  <ul>${observations(result, all, t).map((line) => `<li>${esc(line)}</li>`).join('')}</ul>

  <h2>${t.method}</h2>
  <p>${esc(t.methodText('qrs-harness-'))}</p>

  <h2>${t.timing}</h2>
  <p>${esc(t.timingNote)}</p>
  <table>
    <tr><th>${t.case}</th><th class="num">${t.pdfs}</th><th class="num">${t.pages}</th>${envs.map((env) => `<th class="num">${esc(env)} calculate</th><th class="num">${esc(env)} place</th>`).join('')}</tr>
    ${timingRows}
  </table>

  <h2 class="page-break">${t.findings}</h2>
  ${detailed.length ? detailed.map((f, i) => findingBlock(result, runDir, t, f, i + 1, caseOf(f.attempt.caseId))).join('') : `<p>${esc(t.noFindings)}</p>`}
  ${rest.length ? `<h4>${esc(t.moreFindings(rest.length))}</h4><table class="list">${rest.map((f) => `<tr><td>${esc(utcMs(f.exchange.at))}</td><td>${esc(f.attempt.env)}</td><td><code>${esc(f.exchange.method)} ${esc(pathOf(f.exchange))}</code></td><td><span class="chip ${tone(f.exchange)}">${esc(label(f.exchange))}</span></td><td><code>${esc(f.attempt.reference ?? '')}</code></td></tr>`).join('')}</table>` : ''}

  <h2 class="page-break">${t.timeline}</h2>
  <p>${esc(t.timelineNote)}</p>
  <table class="timeline">
    <colgroup><col style="width:20%"><col style="width:9%"><col style="width:12%"><col style="width:20%"><col style="width:9%"><col style="width:6%"><col></colgroup>
    <tr><th>${t.time} (UTC)</th><th>${t.host}</th><th>${t.case}</th><th>${t.call}</th><th>${t.status}</th><th class="num">ms</th><th>${t.reference}</th></tr>
    ${timeline}
  </table>
</body>
</html>`;
}

/** Render the Print&Bind report of a run to PDF; returns the file. */
export async function writeIncidentPdf(result: RunResult, runDir: string, lang: Lang = 'nl'): Promise<string> {
  if (!fs.existsSync(CHROME)) {
    throw new Error(`Chrome not found at ${CHROME}: set CHROME_PATH (the HTML report has the same data)`);
  }
  const html = renderIncidentHtml(result, runDir, lang);
  const htmlFile = path.join(runDir, `printenbind-report-${lang}.html`);
  fs.writeFileSync(htmlFile, html);
  const pdfFile = path.join(runDir, `printenbind-report-${result.runId}-${lang}.pdf`);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: pdfFile,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font:7pt -apple-system,Helvetica,sans-serif;color:#888;padding:0 12mm;display:flex;justify-content:space-between"><span>QRSong! · Print&amp;Bind REST API · ${esc(result.runId)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
  } finally {
    await browser.close();
  }
  return pdfFile;
}
