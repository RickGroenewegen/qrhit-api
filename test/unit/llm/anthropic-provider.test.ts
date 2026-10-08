import { describe, it, expect, vi, beforeEach } from 'vitest';

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class AnthropicMock {
    beta = { messages: { stream: streamMock } };
  },
}));

import { AnthropicProvider } from '../../../src/llm/providers/anthropic';
import { LlmRequestError } from '../../../src/llm/errors';
import type { NormalizedRequest, ProviderCallOptions } from '../../../src/llm/types';

const opts = (model: string, effort?: any): ProviderCallOptions => ({
  route: { provider: 'anthropic', model, effort },
  maxOutputTokens: 16000,
  timeoutMs: 1000,
  maxRetries: 0,
});

const request = (over: Partial<NormalizedRequest> = {}): NormalizedRequest => ({
  system: [{ text: 'You are helpful.' }],
  messages: [{ role: 'user', content: 'Hi' }],
  ...over,
});

/** A fake MessageStream: `on('text')` handlers get the deltas, then finalMessage resolves. */
function fakeStream(message: any, deltas: string[] = []) {
  const handlers: Array<(d: string) => void> = [];
  return {
    on(event: string, handler: (d: string) => void) {
      if (event === 'text') handlers.push(handler);
      return this;
    },
    async finalMessage() {
      for (const d of deltas) handlers.forEach((h) => h(d));
      return message;
    },
  };
}

const message = (over: any = {}) => ({
  model: 'claude-sonnet-5-5',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: '{"ok":true}' }],
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...over,
});

beforeEach(() => streamMock.mockReset());

describe('AnthropicProvider.buildBody', () => {
  const provider = new AnthropicProvider();

  it('turns thinking off the way each model allows for effort none', () => {
    const haiku = provider.buildBody(request(), opts('claude-haiku-5-5', 'none'), false);
    expect(haiku.thinking).toEqual({ type: 'disabled' });
    expect(haiku.output_config.effort).toBe('low');

    const sonnet = provider.buildBody(request(), opts('claude-sonnet-5-5', 'none'), false);
    expect(sonnet.thinking).toEqual({ type: 'between_tools' });
    expect(sonnet.output_config.effort).toBe('low');

    // Opus 5.5 cannot turn thinking off: the lowest effort instead
    const opus = provider.buildBody(request(), opts('claude-opus-5-5', 'none'), false);
    expect(opus.thinking).toBeUndefined();
    expect(opus.output_config.effort).toBe('low');
  });

  it('leaves thinking adaptive and passes the effort on otherwise', () => {
    const body = provider.buildBody(request(), opts('claude-sonnet-5-5', 'medium'), false);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body.max_tokens).toBe(16000);
  });

  it('asks Opus and Sonnet for the server-side fallback, never Haiku or a stream', () => {
    expect(provider.buildBody(request(), opts('claude-opus-5-5', 'low'), false)).toMatchObject({
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(provider.buildBody(request(), opts('claude-haiku-5-5', 'low'), false).fallbacks).toBeUndefined();
    expect(provider.buildBody(request(), opts('claude-sonnet-5-5', 'low'), true).fallbacks).toBeUndefined();
  });

  it('sends the schema normalised as structured output and never a temperature', () => {
    const body = provider.buildBody(
      request({
        temperature: 0.3,
        schema: {
          name: 'x',
          description: 'Split',
          schema: {
            type: 'object',
            properties: { y: { type: ['integer', 'null'] } },
            required: ['y'],
          },
        },
      }),
      opts('claude-haiku-5-5', 'low'),
      false
    );
    expect(body.temperature).toBeUndefined();
    expect(body.output_config.format).toEqual({
      type: 'json_schema',
      schema: {
        type: 'object',
        description: 'Split',
        properties: { y: { anyOf: [{ type: 'integer' }, { type: 'null' }] } },
        required: ['y'],
        additionalProperties: false,
      },
    });
  });

  it('marks cached system blocks', () => {
    const body = provider.buildBody(
      request({ system: [{ text: 'catalogue', cache: '5m' }, { text: 'rules', cache: '1h' }, { text: 'tail' }] }),
      opts('claude-haiku-5-5', 'low'),
      false
    );
    expect(body.system).toEqual([
      { type: 'text', text: 'catalogue', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'rules', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'tail' },
    ]);
  });

  it('opens with a user turn, drops empty messages and refuses a trailing assistant turn', () => {
    const body = provider.buildBody(
      request({
        messages: [
          { role: 'assistant', content: 'Hi, how can I help?' },
          { role: 'user', content: '  ' },
          { role: 'user', content: 'Where is my order?' },
        ],
      }),
      opts('claude-sonnet-5-5', 'low'),
      true
    );
    expect(body.messages).toEqual([
      { role: 'user', content: '(The conversation so far.)' },
      { role: 'assistant', content: 'Hi, how can I help?' },
      { role: 'user', content: 'Where is my order?' },
    ]);
    expect(() =>
      provider.buildBody(
        request({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }),
        opts('claude-sonnet-5-5', 'low'),
        false
      )
    ).toThrow(LlmRequestError);
  });

  it('sends images as base64 blocks with the media type of the data URI', () => {
    const body = provider.buildBody(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Theme' },
              { type: 'image', dataUri: 'data:image/jpg;base64,QUJD' },
            ],
          },
        ],
      }),
      opts('claude-opus-5-5', 'low'),
      false
    );
    expect(body.messages[0].content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' },
    });
    expect(() =>
      provider.buildBody(
        request({ messages: [{ role: 'user', content: [{ type: 'image', dataUri: 'data:image/tiff;base64,AA' }] }] }),
        opts('claude-opus-5-5', 'low'),
        false
      )
    ).toThrow(LlmRequestError);
  });
});

