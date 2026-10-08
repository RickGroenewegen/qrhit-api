import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createMock, imagesEditMock, imagesGenerateMock, speechMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  imagesEditMock: vi.fn(),
  imagesGenerateMock: vi.fn(),
  speechMock: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class OpenAIMock {
    chat = { completions: { create: createMock } };
    images = { edit: imagesEditMock, generate: imagesGenerateMock };
    audio = { speech: { create: speechMock } };
  },
}));

import { OpenAIProvider } from '../../../src/llm/providers/openai';
import type { NormalizedRequest, ProviderCallOptions } from '../../../src/llm/types';

const opts = (model = 'gpt-5.6-terra', effort?: any): ProviderCallOptions => ({
  route: { provider: 'openai', model, effort },
  maxOutputTokens: 16000,
  timeoutMs: 1000,
  maxRetries: 0,
});

const request = (over: Partial<NormalizedRequest> = {}): NormalizedRequest => ({
  system: [{ text: 'You are helpful.' }],
  messages: [{ role: 'user', content: 'Hi' }],
  ...over,
});

beforeEach(() => {
  createMock.mockReset();
  imagesEditMock.mockReset();
  imagesGenerateMock.mockReset();
  speechMock.mockReset();
});

describe('OpenAIProvider.complete', () => {
  it('sends the structured-output request shape the codebase always used', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } },
    });
    const res = await new OpenAIProvider().complete(
      request({ schema: { name: 'parseYear', description: 'Years', schema: { type: 'object' } } }),
      opts('gpt-5.6-terra', 'low')
    );

    const [body, requestOptions] = createMock.mock.calls[0];
    expect(body).toEqual({
      model: 'gpt-5.6-terra',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ],
      reasoning_effort: 'low',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'parseYear', description: 'Years', schema: { type: 'object' } },
      },
    });
    expect(requestOptions).toEqual({ timeout: 1000, maxRetries: 0 });
    expect(res.text).toBe('{"a":1}');
    expect(res.stopReason).toBe('end');
    expect(res.parts).toEqual([
      {
        model: 'gpt-5.6-terra',
        usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 0 },
      },
    ]);
  });

  it('sends a temperature only with reasoning off (the GPT-5.6 rule)', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: 'x' } }] });
    const provider = new OpenAIProvider();
    await provider.complete(request({ temperature: 0.3 }), opts('gpt-5.6-luna', 'none'));
    await provider.complete(request({ temperature: 0.3 }), opts('gpt-5.6-luna', 'low'));
    expect(createMock.mock.calls[0][0].temperature).toBe(0.3);
    expect(createMock.mock.calls[1][0].temperature).toBeUndefined();
  });

  it('joins system blocks back into one system message', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: 'x' } }] });
    await new OpenAIProvider().complete(
      request({ system: [{ text: 'static ', cache: '5m' }, { text: 'dynamic' }] }),
      opts()
    );
    expect(createMock.mock.calls[0][0].messages[0]).toEqual({
      role: 'system',
      content: 'static dynamic',
    });
  });

  it('sends images as image_url parts with detail low', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: 'x' } }] });
    await new OpenAIProvider().complete(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look' },
              { type: 'image', dataUri: 'data:image/jpeg;base64,AAA' },
            ],
          },
        ],
      }),
      opts()
    );
    expect(createMock.mock.calls[0][0].messages[1].content).toEqual([
      { type: 'text', text: 'Look' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA', detail: 'low' } },
    ]);
  });

  it('reports a cut-off answer, a refusal, and a response without usage', async () => {
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"a"' }, finish_reason: 'length' }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: null, refusal: 'no' } }] });
    const provider = new OpenAIProvider();
    const cut = await provider.complete(request(), opts());
    expect(cut.stopReason).toBe('max_tokens');
    expect(cut.parts[0].usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const refused = await provider.complete(request(), opts());
    expect(refused.stopReason).toBe('refusal');
    expect(refused.text).toBe('');
  });
});

