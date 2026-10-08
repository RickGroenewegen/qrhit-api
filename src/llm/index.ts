/**
 * The LLM layer: the only way code in this API talks to a language, image or
 * speech model. A call names a task (./tasks.ts); the task decides provider,
 * model and effort, and falls back once to its fallback route when the
 * primary fails. Every model run is priced (./models.ts), logged in one line
 * and written to the llm_calls ledger.
 *
 *   const year = await llm.tryJson<YearAnswer>('yearLookup', {
 *     messages: [{ role: 'system', content: '...' }, { role: 'user', content: prompt }],
 *     schema: { name: 'parseYear', schema: { ... } },
 *   });
 *
 * json() throws LlmOutputError when the answer is unusable (refused, cut
 * off, empty, not JSON) and rethrows provider errors; tryJson() returns null
 * for the first and still throws the second, which is the split nearly every
 * caller wants. Only the files in ./providers import an SDK.
 */
import { color } from 'console-log-colors';
import Logger from '../logger';
import { LlmOutputError, LlmRequestError, LlmUnavailableError } from './errors';
import type { LlmOutputKind } from './errors';
import { recordLlmCalls } from './ledger';
import { modelInfo, priceCall, promptTokens } from './models';
import { getProvider } from './providers';
import { taskConfig } from './tasks';
import type { ImageTask, LlmTask, SpeechTask, TextTask } from './tasks';
import { addUsage, ZERO_USAGE } from './types';
import type {
  LlmAttempt,
  LlmAttemptStatus,
  LlmImageRequest,
  LlmKind,
  LlmRequest,
  LlmResult,
  LlmRoute,
  LlmSchema,
  LlmSpeechRequest,
  LlmSystemBlock,
  LlmTaskConfig,
  LlmUsage,
  NormalizedRequest,
  ProviderBinaryResponse,
  ProviderCallOptions,
  ProviderTextResponse,
  UsagePart,
} from './types';

export * from './errors';
export type * from './types';
export type { LlmTask, TextTask, ImageTask, SpeechTask } from './tasks';

const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 1;

const logger = new Logger();

/** Leading system messages become the system prompt; the rest stay in order. */
export function normalizeRequest(req: LlmRequest): NormalizedRequest {
  const system: LlmSystemBlock[] =
    typeof req.system === 'string'
      ? req.system
        ? [{ text: req.system }]
        : []
      : [...(req.system ?? [])];
  const messages: NormalizedRequest['messages'] = [];
  for (const message of req.messages) {
    if (message.role === 'system') {
      if (messages.length > 0) {
        throw new LlmRequestError('system messages must come before the conversation');
      }
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((part) => (part.type === 'text' ? part.text : ''))
              .join('');
      system.push({ text });
      continue;
    }
    messages.push({ role: message.role, content: message.content });
  }
  return { system, messages, schema: req.schema, temperature: req.temperature };
}

function callOptions(config: LlmTaskConfig, route: LlmRoute, req?: LlmRequest): ProviderCallOptions {
  return {
    route,
    maxOutputTokens: req?.maxOutputTokens ?? config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
  };
}

function errorText(err: unknown): string {
  const status = (err as { status?: unknown })?.status;
  const message = (err as Error)?.message ?? String(err);
  return status ? `${status} ${message}` : message;
}

const OUTPUT_STATUS: Record<LlmOutputKind, LlmAttemptStatus> = {
  refusal: 'refusal',
  truncated: 'truncated',
  unparseable: 'unparseable',
  empty: 'empty',
};

function attemptsFromParts(
  route: LlmRoute,
  role: 'primary' | 'fallback',
  parts: UsagePart[],
  status: LlmAttemptStatus,
  durationMs: number,
  error?: string
): LlmAttempt[] {
  return parts.map((part) => ({
    provider: route.provider,
    model: part.model,
    role: part.serverFallback ? 'fallback' : role,
    status: part.refused ? 'refusal' : status,
    usage: part.usage,
    costUsd: priceCall(part.model, part.usage),
    estimated: !!part.estimated,
    durationMs,
    error: part.refused ? 'refused; the server-side fallback took over' : error,
  }));
}

