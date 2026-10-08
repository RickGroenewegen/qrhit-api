import { FastifyInstance } from 'fastify';
import { color } from 'console-log-colors';
import PrismaInstance from '../prisma';
import Logger from '../logger';
import Fx from '../services/fx';
import { LLM_TASKS } from '../llm/tasks';
import { MODELS, PROVIDERS, modelInfo } from '../llm/models';
import type { LlmRoute, LlmTaskConfig } from '../llm/types';

/**
 * Admin AI costs: what every LLM task used and cost, per provider and model,
 * read from the llm_calls ledger the LLM layer writes (src/llm/ledger.ts).
 * Costs were priced when each call happened (src/llm/models.ts); nothing
 * here prices anything.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Sums {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

const emptySums = (): Sums => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
});

function addTo(target: Sums, source: Sums): void {
  target.calls += source.calls;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.costUsd += source.costUsd;
}

function routeLabel(route: LlmRoute | undefined): string | null {
  if (!route) return null;
  return `${route.provider}/${route.model}${route.effort ? ` (${route.effort})` : ''}`;
}

function localDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The range from the query, the current month by default. The end date is inclusive. */
export function parseRange(query: { startDate?: unknown; endDate?: unknown }): {
  start: Date;
  endExclusive: Date;
  startDate: string;
  endDate: string;
} {
  const today = new Date();
  const startDate =
    typeof query.startDate === 'string' && DATE.test(query.startDate)
      ? query.startDate
      : isoDate(new Date(today.getFullYear(), today.getMonth(), 1));
  const endDate =
    typeof query.endDate === 'string' && DATE.test(query.endDate)
      ? query.endDate
      : isoDate(today);
  const start = localDate(startDate);
  const endExclusive = localDate(endDate);
  endExclusive.setDate(endExclusive.getDate() + 1);
  return { start, endExclusive, startDate, endDate };
}

