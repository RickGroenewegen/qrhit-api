/**
 * OpenAI adapter: chat completions (structured output, text, streams, vision),
 * image generation and edits, and text to speech.
 *
 * It sends exactly the request shapes the codebase used before the layer
 * existed, so an OpenAI route behaves as it always did. The GPT-5.6 rules
 * (verified 2026-09-16):
 *   - temperature other than 1 is a 400 unless reasoning_effort is 'none',
 *     so it is only sent with 'none';
 *   - function tools are a 400 with reasoning on, so structured output is
 *     `response_format: { type: 'json_schema' }` read from message.content;
 *   - `max_tokens` is rejected; `max_completion_tokens` is the name.
 */
import OpenAI from 'openai';
import { modelInfo } from '../models';
import type {
  LlmImageRequest,
  LlmProvider,
  LlmSpeechRequest,
  LlmUsage,
  NormalizedRequest,
  ProviderBinaryResponse,
  ProviderCallOptions,
  ProviderStopReason,
  ProviderTextResponse,
} from '../types';

/**
 * gpt-4o-mini-tts reports no usage. OpenAI's own estimate is $0.015 a minute,
 * which at $12 per 1M audio tokens is about 1,250 tokens a minute, or roughly
 * 1.4 tokens per character of English speech (~900 characters a minute).
 */
const SPEECH_AUDIO_TOKENS_PER_CHAR = 1.4;

function chatUsage(usage: any): LlmUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

function stopReasonOf(choice: any): ProviderStopReason {
  if (choice?.finish_reason === 'length') return 'max_tokens';
  if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) {
    return 'refusal';
  }
  return 'end';
}

export class OpenAIProvider implements LlmProvider {
  readonly id = 'openai' as const;
  private client: OpenAI | null = null;

  private apiKey(): string | undefined {
    return process.env['OPENAI_API_KEY'] || process.env['OPENAI_TOKEN'];
  }

  isAvailable(): boolean {
    return !!this.apiKey();
  }

  private getClient(): OpenAI {
    if (!this.client) this.client = new OpenAI({ apiKey: this.apiKey() });
    return this.client;
  }

  private requestOptions(opts: ProviderCallOptions) {
    return { timeout: opts.timeoutMs, maxRetries: opts.maxRetries };
  }

  private chatBody(req: NormalizedRequest, opts: ProviderCallOptions): any {
    const { model, effort } = opts.route;
    const messages: any[] = [];
    const system = req.system.map((block) => block.text).join('');
    if (system) messages.push({ role: 'system', content: system });
    for (const message of req.messages) {
      messages.push({
        role: message.role,
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) =>
                part.type === 'text'
                  ? { type: 'text', text: part.text }
                  : {
                      type: 'image_url',
                      image_url: { url: part.dataUri, detail: part.detail ?? 'low' },
                    }
              ),
      });
    }

    const body: any = { model, messages };
    if (effort) body.reasoning_effort = effort;
    if (req.temperature !== undefined) {
      const reasoningOff = !effort || effort === 'none';
      if (reasoningOff || !modelInfo(model)?.temperatureWithoutReasoningOnly) {
        body.temperature = req.temperature;
      }
    }
    if (req.schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: req.schema.name,
          ...(req.schema.description ? { description: req.schema.description } : {}),
          schema: req.schema.schema,
        },
      };
    }
    return body;
  }

  async complete(
    req: NormalizedRequest,
    opts: ProviderCallOptions
  ): Promise<ProviderTextResponse> {
    const response: any = await this.getClient().chat.completions.create(
      this.chatBody(req, opts),
      this.requestOptions(opts)
    );
    const choice = response?.choices?.[0];
    return {
      text: choice?.message?.content ?? '',
      stopReason: stopReasonOf(choice),
      parts: [{ model: opts.route.model, usage: chatUsage(response?.usage) }],
    };
  }

  async stream(
    req: NormalizedRequest,
    opts: ProviderCallOptions,
    onToken: (token: string) => void
  ): Promise<ProviderTextResponse> {
    const stream: any = await this.getClient().chat.completions.create(
      {
        ...this.chatBody(req, opts),
        stream: true,
        stream_options: { include_usage: true },
      },
      this.requestOptions(opts)
    );
    let text = '';
    let usage: any = null;
    let stopReason: ProviderStopReason = 'end';
    for await (const chunk of stream) {
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        text += delta;
        onToken(delta);
      }
      if (choice?.finish_reason) stopReason = stopReasonOf(choice);
      if (chunk?.usage) usage = chunk.usage;
    }
    return {
      text,
      stopReason,
      parts: [{ model: opts.route.model, usage: chatUsage(usage) }],
    };
  }

  async image(
    req: LlmImageRequest,
    opts: ProviderCallOptions
  ): Promise<ProviderBinaryResponse> {
    const client = this.getClient();
    const model = opts.route.model;
    const response: any = req.images?.length
      ? await client.images.edit(
          {
            image: req.images.map(
              (image) =>
                new File([new Uint8Array(image.data)], image.filename, {
                  type: image.mimeType,
                })
            ) as any,
            prompt: req.prompt,
            n: 1,
            model,
            size: req.size as any,
            quality: req.quality,
          },
          this.requestOptions(opts)
        )
      : await client.images.generate(
          {
            model,
            prompt: req.prompt,
            n: 1,
            size: req.size as any,
            quality: req.quality,
          },
          this.requestOptions(opts)
        );

    const b64 = response?.data?.[0]?.b64_json;
    const usage = response?.usage;
    const details = usage?.input_tokens_details;
    return {
      data: b64 ? Buffer.from(b64, 'base64') : null,
      parts: [
        {
          model,
          usage: {
            inputTokens: details ? details.text_tokens ?? 0 : usage?.input_tokens ?? 0,
            imageInputTokens: details?.image_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          estimated: !usage,
        },
      ],
    };
  }

  async speech(
    req: LlmSpeechRequest,
    opts: ProviderCallOptions
  ): Promise<ProviderBinaryResponse> {
    const audio: any = await this.getClient().audio.speech.create(
      {
        model: opts.route.model,
        voice: req.voice as any,
        input: req.text,
        instructions: req.instructions || '',
      },
      this.requestOptions(opts)
    );
    const data = Buffer.from(await audio.arrayBuffer());
    return {
      data,
      parts: [
        {
          model: opts.route.model,
          usage: {
            inputTokens: Math.ceil(req.text.length / 4),
            outputTokens: Math.round(req.text.length * SPEECH_AUDIO_TOKENS_PER_CHAR),
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          estimated: true,
        },
      ],
    };
  }
}
