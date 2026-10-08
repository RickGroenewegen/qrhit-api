import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => ({ llmCall: { create: createMock } }) },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

import { recordLlmCalls } from '../../../src/llm/ledger';
import type { LlmAttempt } from '../../../src/llm/types';

const attempt = (over: Partial<LlmAttempt> = {}): LlmAttempt => ({
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  role: 'primary',
  status: 'ok',
  usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2, imageInputTokens: 0 },
  costUsd: 0.0012,
  estimated: false,
  durationMs: 812.6,
  ...over,
});

beforeEach(() => {
  createMock.mockReset();
  createMock.mockResolvedValue({});
  process.env['LLM_LEDGER'] = 'on';
});

afterEach(() => {
  delete process.env['LLM_LEDGER'];
});

describe('recordLlmCalls', () => {
  it('writes one row per attempt', () => {
    recordLlmCalls('chatTopics', 'text', [
      attempt({ status: 'error', error: 'x'.repeat(300), costUsd: 0 }),
      attempt({ role: 'fallback', provider: 'openai', model: 'gpt-5.6-luna' }),
    ]);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0][0].data).toMatchObject({
      task: 'chatTopics',
      kind: 'text',
      role: 'primary',
      status: 'error',
      costUsd: 0,
    });
    expect(createMock.mock.calls[0][0].data.error).toHaveLength(255);
    expect(createMock.mock.calls[1][0].data).toEqual({
      task: 'chatTopics',
      kind: 'text',
      provider: 'openai',
      model: 'gpt-5.6-luna',
      role: 'fallback',
      status: 'ok',
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      costUsd: 0.0012,
      estimated: false,
      durationMs: 813,
      error: null,
    });
  });

  it('counts image input tokens as input', () => {
    recordLlmCalls('productPhoto', 'image', [
      attempt({ usage: { inputTokens: 30, imageInputTokens: 2000, outputTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    ]);
    expect(createMock.mock.calls[0][0].data.inputTokens).toBe(2030);
  });

  it('never throws when the write fails', async () => {
    createMock.mockRejectedValueOnce(new Error('db down'));
    expect(() => recordLlmCalls('x', 'text', [attempt()])).not.toThrow();
    createMock.mockImplementationOnce(() => {
      throw new Error('sync');
    });
    expect(() => recordLlmCalls('x', 'text', [attempt()])).not.toThrow();
  });

  it('stays off under test unless LLM_LEDGER=on', () => {
    delete process.env['LLM_LEDGER'];
    recordLlmCalls('x', 'text', [attempt()]);
    expect(createMock).not.toHaveBeenCalled();
  });
});
