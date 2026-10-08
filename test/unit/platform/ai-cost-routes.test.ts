import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

/**
 * GET /admin/ai-costs on a bare Fastify instance: the llm_calls ledger is a
 * groupBy stand-in, the ECB rate a stub.
 */

const h = vi.hoisted(() => ({
  groupBy: vi.fn(),
  getRates: vi.fn(),
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => ({ llmCall: { groupBy: h.groupBy } }) },
}));

vi.mock('../../../src/services/fx', () => ({
  default: { getInstance: () => ({ getRates: h.getRates }) },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
  },
}));

import aiCostRoutes, { parseRange } from '../../../src/routes/aiCostRoutes';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  const getAuthHandler = () => ({ preHandler: async () => {} });
  await aiCostRoutes(app, null, getAuthHandler);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const group = (over: any) => ({
  task: 'yearLookup',
  kind: 'text',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  role: 'primary',
  status: 'ok',
  estimated: false,
  _count: { _all: 10 },
  _sum: {
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.04,
    durationMs: 15_000,
  },
  ...over,
});

beforeEach(() => {
  h.groupBy.mockReset();
  h.getRates.mockReset();
  h.getRates.mockResolvedValue({ asOf: '2026-10-08', rates: { USD: 1.25 } });
});

describe('GET /admin/ai-costs', () => {
  it('groups the ledger per task, model and role, with failures, fallbacks and EUR', async () => {
    h.groupBy
      .mockResolvedValueOnce([
        group({}),
        group({ status: 'refusal', _count: { _all: 2 }, _sum: { inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, durationMs: 1000 } }),
        group({
          provider: 'openai',
          model: 'gpt-5.6-terra',
          role: 'fallback',
          _count: { _all: 2 },
          _sum: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.003, durationMs: 4000 },
        }),
        group({
          task: 'retiredTask',
          provider: 'openai',
          model: 'gpt-5.6-luna',
          _count: { _all: 1 },
          _sum: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0001, durationMs: 100 },
        }),
      ])
      .mockResolvedValueOnce([
        { provider: 'anthropic', _sum: { costUsd: 12.5 } },
        { provider: 'openai', _sum: { costUsd: 1 } },
      ]);

    const res = await app.inject({
      method: 'GET',
      url: '/admin/ai-costs?startDate=2026-10-01&endDate=2026-10-08',
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    // The range filter: start of the first day up to the start of the day after the last.
    const where = h.groupBy.mock.calls[0][0].where.createdAt;
    expect(where.gte).toEqual(new Date(2026, 9, 1));
    expect(where.lt).toEqual(new Date(2026, 9, 9));

    expect(data.range).toEqual({ startDate: '2026-10-01', endDate: '2026-10-08' });
    expect(data.usdToEur).toBeCloseTo(0.8, 10);
    expect(data.totals).toMatchObject({ calls: 15, fallbackCalls: 2, failedCalls: 2 });

    const year = data.tasks.find((t: any) => t.task === 'yearLookup');
    expect(year.label).toBe('Release year lookup');
    expect(year.primaryRoute).toContain('/');
    expect(year).toMatchObject({ calls: 14, fallbackCalls: 2, failedCalls: 2 });
    expect(year.rows.map((r: any) => [r.model, r.role, r.calls, r.okCalls])).toEqual([
      ['claude-sonnet-5-5', 'primary', 12, 10],
      ['gpt-5.6-terra', 'fallback', 2, 2],
    ]);
    expect(year.rows[0].failures).toEqual({ refusal: 2 });
    expect(year.rows[0].modelLabel).toBe('Claude Sonnet 5.5');
    expect(year.rows[0].avgDurationMs).toBe(Math.round(16_000 / 12));

    // A task that is no longer in the table keeps its rows under its id.
    const old = data.tasks.find((t: any) => t.task === 'retiredTask');
    expect(old.label).toBe('retiredTask');
    expect(old.primaryRoute).toBeNull();

    const anthropic = data.providers.find((p: any) => p.provider === 'anthropic');
    expect(anthropic).toMatchObject({
      label: 'Anthropic',
      calls: 12,
      monthlyCredit: { amount: 200, currency: 'EUR' },
      monthToDateUsd: 12.5,
    });
    expect(data.prices.find((p: any) => p.model === 'claude-haiku-5-5').longContext.thresholdTokens).toBe(100_000);
  });

  it('defaults to the current month and survives a missing exchange rate', async () => {
    h.groupBy.mockResolvedValue([]);
    h.getRates.mockRejectedValue(new Error('ecb down'));
    const res = await app.inject({ method: 'GET', url: '/admin/ai-costs?startDate=nonsense' });
    const { data } = res.json();
    const now = new Date();
    expect(h.groupBy.mock.calls[0][0].where.createdAt.gte).toEqual(
      new Date(now.getFullYear(), now.getMonth(), 1)
    );
    expect(data.usdToEur).toBeNull();
    expect(data.tasks).toEqual([]);
    expect(data.providers.map((p: any) => p.calls)).toEqual([0, 0]);
  });

  it('answers 500 when the ledger cannot be read', async () => {
    h.groupBy.mockRejectedValue(new Error('db down'));
    const res = await app.inject({ method: 'GET', url: '/admin/ai-costs' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ success: false, error: 'db down' });
  });
});

describe('parseRange', () => {
  it('makes the end date inclusive', () => {
    const r = parseRange({ startDate: '2026-02-27', endDate: '2026-02-28' });
    expect(r.endExclusive).toEqual(new Date(2026, 2, 1));
  });
});
