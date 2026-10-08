import { describe, it, expect, vi, beforeEach } from 'vitest';

const { providers, recordMock } = vi.hoisted(() => ({
  providers: new Map<string, any>(),
  recordMock: vi.fn(),
}));

vi.mock('../../../src/llm/providers', async () => {
  const { LlmUnavailableError } = await import('../../../src/llm/errors');
  return {
    getProvider: (id: string) => {
      const provider = providers.get(id);
      if (!provider || provider.unavailable) throw new LlmUnavailableError(id);
      return provider;
    },
  };
});

vi.mock('../../../src/llm/ledger', () => ({ recordLlmCalls: recordMock }));

vi.mock('../../../src/llm/tasks', () => {
  const tasks: Record<string, any> = {
    withFallback: {
      kind: 'text',
      label: 'x',
      description: 'x',
      primary: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' },
      fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'low' },
    },
    single: {
      kind: 'text',
      label: 'x',
      description: 'x',
      primary: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'none' },
      timeoutMs: 5000,
      maxRetries: 3,
      maxOutputTokens: 900,
    },
    picture: {
      kind: 'image',
      label: 'x',
      description: 'x',
      primary: { provider: 'openai', model: 'gpt-image-2.5-sunburst' },
    },
  };
  return { LLM_TASKS: tasks, taskConfig: (t: string) => tasks[t] };
});

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

import { llm, normalizeRequest } from '../../../src/llm';
import { LlmOutputError, LlmRequestError } from '../../../src/llm/errors';
import { priceCall } from '../../../src/llm/models';

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const answer = (text: string, model: string, over: any = {}) => ({
  text,
  stopReason: 'end',
  parts: [{ model, usage: usage(1000, 100) }],
  ...over,
});

function provider(id: string, impl: Partial<Record<'complete' | 'stream' | 'image', any>>) {
  providers.set(id, { id, isAvailable: () => true, ...impl });
}

const req = {
  messages: [
    { role: 'system' as const, content: 'Rules' },
    { role: 'user' as const, content: 'Question' },
  ],
  schema: { name: 's', schema: { type: 'object' } },
};

beforeEach(() => {
  providers.clear();
  recordMock.mockReset();
});

describe('normalizeRequest', () => {
  it('moves leading system messages into the system prompt', () => {
    const n = normalizeRequest({ ...req, system: [{ text: 'A', cache: '5m' }] });
    expect(n.system).toEqual([{ text: 'A', cache: '5m' }, { text: 'Rules' }]);
    expect(n.messages).toEqual([{ role: 'user', content: 'Question' }]);
  });

  it('refuses a system message in the middle of the conversation', () => {
    expect(() =>
      normalizeRequest({
        messages: [
          { role: 'user', content: 'a' },
          { role: 'system', content: 'b' },
        ],
      })
    ).toThrow(LlmRequestError);
  });
});

