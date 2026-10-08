/**
 * Writes every model run to the llm_calls table, the source of the admin AI
 * costs page. Fire and forget: a failed write is logged and never breaks the
 * call that made it. Off under test (ENVIRONMENT=test) unless LLM_LEDGER=on,
 * so suites don't write rows as a side effect.
 */
import { color } from 'console-log-colors';
import Logger from '../logger';
import PrismaInstance from '../prisma';
import type { LlmAttempt, LlmKind } from './types';

const logger = new Logger();

function enabled(): boolean {
  return process.env['ENVIRONMENT'] !== 'test' || process.env['LLM_LEDGER'] === 'on';
}

function logFailure(err: unknown): void {
  logger.log(
    color.red.bold('[') +
      color.white.bold('llm') +
      color.red.bold('] Ledger write failed: ') +
      color.white.bold((err as Error)?.message ?? String(err))
  );
}

export function recordLlmCalls(task: string, kind: LlmKind, attempts: LlmAttempt[]): void {
  if (!enabled() || attempts.length === 0) return;
  let prisma: any;
  try {
    prisma = PrismaInstance.getInstance();
  } catch (err) {
    logFailure(err);
    return;
  }
  for (const attempt of attempts) {
    try {
      const write = prisma?.llmCall?.create?.({
        data: {
          task,
          kind,
          provider: attempt.provider,
          model: attempt.model.slice(0, 64),
          role: attempt.role,
          status: attempt.status,
          inputTokens: attempt.usage.inputTokens + (attempt.usage.imageInputTokens ?? 0),
          outputTokens: attempt.usage.outputTokens,
          cacheReadTokens: attempt.usage.cacheReadTokens,
          cacheWriteTokens: attempt.usage.cacheWriteTokens,
          costUsd: attempt.costUsd,
          estimated: attempt.estimated,
          durationMs: Math.round(attempt.durationMs),
          error: attempt.error ? attempt.error.slice(0, 255) : null,
        },
      });
      write?.catch?.(logFailure);
    } catch (err) {
      logFailure(err);
    }
  }
}
