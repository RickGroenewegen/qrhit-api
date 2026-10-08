/**
 * Provider-neutral types for the LLM layer. Nothing in here knows about a
 * particular SDK: the adapters in ./providers translate to and from these.
 */

export type LlmProviderId = 'openai' | 'anthropic';

/**
 * How hard the model thinks. 'none' means thinking off where the model allows
 * it (OpenAI reasoning_effort 'none', Claude Haiku `disabled`, Claude Sonnet
 * `between_tools`) and the lowest effort where it does not (Claude Opus).
 */
export type LlmEffort = 'none' | 'low' | 'medium' | 'high';

export type LlmKind = 'text' | 'image' | 'speech';

export interface LlmRoute {
  provider: LlmProviderId;
  model: string;
  /** Text routes only. */
  effort?: LlmEffort;
}

export interface LlmTaskConfig {
  kind: LlmKind;
  /** Shown on the admin AI costs page. */
  label: string;
  description: string;
  primary: LlmRoute;
  /** Tried once when the primary fails for any reason but a bug of ours. */
  fallback?: LlmRoute;
  /** Required by Anthropic, thinking included. Default 16000. */
  maxOutputTokens?: number;
  /** Per attempt. Default 120 s. */
  timeoutMs?: number;
  /** SDK retries per attempt. Default 1. */
  maxRetries?: number;
}

export interface LlmTextPart {
  type: 'text';
  text: string;
}

export interface LlmImagePart {
  type: 'image';
  /** data:image/<png|jpeg|gif|webp>;base64,... */
  dataUri: string;
  /** OpenAI only; Anthropic has no equivalent. Default 'low'. */
  detail?: 'low' | 'high' | 'auto';
}

export type LlmContent = string | Array<LlmTextPart | LlmImagePart>;

export interface LlmMessage {
  /** Leading 'system' messages become the system prompt. */
  role: 'system' | 'user' | 'assistant';
  content: LlmContent;
}

export interface LlmSystemBlock {
  text: string;
  /** Anthropic prompt caching. OpenAI caches long prefixes on its own. */
  cache?: '5m' | '1h';
}

export interface LlmSchema {
  /** OpenAI's json_schema name; Anthropic has none. */
  name: string;
  description?: string;
  schema: Record<string, unknown>;
}

export interface LlmRequest {
  system?: string | LlmSystemBlock[];
  messages: LlmMessage[];
  schema?: LlmSchema;
  /** A hint: sent only where the model accepts it (OpenAI with effort 'none'). */
  temperature?: number;
  /** Overrides the task's maxOutputTokens. */
  maxOutputTokens?: number;
}

export interface LlmImageInput {
  data: Buffer;
  filename: string;
  mimeType: string;
}

export interface LlmImageRequest {
  prompt: string;
  /** Present: an edit of these images. Absent: generation from the prompt. */
  images?: LlmImageInput[];
  size: string;
  quality: 'low' | 'medium' | 'high';
}

export interface LlmSpeechRequest {
  text: string;
  voice: string;
  instructions?: string;
}

/** Tokens as the provider reported them, split the way they are priced. */
export interface LlmUsage {
  /** Uncached text input. */
  inputTokens: number;
  outputTokens: number;
  /** Cache reads (Anthropic) or cached input (OpenAI). */
  cacheReadTokens: number;
  /** All cache writes, the 1-hour ones included. */
  cacheWriteTokens: number;
  /** The part of cacheWriteTokens written with a 1-hour lifetime. */
  cacheWrite1hTokens?: number;
  /** Image input tokens (image models), priced apart from text. */
  imageInputTokens?: number;
}

export type LlmAttemptStatus =
  | 'ok'
  | 'error'
  | 'refusal'
  | 'truncated'
  | 'unparseable'
  | 'empty'
  | 'unavailable';

/** One model run: one row in the llm_calls ledger. */
export interface LlmAttempt {
  provider: LlmProviderId;
  model: string;
  /** 'fallback' for our own fallback route and for Anthropic's server-side one. */
  role: 'primary' | 'fallback';
  status: LlmAttemptStatus;
  usage: LlmUsage;
  costUsd: number;
  /** The cost is an estimate (speech: the API reports no usage). */
  estimated: boolean;
  durationMs: number;
  error?: string;
}

export interface LlmResult<T> {
  data: T;
  /** The provider and model whose answer this is. */
  provider: LlmProviderId;
  model: string;
  /** Every attempt added up, failed ones included. */
  usage: LlmUsage;
  costUsd: number;
  durationMs: number;
  fellBack: boolean;
  attempts: LlmAttempt[];
  /** Streams only: set when the answer stopped early ('refusal', 'truncated'). */
  stopReason?: string;
}

export const ZERO_USAGE: LlmUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}) as LlmUsage;

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheWrite1hTokens: (a.cacheWrite1hTokens ?? 0) + (b.cacheWrite1hTokens ?? 0),
    imageInputTokens: (a.imageInputTokens ?? 0) + (b.imageInputTokens ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

/** The request after the layer has split off the system prompt. */
export interface NormalizedRequest {
  system: LlmSystemBlock[];
  messages: Array<{ role: 'user' | 'assistant'; content: LlmContent }>;
  schema?: LlmSchema;
  temperature?: number;
}

export interface ProviderCallOptions {
  route: LlmRoute;
  maxOutputTokens: number;
  timeoutMs: number;
  maxRetries: number;
}

/** One billed model run inside a response. */
export interface UsagePart {
  model: string;
  usage: LlmUsage;
  /** Anthropic's server-side fallback ran this part. */
  serverFallback?: boolean;
  /** This part ended in a refusal that a later part took over. */
  refused?: boolean;
  estimated?: boolean;
}

export type ProviderStopReason = 'end' | 'max_tokens' | 'refusal' | 'other';

export interface ProviderTextResponse {
  text: string;
  stopReason: ProviderStopReason;
  parts: UsagePart[];
}

export interface ProviderBinaryResponse {
  data: Buffer | null;
  parts: UsagePart[];
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  isAvailable(): boolean;
  complete?(
    req: NormalizedRequest,
    opts: ProviderCallOptions
  ): Promise<ProviderTextResponse>;
  stream?(
    req: NormalizedRequest,
    opts: ProviderCallOptions,
    onToken: (token: string) => void
  ): Promise<ProviderTextResponse>;
  image?(
    req: LlmImageRequest,
    opts: ProviderCallOptions
  ): Promise<ProviderBinaryResponse>;
  speech?(
    req: LlmSpeechRequest,
    opts: ProviderCallOptions
  ): Promise<ProviderBinaryResponse>;
}