function failedAttempt(
  route: LlmRoute,
  role: 'primary' | 'fallback',
  err: unknown,
  durationMs: number
): LlmAttempt {
  return {
    provider: route.provider,
    model: route.model,
    role,
    status: err instanceof LlmUnavailableError ? 'unavailable' : 'error',
    usage: { ...ZERO_USAGE },
    costUsd: 0,
    estimated: false,
    durationMs,
    error: errorText(err),
  };
}

function totals(attempts: LlmAttempt[]): { usage: LlmUsage; costUsd: number } {
  return {
    usage: attempts.reduce((sum, a) => addUsage(sum, a.usage), { ...ZERO_USAGE }),
    costUsd: attempts.reduce((sum, a) => sum + a.costUsd, 0),
  };
}

/** A cost for a log line: "$0.0071", or six decimals for the cheap ones. */
export function formatCostUsd(usd: number): string {
  return `$${usd >= 0.01 ? usd.toFixed(4) : usd.toFixed(6)}`;
}

/**
 * Logs a call only when something went wrong: it fell back or failed, or a
 * Haiku prompt crossed its long-context line. A normal call is silent here;
 * the call sites put its cost in their own log line, and every call is in the
 * llm_calls ledger.
 */
function logCall(task: string, attempts: LlmAttempt[], ok: boolean, durationMs: number): void {
  const last = attempts[attempts.length - 1];
  if (!last) return;
  const { usage, costUsd } = totals(attempts);
  const fellBack = attempts.some((a) => a.role === 'fallback');
  warnLongContext(task, attempts);
  if (ok && !fellBack) return;
  const level = !ok ? color.red.bold : color.yellow.bold;
  const cache =
    usage.cacheReadTokens || usage.cacheWriteTokens
      ? level(' cache r') +
        color.white.bold(String(usage.cacheReadTokens)) +
        level(' w') +
        color.white.bold(String(usage.cacheWriteTokens))
      : '';
  let line =
    level('[') +
    color.white.bold('llm') +
    level('] ') +
    color.white.bold(task) +
    level(' ') +
    color.white.bold(`${last.provider}/${last.model}`) +
    level(' in ') +
    color.white.bold(String(usage.inputTokens + (usage.imageInputTokens ?? 0))) +
    level(' out ') +
    color.white.bold(String(usage.outputTokens)) +
    cache +
    level(' ') +
    color.white.bold(formatCostUsd(costUsd)) +
    level(' ') +
    color.white.bold(`${(durationMs / 1000).toFixed(1)}s`);
  const failures = attempts
    .filter((a) => a.status !== 'ok')
    .map((a) => `${a.provider}/${a.model} ${a.status}${a.error ? ` (${a.error.slice(0, 120)})` : ''}`)
    .join(', ');
  if (failures) line += level(ok ? ' fell back after ' : ' failed: ') + color.white.bold(failures);
  logger.log(line);
}

function warnLongContext(task: string, attempts: LlmAttempt[]): void {
  for (const attempt of attempts) {
    const info = modelInfo(attempt.model);
    const prompt = promptTokens(attempt.usage);
    if (info?.longContext && prompt > info.longContext.thresholdTokens) {
      logger.log(
        color.yellow.bold('[') +
          color.white.bold('llm') +
          color.yellow.bold('] ') +
          color.white.bold(task) +
          color.yellow.bold(' sent ') +
          color.white.bold(String(prompt)) +
          color.yellow.bold(' prompt tokens to ') +
          color.white.bold(attempt.model) +
          color.yellow.bold(', above its ') +
          color.white.bold(String(info.longContext.thresholdTokens)) +
          color.yellow.bold('-token line: billed at the long-context rate')
      );
    }
  }
}

function finish(
  task: string,
  kind: LlmKind,
  attempts: LlmAttempt[],
  ok: boolean,
  durationMs: number
): void {
  recordLlmCalls(task, kind, attempts);
  logCall(task, attempts, ok, durationMs);
}

