/**
 * Every model the layer can use, with its price and what it accepts. This is
 * the only place a price lives: the cost of each call is worked out here once,
 * when the call happens, and stored with it in the llm_calls ledger. A price
 * change therefore applies from the moment it is edited and never rewrites
 * history.
 *
 * Prices are USD per 1M tokens. Sources, read 2026-10-08:
 *   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
 *   OpenAI     https://developers.openai.com/api/docs/pricing
 *              (gpt-5.6-sol's price is promotional, "at least through
 *              November 21, 2026"; check it then)
 *
 * Thinking on the Claude 5.5 models, which decides how the 'none' effort is
 * sent (see providers/anthropic.ts):
 *   Opus 5.5    always on; `disabled` is a 400 at every effort
 *   Sonnet 5.5  `disabled` is a 400; `between_tools` turns it off (effort <= high)
 *   Haiku 5.5   `disabled` allowed at effort <= high
 */
import type { LlmKind, LlmProviderId, LlmUsage } from './types';

export interface ModelPrice {
  input: number;
  output: number;
  /** Anthropic cache reads, OpenAI cached input. Default: input. */
  cachedInput?: number;
  /** Anthropic cache writes. Default: input. */
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  /** Image models: image input tokens. Text input is `input`. */
  imageInput?: number;
}

export interface ModelInfo {
  provider: LlmProviderId;
  kind: LlmKind;
  /** Shown on the admin page. */
  label: string;
  price: ModelPrice;
  /**
   * A dearer rate card for long prompts (Claude Haiku 5.5: above 100K prompt
   * tokens every rate is 5x, on the whole request).
   */
  longContext?: { thresholdTokens: number; price: ModelPrice };
  /** Anthropic: how thinking is turned off ('none' effort). null: it can't be. */
  thinkingOff?: 'disabled' | 'between_tools' | null;
  /** Anthropic server-side refusal fallback (`fallbacks: 'default'`). */
  serverFallback?: boolean;
  /** OpenAI GPT-5.6: temperature other than 1 only with reasoning 'none'. */
  temperatureWithoutReasoningOnly?: boolean;
  vision?: boolean;
  /** Kept to price old rows; not used by a task. */
  retired?: boolean;
}

