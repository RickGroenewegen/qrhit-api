import { describe, it, expect } from 'vitest';
import { MODELS, modelInfo, priceCall, PROVIDERS } from '../../../src/llm/models';

const usage = (u: Partial<Parameters<typeof priceCall>[1]>) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...u,
});

describe('priceCall', () => {
  it('prices input and output per million tokens', () => {
    expect(priceCall('claude-sonnet-5-5', usage({ inputTokens: 1_000_000 }))).toBeCloseTo(2, 10);
    expect(priceCall('claude-sonnet-5-5', usage({ outputTokens: 1_000_000 }))).toBeCloseTo(10, 10);
    expect(priceCall('gpt-5.6-luna', usage({ inputTokens: 500_000, outputTokens: 500_000 }))).toBeCloseTo(0.7, 10);
  });

  it('prices cache reads and 5-minute and 1-hour cache writes apart', () => {
    // Opus 5.5: read $0.20, write 5m $5, write 1h $8
    const cost = priceCall(
      'claude-opus-5-5',
      usage({ cacheReadTokens: 1_000_000, cacheWriteTokens: 2_000_000, cacheWrite1hTokens: 1_000_000 })
    );
    expect(cost).toBeCloseTo(0.2 + 5 + 8, 10);
  });

  it('prices OpenAI cached input at the cached rate', () => {
    expect(priceCall('gpt-5.6-terra', usage({ cacheReadTokens: 1_000_000 }))).toBeCloseTo(0.2, 10);
  });

  it('switches Haiku 5.5 to the long-context rate above 100K prompt tokens', () => {
    const short = priceCall('claude-haiku-5-5', usage({ inputTokens: 100_000, outputTokens: 1_000 }));
    expect(short).toBeCloseTo((100_000 * 0.1 + 1_000 * 0.5) / 1e6, 12);
    const long = priceCall(
      'claude-haiku-5-5',
      usage({ inputTokens: 90_000, cacheReadTokens: 20_000, outputTokens: 1_000 })
    );
    // 110K prompt tokens: every rate 5x, on the whole request
    expect(long).toBeCloseTo((90_000 * 0.5 + 20_000 * 0.05 + 1_000 * 2.5) / 1e6, 12);
  });

  it('prices image tokens apart from text tokens', () => {
    const cost = priceCall(
      'gpt-image-2.5-sunburst',
      usage({ inputTokens: 1_000_000, imageInputTokens: 1_000_000, outputTokens: 1_000_000 })
    );
    expect(cost).toBeCloseTo(5 + 8 + 30, 10);
  });

  it('costs nothing for an unknown model', () => {
    expect(priceCall('nope', usage({ inputTokens: 1_000_000 }))).toBe(0);
  });
});

describe('modelInfo', () => {
  it('finds a dated snapshot by its catalogue id', () => {
    expect(modelInfo('claude-sonnet-5-5-20260901')?.label).toBe('Claude Sonnet 5.5');
    // the longest matching id wins: Opus 5.5, not Opus 5
    expect(modelInfo('claude-opus-5-5')?.label).toBe('Claude Opus 5.5');
  });
});

describe('catalogue', () => {
  it('gives every model a provider, a kind and a positive output price', () => {
    for (const [id, info] of Object.entries(MODELS)) {
      expect(['openai', 'anthropic'], id).toContain(info.provider);
      expect(['text', 'image', 'speech'], id).toContain(info.kind);
      expect(info.price.output, id).toBeGreaterThan(0);
    }
  });

  it('carries the Anthropic monthly credit', () => {
    expect(PROVIDERS.anthropic.monthlyCredit).toEqual({ amount: 200, currency: 'EUR' });
  });
});