describe('OpenAIProvider.stream', () => {
  it('passes each delta on and reads usage from the last chunk', async () => {
    async function* chunks() {
      yield { choices: [{ delta: { content: 'Hel' } }] };
      yield { choices: [{ delta: { content: 'lo' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      yield { choices: [], usage: { prompt_tokens: 50, completion_tokens: 2 } };
    }
    createMock.mockResolvedValueOnce(chunks());
    const tokens: string[] = [];
    const res = await new OpenAIProvider().stream(request(), opts('gpt-5.6-terra', 'none'), (t) =>
      tokens.push(t)
    );
    expect(tokens).toEqual(['Hel', 'lo']);
    expect(res.text).toBe('Hello');
    expect(res.parts[0].usage.inputTokens).toBe(50);
    const body = createMock.mock.calls[0][0];
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe('OpenAIProvider.image', () => {
  it('generates from a prompt and splits text and image tokens', async () => {
    imagesGenerateMock.mockResolvedValueOnce({
      data: [{ b64_json: Buffer.from('png').toString('base64') }],
      usage: {
        input_tokens: 30,
        output_tokens: 4000,
        input_tokens_details: { text_tokens: 30, image_tokens: 0 },
      },
    });
    const res = await new OpenAIProvider().image(
      { prompt: 'A party', size: '1536x1024', quality: 'high' },
      opts('gpt-image-2.5-sunburst')
    );
    expect(res.data?.toString()).toBe('png');
    expect(imagesGenerateMock.mock.calls[0][0]).toEqual({
      model: 'gpt-image-2.5-sunburst',
      prompt: 'A party',
      n: 1,
      size: '1536x1024',
      quality: 'high',
    });
    expect(res.parts[0].usage).toMatchObject({
      inputTokens: 30,
      imageInputTokens: 0,
      outputTokens: 4000,
    });
    expect(res.parts[0].estimated).toBe(false);
  });

  it('edits the given images and returns null data when none came back', async () => {
    imagesEditMock.mockResolvedValueOnce({ data: [] });
    const res = await new OpenAIProvider().image(
      {
        prompt: 'Swap',
        size: '1024x1024',
        quality: 'high',
        images: [{ data: Buffer.from('a'), filename: 'a.png', mimeType: 'image/png' }],
      },
      opts('gpt-image-2.5-sunburst')
    );
    expect(res.data).toBeNull();
    const args = imagesEditMock.mock.calls[0][0];
    expect(args.image).toHaveLength(1);
    expect(args.image[0].name).toBe('a.png');
    expect(res.parts[0].estimated).toBe(true);
  });
});

describe('OpenAIProvider.speech', () => {
  it('returns the audio and an estimated usage', async () => {
    speechMock.mockResolvedValueOnce({ arrayBuffer: async () => new TextEncoder().encode('mp3').buffer });
    const res = await new OpenAIProvider().speech(
      { text: 'Hello there', voice: 'ash' },
      opts('gpt-4o-mini-tts')
    );
    expect(res.data?.toString()).toBe('mp3');
    expect(speechMock.mock.calls[0][0]).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: 'ash',
      input: 'Hello there',
      instructions: '',
    });
    expect(res.parts[0].estimated).toBe(true);
    expect(res.parts[0].usage.outputTokens).toBeGreaterThan(0);
  });
});

describe('OpenAIProvider.isAvailable', () => {
  it('needs OPENAI_API_KEY or OPENAI_TOKEN', () => {
    const key = process.env['OPENAI_API_KEY'];
    const token = process.env['OPENAI_TOKEN'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_TOKEN'];
    expect(new OpenAIProvider().isAvailable()).toBe(false);
    process.env['OPENAI_TOKEN'] = 'x';
    expect(new OpenAIProvider().isAvailable()).toBe(true);
    if (key === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = key;
    if (token === undefined) delete process.env['OPENAI_TOKEN'];
    else process.env['OPENAI_TOKEN'] = token;
  });
});
