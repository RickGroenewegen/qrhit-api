/**
 * Cost helpers for flows that add up many LLM calls into one figure (the AI
 * playlist generator's AISearch row). Prices live in src/llm/models.ts and
 * nowhere else; these only sum what the LLM layer priced.
 */
import { priceCall } from './llm/models';
import type { LlmAttempt } from './llm/types';

/**
 * USD cost of one call from plain token counts. An unknown model costs 0
 * rather than throwing.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  return priceCall(model, {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

/** Anything that carries the attempts of an LLM call: a result or an LlmOutputError. */
interface WithAttempts {
  attempts: LlmAttempt[];
}

/**
 * Accumulator for long multi-step flows (AI playlist generation): total
 * tokens and cost over many calls, which may run on different models.
 */
export class CostTracker {
  inputTokens = 0;
  outputTokens = 0;
  costUsd = 0;
  callCount = 0;
  private readonly models = new Set<string>();

  constructor(public readonly model?: string) {
    if (model) this.models.add(model);
  }

  /** Plain token counts, priced at the tracker's own model. */
  record(inputTokens: number, outputTokens: number): void {
    if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return;
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    this.costUsd += this.model ? estimateCostUsd(this.model, inputTokens, outputTokens) : 0;
    this.callCount += 1;
  }

  /**
   * Every attempt of one LLM-layer call, failed and fallback ones included,
   * each already priced at the model that ran it.
   */
  recordCall(call: WithAttempts | null | undefined): void {
    if (!call?.attempts?.length) return;
    for (const attempt of call.attempts) {
      const usage = attempt.usage;
      this.inputTokens +=
        usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + (usage.imageInputTokens ?? 0);
      this.outputTokens += usage.outputTokens;
      this.costUsd += attempt.costUsd;
      if (attempt.status === 'ok') this.models.add(attempt.model);
    }
    this.callCount += 1;
  }

  /** The models that answered, for AISearch.model (at most 64 characters). */
  label(): string {
    return [...this.models].join('+').slice(0, 64);
  }
}
