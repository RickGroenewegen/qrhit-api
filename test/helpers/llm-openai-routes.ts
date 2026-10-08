/**
 * For suites that test a call site's prompt, schema and parsing against the
 * mocked OpenAI SDK: every task runs on its OpenAI route (its fallback when
 * the primary is another provider), with no fallback. The suite then tests
 * the call site, not the provider table; the Anthropic adapter and the
 * fallback logic have their own suites in test/unit/llm.
 *
 *   vi.mock('../../src/llm/tasks', async (importOriginal) =>
 *     (await import('../helpers/llm-openai-routes')).openAiRoutes(await importOriginal())
 *   );
 */
import type { LlmTaskConfig } from '../../src/llm/types';

export function openAiRoutes<M extends { LLM_TASKS: Record<string, LlmTaskConfig> }>(actual: M) {
  const tasks: Record<string, LlmTaskConfig> = {};
  for (const [id, config] of Object.entries(actual.LLM_TASKS)) {
    if (config.primary.provider === 'openai') {
      tasks[id] = { ...config, fallback: undefined };
    } else if (config.fallback?.provider === 'openai') {
      tasks[id] = { ...config, primary: config.fallback, fallback: undefined };
    } else {
      throw new Error(`task ${id} has no OpenAI route`);
    }
  }
  return {
    ...actual,
    LLM_TASKS: tasks,
    taskConfig: (task: string) => tasks[task],
  };
}
