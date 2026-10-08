import { describe, it, expect } from 'vitest';
import { estimateCostUsd, CostTracker } from '../../src/aiPricing';
import { MODELS } from '../../src/llm/models';

describe('estimateCostUsd', () => {
  it('prices known models per million tokens', () => {
    const { input: inputPerMillion, output: outputPerMillion } =
      MODELS['gpt-5.4-mini'].price;
    expect(estimateCostUsd('gpt-5.4-mini', 1_000_000, 1_000_000)).toBeCloseTo(
      inputPerMillion + outputPerMillion,
      10
    );
    expect(estimateCostUsd('gpt-5.4-mini', 500_000, 0)).toBeCloseTo(
      inputPerMillion / 2,
      10
    );
  });

  it('returns 0 for unknown models instead of throwing', () => {
    expect(estimateCostUsd('gpt-unknown', 1_000_000, 1_000_000)).toBe(0);
  });
});

describe('CostTracker', () => {
  it('accumulates tokens, cost and call count', () => {
    const t = new CostTracker('gpt-5.4-mini');
    t.record(100_000, 50_000);
    t.record(200_000, 100_000);
    expect(t.inputTokens).toBe(300_000);
    expect(t.outputTokens).toBe(150_000);
    expect(t.callCount).toBe(2);
    expect(t.costUsd).toBeCloseTo(
      estimateCostUsd('gpt-5.4-mini', 300_000, 150_000),
      10
    );
  });

  it('ignores non-finite token counts', () => {
    const t = new CostTracker('gpt-5.4-mini');
    t.record(NaN, 10);
    t.record(10, Infinity);
    expect(t.callCount).toBe(0);
  });

  it('adds up every attempt of an LLM-layer call, each at its own price', () => {
    const t = new CostTracker();
    const attempt = (over: object) => ({
      provider: 'anthropic' as const,
      model: 'claude-haiku-5-5',
      role: 'primary' as const,
      status: 'ok' as const,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0 },
      costUsd: 0.001,
      estimated: false,
      durationMs: 1,
      ...over,
    });
    t.recordCall({
      attempts: [
        attempt({ status: 'error', model: 'claude-sonnet-5-5', costUsd: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
        attempt({ role: 'fallback', provider: 'openai', model: 'gpt-5.6-luna', costUsd: 0.002 }),
      ],
    });
    t.recordCall({ attempts: [attempt({})] });
    t.recordCall(null); // ignored
    expect(t.callCount).toBe(2);
    expect(t.inputTokens).toBe(300); // cache reads count as input
    expect(t.outputTokens).toBe(20);
    expect(t.costUsd).toBeCloseTo(0.003, 10);
    // only the models that answered
    expect(t.label()).toBe('gpt-5.6-luna+claude-haiku-5-5');
  });

  it('cuts the label to the 64 characters of AISearch.model', () => {
    const t = new CostTracker('x'.repeat(80));
    expect(t.label()).toHaveLength(64);
  });
});