class Llm {
  /**
   * Runs a text task: the primary route, then the fallback once. `parse`
   * turns the answer into the result and throws on an unusable one.
   */
  private async runText<T>(
    task: TextTask,
    req: LlmRequest,
    parse: (text: string) => T,
    onToken?: (token: string) => void
  ): Promise<LlmResult<T>> {
    const config = taskConfig(task);
    const normalized = normalizeRequest(req);
    const routes = [config.primary, config.fallback].filter(
      (route): route is LlmRoute => !!route
    );
    const attempts: LlmAttempt[] = [];
    const started = Date.now();
    let outputError: LlmOutputError | null = null;
    let lastError: unknown = null;
    let emitted = false;

    for (let i = 0; i < routes.length; i++) {
      // A stream that already sent text cannot start over on another model.
      if (i > 0 && emitted) break;
      const route = routes[i];
      const role = i === 0 ? 'primary' : 'fallback';
      const t0 = Date.now();
      let response: ProviderTextResponse;
      try {
        const provider = getProvider(route.provider);
        const opts = callOptions(config, route, req);
        if (onToken) {
          if (!provider.stream) throw new LlmRequestError(`${route.provider} cannot stream`);
          response = await provider.stream(normalized, opts, (token) => {
            emitted = true;
            onToken(token);
          });
        } else {
          if (!provider.complete) throw new LlmRequestError(`${route.provider} has no text models`);
          response = await provider.complete(normalized, opts);
        }
      } catch (err) {
        if (err instanceof LlmRequestError) {
          finish(task, 'text', attempts, false, Date.now() - started);
          throw err;
        }
        attempts.push(failedAttempt(route, role, err, Date.now() - t0));
        lastError = err;
        continue;
      }

      const durationMs = Date.now() - t0;
      let failure: LlmOutputKind | null = null;
      let data: T | undefined;
      if (response.stopReason === 'refusal') failure = 'refusal';
      else if (response.stopReason === 'max_tokens') failure = 'truncated';
      else if (!response.text.trim()) failure = 'empty';
      else {
        try {
          data = parse(response.text);
        } catch {
          failure = 'unparseable';
        }
      }

      // A stream the customer is already reading ends with what it has.
      if (failure && onToken && emitted) {
        attempts.push(
          ...attemptsFromParts(route, role, response.parts, OUTPUT_STATUS[failure], durationMs)
        );
        finish(task, 'text', attempts, true, Date.now() - started);
        return this.result(response.text as T, route, response.parts, attempts, started, failure);
      }

      attempts.push(
        ...attemptsFromParts(
          route,
          role,
          response.parts,
          failure ? OUTPUT_STATUS[failure] : 'ok',
          durationMs,
          failure ? response.text.slice(0, 200) : undefined
        )
      );
      if (!failure) {
        finish(task, 'text', attempts, true, Date.now() - started);
        return this.result(data as T, route, response.parts, attempts, started);
      }
      outputError = new LlmOutputError(task, failure, response.text);
      lastError = outputError;
    }

    finish(task, 'text', attempts, false, Date.now() - started);
    // An unusable answer anywhere wins over a provider error: the callers'
    // "use a default" branch is the gentler outcome.
    if (outputError) {
      const { usage, costUsd } = totals(attempts);
      outputError.attempts = attempts;
      outputError.usage = usage;
      outputError.costUsd = costUsd;
      throw outputError;
    }
    throw lastError;
  }

  private result<T>(
    data: T,
    route: LlmRoute,
    parts: UsagePart[],
    attempts: LlmAttempt[],
    started: number,
    stopReason?: string
  ): LlmResult<T> {
    const { usage, costUsd } = totals(attempts);
    return {
      data,
      provider: route.provider,
      model: parts[parts.length - 1]?.model ?? route.model,
      usage,
      costUsd,
      durationMs: Date.now() - started,
      fellBack: attempts.some((a) => a.role === 'fallback'),
      attempts,
      ...(stopReason ? { stopReason } : {}),
    };
  }

  /** Structured output, parsed. Throws LlmOutputError or a provider error. */
  json<T>(task: TextTask, req: LlmRequest & { schema: LlmSchema }): Promise<LlmResult<T>> {
    return this.runText<T>(task, req, (text) => JSON.parse(text) as T);
  }

