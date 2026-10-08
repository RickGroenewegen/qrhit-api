/**
 * Anthropic adapter: structured output, text and streams on the Claude 5.5
 * models. The rules it follows, all of which are a 400 otherwise:
 *   - no temperature / top_p / top_k (5.5 models accept only the defaults);
 *   - no assistant prefill: the last message must be a user turn;
 *   - thinking per model (see models.ts): 'none' effort becomes Haiku's
 *     `disabled`, Sonnet's `between_tools`, or Opus at effort low;
 *   - every object in a structured-output schema needs
 *     `additionalProperties: false` (schema.ts);
 *   - `max_tokens` is required and counts the thinking too.
 *
 * Every request streams and waits for the final message, so a long answer
 * never runs into the SDK's timeout for non-streamed calls. Opus and Sonnet
 * ask for the server-side refusal fallback (`fallbacks: 'default'`): a false
 * refusal is retried on an older model inside the same call, and its tokens
 * are recorded as a fallback row. Streams don't, because the second model
 * would continue an answer the customer is already reading.
 */
import Anthropic from '@anthropic-ai/sdk';
import { LlmRequestError } from '../errors';
import { modelInfo } from '../models';
import { toAnthropicSchema } from '../schema';
import type {
  LlmEffort,
  LlmImagePart,
  LlmProvider,
  LlmUsage,
  NormalizedRequest,
  ProviderCallOptions,
  ProviderStopReason,
  ProviderTextResponse,
  UsagePart,
} from '../types';

const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function imageBlock(part: LlmImagePart) {
  const match = /^data:([a-z/+.-]+);base64,(.+)$/is.exec(part.dataUri);
  const mediaType = match?.[1]?.toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!match || !mediaType || !IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw new LlmRequestError('image parts must be png, jpeg, gif or webp data URIs');
  }
  return {
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: mediaType, data: match[2] },
  };
}

function toMessages(req: NormalizedRequest): any[] {
  const out: any[] = [];
  for (const message of req.messages) {
    if (typeof message.content === 'string') {
      if (!message.content.trim()) continue;
      out.push({ role: message.role, content: message.content });
      continue;
    }
    const blocks = message.content
      .filter((part) => part.type !== 'text' || part.text.trim())
      .map((part) =>
        part.type === 'text' ? { type: 'text' as const, text: part.text } : imageBlock(part)
      );
    if (blocks.length > 0) out.push({ role: message.role, content: blocks });
  }
  if (out.length === 0) throw new LlmRequestError('a request needs a user message');
  // A conversation may open with an admin's reply; the API wants a user turn first.
  if (out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '(The conversation so far.)' });
  }
  if (out[out.length - 1].role !== 'user') {
    throw new LlmRequestError('the last message must be a user turn (no prefill)');
  }
  return out;
}

function effortConfig(
  model: string,
  effort: LlmEffort
): { effort: 'low' | 'medium' | 'high'; thinking?: { type: 'disabled' | 'between_tools' } } {
  if (effort !== 'none') return { effort };
  const thinkingOff = modelInfo(model)?.thinkingOff;
  if (thinkingOff) return { effort: 'low', thinking: { type: thinkingOff } };
  return { effort: 'low' };
}

function stopReasonOf(reason: string | null | undefined): ProviderStopReason {
  if (reason === 'refusal') return 'refusal';
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'end';
  return 'other';
}

function partUsage(u: any): LlmUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
    cacheWrite1hTokens: u?.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  };
}

/**
 * The billed runs of one response. With a server-side fallback the response
 * lists each model's run in `usage.iterations`; every run but the last ended
 * in the refusal the next one took over.
 */
function usageParts(message: any, requestedModel: string): UsagePart[] {
  const iterations: any[] = (message?.usage?.iterations ?? []).filter(
    (it: any) => it?.type === 'message' || it?.type === 'fallback_message'
  );
  if (iterations.length === 0) {
    return [{ model: message?.model ?? requestedModel, usage: partUsage(message?.usage) }];
  }
  const fellBack = iterations.some((it) => it.type === 'fallback_message');
  return iterations.map((it, index) => ({
    model: it.model ?? requestedModel,
    usage: partUsage(it),
    serverFallback: it.type === 'fallback_message',
    refused: fellBack && index < iterations.length - 1,
  }));
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  private client: Anthropic | null = null;

  isAvailable(): boolean {
    return !!process.env['ANTHROPIC_API_KEY'];
  }

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });
    }
    return this.client;
  }

  /** The request body; exported through the class for the adapter tests. */
  buildBody(req: NormalizedRequest, opts: ProviderCallOptions, streaming: boolean): any {
    const { model } = opts.route;
    const { effort, thinking } = effortConfig(model, opts.route.effort ?? 'medium');
    const body: any = {
      model,
      max_tokens: opts.maxOutputTokens,
      messages: toMessages(req),
      output_config: {
        effort,
        ...(req.schema
          ? {
              format: {
                type: 'json_schema',
                schema: toAnthropicSchema(req.schema.schema, req.schema.description),
              },
            }
          : {}),
      },
    };
    const system = req.system.filter((block) => block.text);
    if (system.length > 0) {
      body.system = system.map((block) => ({
        type: 'text',
        text: block.text,
        ...(block.cache
          ? {
              cache_control:
                block.cache === '1h'
                  ? { type: 'ephemeral', ttl: '1h' }
                  : { type: 'ephemeral' },
            }
          : {}),
      }));
    }
    if (thinking) body.thinking = thinking;
    if (!streaming && modelInfo(model)?.serverFallback) {
      body.betas = [SERVER_FALLBACK_BETA];
      body.fallbacks = 'default';
    }
    return body;
  }

  private async run(
    req: NormalizedRequest,
    opts: ProviderCallOptions,
    onToken?: (token: string) => void
  ): Promise<ProviderTextResponse> {
    const stream = this.getClient().beta.messages.stream(
      this.buildBody(req, opts, !!onToken),
      { timeout: opts.timeoutMs, maxRetries: opts.maxRetries }
    );
    if (onToken) stream.on('text', (delta: string) => onToken(delta));
    const message: any = await stream.finalMessage();
    const text = (message?.content ?? [])
      .filter((block: any) => block?.type === 'text')
      .map((block: any) => block.text)
      .join('');
    return {
      text,
      stopReason: stopReasonOf(message?.stop_reason),
      parts: usageParts(message, opts.route.model),
    };
  }

  complete(req: NormalizedRequest, opts: ProviderCallOptions): Promise<ProviderTextResponse> {
    return this.run(req, opts);
  }

  stream(
    req: NormalizedRequest,
    opts: ProviderCallOptions,
    onToken: (token: string) => void
  ): Promise<ProviderTextResponse> {
    return this.run(req, opts, onToken);
  }
}
