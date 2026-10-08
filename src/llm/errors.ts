/**
 * Errors of the LLM layer. This file imports no runtime code, so a test that
 * mocks `src/llm` can still import the real classes and `instanceof` works.
 */
import type { LlmAttempt, LlmUsage } from './types';

export type LlmOutputKind = 'refusal' | 'truncated' | 'unparseable' | 'empty';

/**
 * The model answered, but not with something usable. The tokens were billed
 * all the same, so the error carries the attempts and their cost. Callers
 * that used to fall back on a parse failure catch this one (or use
 * `llm.tryJson`, which returns null for it).
 */
export class LlmOutputError extends Error {
  readonly kind: LlmOutputKind;
  readonly task: string;
  /** The raw answer, cut to 500 characters, for logs. */
  readonly raw: string;
  attempts: LlmAttempt[] = [];
  costUsd = 0;
  usage: LlmUsage | null = null;

  constructor(task: string, kind: LlmOutputKind, raw = '') {
    super(`[llm] ${task}: ${kind}`);
    this.name = 'LlmOutputError';
    this.task = task;
    this.kind = kind;
    this.raw = raw.slice(0, 500);
  }
}

/** A request we built wrong (a bug of ours). Never retried on a fallback. */
export class LlmRequestError extends Error {
  constructor(message: string) {
    super(`[llm] ${message}`);
    this.name = 'LlmRequestError';
  }
}

/** The provider has no API key in this process. */
export class LlmUnavailableError extends Error {
  readonly provider: string;
  constructor(provider: string) {
    super(`[llm] provider ${provider} is not configured`);
    this.name = 'LlmUnavailableError';
    this.provider = provider;
  }
}