  /** Like json(), but null when the answer is unusable. Provider errors still throw. */
  async tryJson<T>(task: TextTask, req: LlmRequest & { schema: LlmSchema }): Promise<T | null> {
    try {
      return (await this.json<T>(task, req)).data;
    } catch (err) {
      if (err instanceof LlmOutputError) return null;
      throw err;
    }
  }

  /**
   * Like tryJson(), plus what the call cost (failed attempts included), for
   * the call site's own log line.
   */
  async tryJsonWithCost<T>(
    task: TextTask,
    req: LlmRequest & { schema: LlmSchema }
  ): Promise<{ data: T | null; costUsd: number }> {
    try {
      const result = await this.json<T>(task, req);
      return { data: result.data, costUsd: result.costUsd };
    } catch (err) {
      if (err instanceof LlmOutputError) return { data: null, costUsd: err.costUsd };
      throw err;
    }
  }

  /** A plain text answer. */
  text(task: TextTask, req: LlmRequest): Promise<LlmResult<string>> {
    return this.runText<string>(task, req, (text) => text);
  }

  /**
   * A streamed text answer: `onToken` gets each piece as it arrives. Falls
   * back only while nothing has been sent; after that a refusal or the token
   * limit ends the answer early (`stopReason` says which).
   */
  stream(
    task: TextTask,
    req: LlmRequest,
    onToken: (token: string) => void
  ): Promise<LlmResult<string>> {
    return this.runText<string>(task, req, (text) => text, onToken);
  }

  /** Image generation, or an edit when `images` is given. */
  image(task: ImageTask, req: LlmImageRequest): Promise<LlmResult<Buffer>> {
    return this.runBinary(task, 'image', (provider, opts) => {
      if (!provider.image) throw new LlmRequestError(`${provider.id} has no image models`);
      return provider.image(req, opts);
    });
  }

  /** Text to speech; the result is MP3 data. */
  speech(task: SpeechTask, req: LlmSpeechRequest): Promise<LlmResult<Buffer>> {
    return this.runBinary(task, 'speech', (provider, opts) => {
      if (!provider.speech) throw new LlmRequestError(`${provider.id} has no speech models`);
      return provider.speech(req, opts);
    });
  }

  private async runBinary(
    task: LlmTask,
    kind: LlmKind,
    call: (
      provider: ReturnType<typeof getProvider>,
      opts: ProviderCallOptions
    ) => Promise<ProviderBinaryResponse>
  ): Promise<LlmResult<Buffer>> {
    const config = taskConfig(task);
    const routes = [config.primary, config.fallback].filter(
      (route): route is LlmRoute => !!route
    );
    const attempts: LlmAttempt[] = [];
    const started = Date.now();
    let lastError: unknown = null;
    let outputError: LlmOutputError | null = null;

    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      const role = i === 0 ? 'primary' : 'fallback';
      const t0 = Date.now();
      let response: ProviderBinaryResponse;
      try {
        response = await call(getProvider(route.provider), callOptions(config, route));
      } catch (err) {
        if (err instanceof LlmRequestError) {
          finish(task, kind, attempts, false, Date.now() - started);
          throw err;
        }
        attempts.push(failedAttempt(route, role, err, Date.now() - t0));
        lastError = err;
        continue;
      }
      const ok = !!response.data && response.data.length > 0;
      attempts.push(
        ...attemptsFromParts(route, role, response.parts, ok ? 'ok' : 'empty', Date.now() - t0)
      );
      if (ok) {
        finish(task, kind, attempts, true, Date.now() - started);
        return this.result(response.data as Buffer, route, response.parts, attempts, started);
      }
      outputError = new LlmOutputError(task, 'empty');
      lastError = outputError;
    }

    finish(task, kind, attempts, false, Date.now() - started);
    if (outputError) {
      const { usage, costUsd } = totals(attempts);
      outputError.attempts = attempts;
      outputError.usage = usage;
      outputError.costUsd = costUsd;
      throw outputError;
    }
    throw lastError;
  }
}

export const llm = new Llm();