export default async function aiCostRoutes(
  fastify: FastifyInstance,
  _verifyTokenMiddleware: any,
  getAuthHandler: any
) {
  const prisma = PrismaInstance.getInstance();
  const logger = new Logger();

  /**
   * GET /admin/ai-costs?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
   * Usage and cost per task, split per provider, model and role (primary or
   * fallback), with the failures by status, plus provider totals, the
   * month-to-date spend against each provider's free credit, and the price
   * list in use.
   */
  fastify.get(
    '/admin/ai-costs',
    getAuthHandler(['admin']),
    async (request: any, reply: any) => {
      try {
        const { start, endExclusive, startDate, endDate } = parseRange(request.query || {});
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const [grouped, monthByProvider, rates] = await Promise.all([
          prisma.llmCall.groupBy({
            by: ['task', 'kind', 'provider', 'model', 'role', 'status', 'estimated'],
            where: { createdAt: { gte: start, lt: endExclusive } },
            _count: { _all: true },
            _sum: {
              inputTokens: true,
              outputTokens: true,
              cacheReadTokens: true,
              cacheWriteTokens: true,
              costUsd: true,
              durationMs: true,
            },
          }),
          prisma.llmCall.groupBy({
            by: ['provider'],
            where: { createdAt: { gte: monthStart } },
            _sum: { costUsd: true },
          }),
          Fx.getInstance()
            .getRates()
            .catch(() => null),
        ]);

        // ECB rates are EUR-based (USD per 1 EUR); the raw rate, without
        // the buffer customer prices carry.
        const usdPerEur = rates?.rates?.['USD' as keyof typeof rates.rates];
        const usdToEur = usdPerEur ? 1 / usdPerEur : null;

        type Row = Sums & {
          provider: string;
          model: string;
          modelLabel: string;
          role: string;
          okCalls: number;
          durationMs: number;
          estimated: boolean;
          failures: Record<string, number>;
        };
        const tasks = new Map<
          string,
          { kind: string; sums: Sums; fallbackCalls: number; failedCalls: number; rows: Map<string, Row> }
        >();
        const providers = new Map<string, Sums>();
        const totals = { ...emptySums(), fallbackCalls: 0, failedCalls: 0 };

        for (const g of grouped) {
          const sums: Sums = {
            calls: g._count._all,
            inputTokens: g._sum.inputTokens ?? 0,
            outputTokens: g._sum.outputTokens ?? 0,
            cacheReadTokens: g._sum.cacheReadTokens ?? 0,
            cacheWriteTokens: g._sum.cacheWriteTokens ?? 0,
            costUsd: g._sum.costUsd ?? 0,
          };
          let task = tasks.get(g.task);
          if (!task) {
            task = { kind: g.kind, sums: emptySums(), fallbackCalls: 0, failedCalls: 0, rows: new Map() };
            tasks.set(g.task, task);
          }
          addTo(task.sums, sums);
          if (g.role === 'fallback') task.fallbackCalls += sums.calls;
          if (g.status !== 'ok') task.failedCalls += sums.calls;

          const key = `${g.provider}|${g.model}|${g.role}`;
          let row = task.rows.get(key);
          if (!row) {
            row = {
              ...emptySums(),
              provider: g.provider,
              model: g.model,
              modelLabel: modelInfo(g.model)?.label ?? g.model,
              role: g.role,
              okCalls: 0,
              durationMs: 0,
              estimated: false,
              failures: {},
            };
            task.rows.set(key, row);
          }
          addTo(row, sums);
          row.durationMs += g._sum.durationMs ?? 0;
          row.estimated = row.estimated || g.estimated;
          if (g.status === 'ok') row.okCalls += sums.calls;
          else row.failures[g.status] = (row.failures[g.status] ?? 0) + sums.calls;

          let provider = providers.get(g.provider);
          if (!provider) {
            provider = emptySums();
            providers.set(g.provider, provider);
          }
          addTo(provider, sums);

          addTo(totals, sums);
          if (g.role === 'fallback') totals.fallbackCalls += sums.calls;
          if (g.status !== 'ok') totals.failedCalls += sums.calls;
        }

        const config = LLM_TASKS as Record<string, LlmTaskConfig>;
        const taskList = [...tasks.entries()]
          .map(([id, t]) => ({
            task: id,
            label: config[id]?.label ?? id,
            description: config[id]?.description ?? '',
            kind: t.kind,
            primaryRoute: routeLabel(config[id]?.primary),
            fallbackRoute: routeLabel(config[id]?.fallback),
            ...t.sums,
            fallbackCalls: t.fallbackCalls,
            failedCalls: t.failedCalls,
            rows: [...t.rows.values()]
              .map(({ durationMs, ...row }) => ({
                ...row,
                avgDurationMs: row.calls ? Math.round(durationMs / row.calls) : 0,
              }))
              .sort(
                (a, b) =>
                  (a.role === 'primary' ? 0 : 1) - (b.role === 'primary' ? 0 : 1) ||
                  b.costUsd - a.costUsd
              ),
          }))
          .sort((a, b) => b.costUsd - a.costUsd);

        const monthSpend = new Map(
          monthByProvider.map((p) => [p.provider, p._sum.costUsd ?? 0])
        );
        const providerList = (Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>)
          .map((id) => ({
            provider: id,
            label: PROVIDERS[id].label,
            ...(providers.get(id) ?? emptySums()),
            monthlyCredit: PROVIDERS[id].monthlyCredit ?? null,
            monthToDateUsd: monthSpend.get(id) ?? 0,
          }));

        const prices = Object.entries(MODELS).map(([model, info]) => ({
          model,
          label: info.label,
          provider: info.provider,
          kind: info.kind,
          retired: 'retired' in info ? !!info.retired : false,
          price: info.price,
          longContext: 'longContext' in info ? info.longContext : null,
        }));

        reply.send({
          success: true,
          data: {
            range: { startDate, endDate },
            usdToEur,
            totals,
            providers: providerList,
            tasks: taskList,
            prices,
          },
        });
      } catch (error: any) {
        logger.log(
          color.red.bold('[') +
            color.white.bold('aiCosts') +
            color.red.bold('] Failed: ') +
            color.white.bold(error?.message || String(error))
        );
        reply.status(500).send({ success: false, error: error?.message || 'Failed to load AI costs' });
      }
    }
  );
}