describe('llm.json', () => {
  it('returns the parsed answer with its cost and writes one ledger row', async () => {
    provider('anthropic', { complete: vi.fn().mockResolvedValue(answer('{"year":1984}', 'claude-sonnet-5-5')) });
    const res = await llm.json<{ year: number }>('withFallback' as any, req);
    expect(res.data).toEqual({ year: 1984 });
    expect(res.provider).toBe('anthropic');
    expect(res.fellBack).toBe(false);
    expect(res.costUsd).toBeCloseTo(priceCall('claude-sonnet-5-5', usage(1000, 100)), 12);
    expect(recordMock).toHaveBeenCalledTimes(1);
    const [task, kind, attempts] = recordMock.mock.calls[0];
    expect([task, kind]).toEqual(['withFallback', 'text']);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ role: 'primary', status: 'ok', model: 'claude-sonnet-5-5' });
  });

  it('passes the task limits to the provider', async () => {
    const complete = vi.fn().mockResolvedValue(answer('{}', 'gpt-5.6-luna'));
    provider('openai', { complete });
    await llm.json('single' as any, req);
    expect(complete.mock.calls[0][1]).toEqual({
      route: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'none' },
      maxOutputTokens: 900,
      timeoutMs: 5000,
      maxRetries: 3,
    });
  });

  it('falls back once when the primary provider errors', async () => {
    provider('anthropic', { complete: vi.fn().mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 })) });
    provider('openai', { complete: vi.fn().mockResolvedValue(answer('{"ok":1}', 'gpt-5.6-terra')) });
    const res = await llm.json('withFallback' as any, req);
    expect(res.data).toEqual({ ok: 1 });
    expect(res.provider).toBe('openai');
    expect(res.fellBack).toBe(true);
    const attempts = recordMock.mock.calls[0][2];
    expect(attempts.map((a: any) => [a.role, a.status])).toEqual([
      ['primary', 'error'],
      ['fallback', 'ok'],
    ]);
    expect(attempts[0].error).toBe('529 overloaded');
  });

  it('records a missing API key as unavailable and falls back', async () => {
    providers.set('anthropic', { id: 'anthropic', unavailable: true });
    provider('openai', { complete: vi.fn().mockResolvedValue(answer('{}', 'gpt-5.6-terra')) });
    await llm.json('withFallback' as any, req);
    expect(recordMock.mock.calls[0][2][0].status).toBe('unavailable');
  });

  it('falls back after a refusal and throws LlmOutputError with every attempt when both fail', async () => {
    provider('anthropic', { complete: vi.fn().mockResolvedValue(answer('', 'claude-sonnet-5-5', { stopReason: 'refusal' })) });
    provider('openai', { complete: vi.fn().mockResolvedValue(answer('not json', 'gpt-5.6-terra')) });
    const err = await llm.json('withFallback' as any, req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmOutputError);
    expect(err.kind).toBe('unparseable');
    expect(err.attempts.map((a: any) => a.status)).toEqual(['refusal', 'unparseable']);
    expect(err.costUsd).toBeGreaterThan(0);
  });

  it('prefers the output error when the fallback then hits a provider error', async () => {
    provider('anthropic', { complete: vi.fn().mockResolvedValue(answer('', 'claude-sonnet-5-5', { stopReason: 'max_tokens' })) });
    provider('openai', { complete: vi.fn().mockRejectedValue(new Error('down')) });
    const err = await llm.json('withFallback' as any, req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmOutputError);
    expect(err.kind).toBe('truncated');
  });

  it('rethrows the provider error when no answer came back at all', async () => {
    provider('anthropic', { complete: vi.fn().mockRejectedValue(new Error('a down')) });
    provider('openai', { complete: vi.fn().mockRejectedValue(new Error('o down')) });
    await expect(llm.json('withFallback' as any, req)).rejects.toThrow('o down');
  });

  it('never falls back on a request we built wrong', async () => {
    const fallback = vi.fn();
    provider('anthropic', { complete: vi.fn().mockRejectedValue(new LlmRequestError('bad')) });
    provider('openai', { complete: fallback });
    await expect(llm.json('withFallback' as any, req)).rejects.toBeInstanceOf(LlmRequestError);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('records the server-side fallback runs as their own rows', async () => {
    provider('anthropic', {
      complete: vi.fn().mockResolvedValue(
        answer('{}', 'claude-opus-5', {
          parts: [
            { model: 'claude-sonnet-5-5', usage: usage(100, 1), refused: true },
            { model: 'claude-sonnet-5', usage: usage(100, 50), serverFallback: true },
          ],
        })
      ),
    });
    const res = await llm.json('withFallback' as any, req);
    expect(res.fellBack).toBe(true);
    expect(res.model).toBe('claude-sonnet-5');
    expect(recordMock.mock.calls[0][2].map((a: any) => [a.model, a.role, a.status])).toEqual([
      ['claude-sonnet-5-5', 'primary', 'refusal'],
      ['claude-sonnet-5', 'fallback', 'ok'],
    ]);
  });
});

