/**
 * Per-model input/output token prices in USD per 1M tokens.
 *
 * Sources (May 2026):
 *   gpt-5.4-mini: https://pricepertoken.com/pricing-page/model/openai-gpt-5.4-mini
 *                 https://openai.com/api/pricing/
 *
 * To add a new model, append an entry below. Prices are expressed per
 * million tokens (matching OpenAI's pricing convention) — the conversion
 * to per-token happens in `estimateCostUsd()`.
 */
export interface ModelPricing {
  /** USD per 1,000,000 input tokens */
  inputPerMillion: number;
  /** USD per 1,000,000 output tokens */
  outputPerMillion: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-5.4-mini': {
    inputPerMillion: 0.75,
    outputPerMillion: 4.5,
  },
};

/**
 * Compute USD cost for a single LLM call.
 * Unknown models cost 0 (rather than throwing) so token accounting still
 * works for cheap-to-add models; logs will surface a 0-cost warning when
 * we don't have pricing.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  const inCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return inCost + outCost;
}

/**
 * Accumulator used by long multi-step LLM flows (e.g. AI playlist
 * generation) to track total token spend across many calls and surface
 * one final cost figure.
 */
export class CostTracker {
  inputTokens = 0;
  outputTokens = 0;
  costUsd = 0;
  callCount = 0;

  constructor(public readonly model: string) {}

  record(inputTokens: number, outputTokens: number): void {
    if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return;
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    this.costUsd += estimateCostUsd(this.model, inputTokens, outputTokens);
    this.callCount += 1;
  }

  /** Pulls token usage directly from an OpenAI chat-completions response. */
  recordFromResponse(response: any): void {
    const usage = response?.usage;
    if (!usage) return;
    this.record(usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
  }
}