export const MODELS = {
  // Anthropic -----------------------------------------------------------------
  'claude-opus-5-5': {
    provider: 'anthropic',
    kind: 'text',
    label: 'Claude Opus 5.5',
    price: { input: 4, output: 20, cachedInput: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
    thinkingOff: null,
    serverFallback: true,
    vision: true,
  },
  'claude-sonnet-5-5': {
    provider: 'anthropic',
    kind: 'text',
    label: 'Claude Sonnet 5.5',
    price: { input: 2, output: 10, cachedInput: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 },
    thinkingOff: 'between_tools',
    serverFallback: true,
    vision: true,
  },
  'claude-haiku-5-5': {
    provider: 'anthropic',
    kind: 'text',
    label: 'Claude Haiku 5.5',
    price: { input: 0.1, output: 0.5, cachedInput: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
    longContext: {
      thresholdTokens: 100_000,
      price: { input: 0.5, output: 2.5, cachedInput: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 },
    },
    thinkingOff: 'disabled',
    serverFallback: false,
    vision: true,
  },
  // Server-side fallback targets: their tokens are billed when Opus or Sonnet
  // 5.5 hands a refused request over to them.
  'claude-opus-5': {
    provider: 'anthropic',
    kind: 'text',
    label: 'Claude Opus 5',
    price: { input: 5, output: 25, cachedInput: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    retired: true,
  },
  'claude-opus-4-8': {
    provider: 'anthropic',
    kind: 'text',
    label: 'Claude Opus 4.8',
    price: { input: 5, output: 25, cachedInput: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    retired: true,
  },
  'claude-sonnet-5': {
    provider: 'anthropic',
    kind: 'text',
    label: 'Claude Sonnet 5',
    price: { input: 2, output: 10, cachedInput: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
    retired: true,
  },

  // OpenAI --------------------------------------------------------------------
  'gpt-5.6-sol': {
    provider: 'openai',
    kind: 'text',
    label: 'GPT-5.6 Sol',
    price: { input: 4, output: 20, cachedInput: 0.4 },
    temperatureWithoutReasoningOnly: true,
    vision: true,
  },
  'gpt-5.6-terra': {
    provider: 'openai',
    kind: 'text',
    label: 'GPT-5.6 Terra',
    price: { input: 2, output: 12, cachedInput: 0.2 },
    temperatureWithoutReasoningOnly: true,
    vision: true,
  },
  'gpt-5.6-luna': {
    provider: 'openai',
    kind: 'text',
    label: 'GPT-5.6 Luna',
    price: { input: 0.2, output: 1.2, cachedInput: 0.02 },
    temperatureWithoutReasoningOnly: true,
    vision: true,
  },
  'gpt-5.4-mini': {
    provider: 'openai',
    kind: 'text',
    label: 'GPT-5.4 mini',
    price: { input: 0.75, output: 4.5 },
    retired: true,
  },
  // Sunburst is tuned for edit precision, which the product photo and card
  // artwork flows need; flare is the faster sibling at the same price.
  'gpt-image-2.5-sunburst': {
    provider: 'openai',
    kind: 'image',
    label: 'GPT Image 2.5 Sunburst',
    price: { input: 5, cachedInput: 1.25, imageInput: 8, output: 30 },
  },
  // Text in, audio out. The speech API reports no usage, so a call is priced
  // from its text length (see providers/openai.ts) and marked estimated.
  'gpt-4o-mini-tts': {
    provider: 'openai',
    kind: 'speech',
    label: 'GPT-4o mini TTS',
    price: { input: 0.6, output: 12 },
  },
} as const satisfies Record<string, ModelInfo>;

export type ModelId = keyof typeof MODELS;

export interface ProviderInfo {
  label: string;
  /** Free credit per month, shown on the admin page against the spend. */
  monthlyCredit?: { amount: number; currency: 'EUR' | 'USD' };
}

export const PROVIDERS: Record<LlmProviderId, ProviderInfo> = {
  anthropic: { label: 'Anthropic', monthlyCredit: { amount: 200, currency: 'EUR' } },
  openai: { label: 'OpenAI' },
};

/**
 * Looks a model up by id. A response can name a dated snapshot
 * ("claude-sonnet-5-5-20260901"), so the longest catalogue id it starts with
 * wins.
 */
export function modelInfo(model: string): ModelInfo | undefined {
  const exact = (MODELS as Record<string, ModelInfo>)[model];
  if (exact) return exact;
  let best: string | undefined;
  for (const id of Object.keys(MODELS)) {
    if (model.startsWith(id) && (!best || id.length > best.length)) best = id;
  }
  return best ? (MODELS as Record<string, ModelInfo>)[best] : undefined;
}

/** Prompt tokens as the long-context threshold counts them. */
export function promptTokens(usage: LlmUsage): number {
  return (
    usage.inputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens +
    (usage.imageInputTokens ?? 0)
  );
}

/** The rate card that applies to this usage. */
export function priceFor(model: string, usage: LlmUsage): ModelPrice | undefined {
  const info = modelInfo(model);
  if (!info) return undefined;
  if (info.longContext && promptTokens(usage) > info.longContext.thresholdTokens) {
    return info.longContext.price;
  }
  return info.price;
}

/**
 * The cost in USD of one model run. The only cost function: everything that
 * shows or stores a cost goes through here. An unknown model costs 0.
 */
export function priceCall(model: string, usage: LlmUsage): number {
  const p = priceFor(model, usage);
  if (!p) return 0;
  const write1h = usage.cacheWrite1hTokens ?? 0;
  const write5m = Math.max(0, usage.cacheWriteTokens - write1h);
  const perMillion =
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheReadTokens * (p.cachedInput ?? p.input) +
    write5m * (p.cacheWrite5m ?? p.input) +
    write1h * (p.cacheWrite1h ?? p.input) +
    (usage.imageInputTokens ?? 0) * (p.imageInput ?? p.input);
  return perMillion / 1_000_000;
}
