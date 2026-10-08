import { describe, it, expect } from 'vitest';
import { LLM_TASKS } from '../../../src/llm/tasks';
import { modelInfo } from '../../../src/llm/models';
import type { LlmRoute, LlmTaskConfig } from '../../../src/llm/types';

const tasks = Object.entries(LLM_TASKS) as Array<[string, LlmTaskConfig]>;

function routesOf(config: LlmTaskConfig): LlmRoute[] {
  return [config.primary, config.fallback].filter((r): r is LlmRoute => !!r);
}

describe('LLM_TASKS', () => {
  it('names a priced, current model of the right provider and kind on every route', () => {
    for (const [task, config] of tasks) {
      for (const route of routesOf(config)) {
        const info = modelInfo(route.model);
        expect(info, `${task}: ${route.model} is not in models.ts`).toBeDefined();
        expect(info!.provider, `${task}: ${route.model}`).toBe(route.provider);
        expect(info!.kind, `${task}: ${route.model}`).toBe(config.kind);
        expect(info!.retired, `${task}: ${route.model} is retired`).toBeFalsy();
        expect(info!.price.output, `${task}: ${route.model}`).toBeGreaterThan(0);
      }
    }
  });

  it('gives every text route an effort and every image or speech route none', () => {
    for (const [task, config] of tasks) {
      for (const route of routesOf(config)) {
        if (config.kind === 'text') expect(route.effort, task).toBeDefined();
        else expect(route.effort, task).toBeUndefined();
      }
    }
  });

  it('only sends images to models that read them', () => {
    expect(modelInfo(LLM_TASKS.appPalette.primary.model)?.vision).toBe(true);
  });

  it('falls back to another provider, never the same one', () => {
    for (const [task, config] of tasks) {
      if (config.fallback) {
        expect(config.fallback.provider, task).not.toBe(config.primary.provider);
      }
    }
  });

  it('has a human-readable label and description for the admin page', () => {
    for (const [task, config] of tasks) {
      expect(config.label.length, task).toBeGreaterThan(3);
      expect(config.description.length, task).toBeGreaterThan(10);
    }
  });

  it('routes every task as reviewed (update this snapshot on purpose)', () => {
    const table = Object.fromEntries(
      tasks.map(([task, config]) => [
        task,
        routesOf(config)
          .map((r) => `${r.provider}/${r.model}${r.effort ? `:${r.effort}` : ''}`)
          .join(' -> '),
      ])
    );
    expect(table).toMatchSnapshot();
  });
});
