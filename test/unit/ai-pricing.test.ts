import { describe, it, expect } from 'vitest';
import {
  estimateCostUsd,
  CostTracker,
  MODEL_PRICING,
} from '../../src/aiPricing';

describe('estimateCostUsd', () => {
  it('prices known models per million tokens', () => {
    const { inputPerMillion, outputPerMillion } = MODEL_PRICING['gpt-5.4-mini'];
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

  it('reads usage from an OpenAI-shaped response', () => {
    const t = new CostTracker('gpt-5.4-mini');
    t.recordFromResponse({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
    t.recordFromResponse({}); // no usage → ignored
    expect(t.inputTokens).toBe(10);
    expect(t.outputTokens).toBe(5);
    expect(t.callCount).toBe(1);
  });
});