describe('llm.tryJson', () => {
  it('returns null for an unusable answer', async () => {
    provider('openai', { complete: vi.fn().mockResolvedValue(answer('', 'gpt-5.6-luna')) });
    expect(await llm.tryJson('single' as any, req)).toBeNull();
  });

  it('still throws provider errors', async () => {
    provider('openai', { complete: vi.fn().mockRejectedValue(new Error('rate limited')) });
    await expect(llm.tryJson('single' as any, req)).rejects.toThrow('rate limited');
  });
});

describe('llm.text', () => {
  it('returns the text as it came', async () => {
    provider('openai', { complete: vi.fn().mockResolvedValue(answer('Hallo wereld', 'gpt-5.6-luna')) });
    expect((await llm.text('single' as any, { messages: [{ role: 'user', content: 'x' }] })).data).toBe(
      'Hallo wereld'
    );
  });
});

describe('llm.stream', () => {
  const chatReq = { messages: [{ role: 'user' as const, content: 'Hi' }] };

  it('falls back while nothing has been sent yet', async () => {
    provider('anthropic', { stream: vi.fn().mockRejectedValue(new Error('down')) });
    provider('openai', {
      stream: vi.fn(async (_r: any, _o: any, onToken: (t: string) => void) => {
        onToken('Hello');
        return answer('Hello', 'gpt-5.6-terra');
      }),
    });
    const tokens: string[] = [];
    const res = await llm.stream('withFallback' as any, chatReq, (t) => tokens.push(t));
    expect(tokens).toEqual(['Hello']);
    expect(res.data).toBe('Hello');
    expect(res.fellBack).toBe(true);
  });

  it('ends with the partial answer when a sent stream is cut off', async () => {
    const fallback = vi.fn();
    provider('anthropic', {
      stream: vi.fn(async (_r: any, _o: any, onToken: (t: string) => void) => {
        onToken('Half an');
        return answer('Half an', 'claude-sonnet-5-5', { stopReason: 'max_tokens' });
      }),
    });
    provider('openai', { stream: fallback });
    const res = await llm.stream('withFallback' as any, chatReq, () => {});
    expect(res.data).toBe('Half an');
    expect(res.stopReason).toBe('truncated');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('does not start over on another model after an error mid-stream', async () => {
    const fallback = vi.fn();
    provider('anthropic', {
      stream: vi.fn(async (_r: any, _o: any, onToken: (t: string) => void) => {
        onToken('Hel');
        throw new Error('connection reset');
      }),
    });
    provider('openai', { stream: fallback });
    await expect(llm.stream('withFallback' as any, chatReq, () => {})).rejects.toThrow('connection reset');
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('llm.image', () => {
  it('returns the image data with its cost', async () => {
    provider('openai', {
      image: vi.fn().mockResolvedValue({
        data: Buffer.from('png'),
        parts: [{ model: 'gpt-image-2.5-sunburst', usage: { ...usage(30, 4000), imageInputTokens: 0 } }],
      }),
    });
    const res = await llm.image('picture' as any, { prompt: 'x', size: '1024x1024', quality: 'high' });
    expect(res.data.toString()).toBe('png');
    expect(res.costUsd).toBeCloseTo((30 * 5 + 4000 * 30) / 1e6, 12);
    expect(recordMock.mock.calls[0][1]).toBe('image');
  });

  it('throws LlmOutputError when no image came back', async () => {
    provider('openai', {
      image: vi.fn().mockResolvedValue({ data: null, parts: [{ model: 'gpt-image-2.5-sunburst', usage: usage(1, 0) }] }),
    });
    const err = await llm.image('picture' as any, { prompt: 'x', size: '1024x1024', quality: 'high' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmOutputError);
    expect(err.kind).toBe('empty');
  });
});