describe('AnthropicProvider.complete', () => {
  it('reads only text blocks and maps usage, cache tokens included', async () => {
    streamMock.mockReturnValueOnce(
      fakeStream(
        message({
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: '{"a":' },
            { type: 'text', text: '1}' },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 300,
            cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
          },
        })
      )
    );
    const res = await new AnthropicProvider().complete(request(), opts('claude-sonnet-5-5', 'low'));
    expect(res.text).toBe('{"a":1}');
    expect(res.stopReason).toBe('end');
    expect(res.parts).toEqual([
      {
        model: 'claude-sonnet-5-5',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 5000,
          cacheWriteTokens: 300,
          cacheWrite1hTokens: 0,
        },
      },
    ]);
    expect(streamMock.mock.calls[0][1]).toEqual({ timeout: 1000, maxRetries: 0 });
  });

  it('maps refusal and max_tokens stops', async () => {
    streamMock
      .mockReturnValueOnce(fakeStream(message({ stop_reason: 'refusal', content: [] })))
      .mockReturnValueOnce(fakeStream(message({ stop_reason: 'max_tokens' })));
    const provider = new AnthropicProvider();
    expect((await provider.complete(request(), opts('claude-opus-5-5', 'low'))).stopReason).toBe('refusal');
    expect((await provider.complete(request(), opts('claude-opus-5-5', 'low'))).stopReason).toBe('max_tokens');
  });

  it('splits a server-side fallback into the refused run and the run that answered', async () => {
    streamMock.mockReturnValueOnce(
      fakeStream(
        message({
          model: 'claude-opus-5',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            iterations: [
              { type: 'message', model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            ],
          },
        })
      )
    );
    const res = await new AnthropicProvider().complete(request(), opts('claude-opus-5-5', 'low'));
    expect(res.parts.map((p) => [p.model, !!p.serverFallback, !!p.refused])).toEqual([
      ['claude-opus-5-5', false, true],
      ['claude-opus-5', true, false],
    ]);
  });
});

describe('AnthropicProvider.stream', () => {
  it('passes text deltas on as they arrive', async () => {
    streamMock.mockReturnValueOnce(
      fakeStream(message({ content: [{ type: 'text', text: 'Hello' }] }), ['Hel', 'lo'])
    );
    const tokens: string[] = [];
    const res = await new AnthropicProvider().stream(request(), opts('claude-sonnet-5-5', 'low'), (t) =>
      tokens.push(t)
    );
    expect(tokens).toEqual(['Hel', 'lo']);
    expect(res.text).toBe('Hello');
    expect(streamMock.mock.calls[0][0].fallbacks).toBeUndefined();
  });
});

describe('AnthropicProvider.isAvailable', () => {
  it('needs ANTHROPIC_API_KEY', () => {
    const key = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    expect(new AnthropicProvider().isAvailable()).toBe(false);
    process.env['ANTHROPIC_API_KEY'] = 'x';
    expect(new AnthropicProvider().isAvailable()).toBe(true);
    if (key === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = key;
  });
});
