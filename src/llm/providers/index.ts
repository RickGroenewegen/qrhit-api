/**
 * The provider registry. A new provider is one adapter file implementing
 * LlmProvider, one line here and its models in ../models.ts.
 *
 * Adapters are created on first use, never at import: worker.ts loads its
 * .env after its imports, so an API key read at import time would be empty.
 */
import { color } from 'console-log-colors';
import Logger from '../../logger';
import { LlmUnavailableError } from '../errors';
import type { LlmProvider, LlmProviderId } from '../types';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';

const FACTORIES: Record<LlmProviderId, () => LlmProvider> = {
  openai: () => new OpenAIProvider(),
  anthropic: () => new AnthropicProvider(),
};

const instances = new Map<LlmProviderId, LlmProvider>();
const warned = new Set<LlmProviderId>();
const logger = new Logger();

export function getProvider(id: LlmProviderId): LlmProvider {
  let provider = instances.get(id);
  if (!provider) {
    const factory = FACTORIES[id];
    if (!factory) throw new LlmUnavailableError(id);
    provider = factory();
    instances.set(id, provider);
  }
  if (!provider.isAvailable()) {
    if (!warned.has(id)) {
      warned.add(id);
      logger.log(
        color.yellow.bold('[') +
          color.white.bold('llm') +
          color.yellow.bold('] No API key for ') +
          color.white.bold(id) +
          color.yellow.bold(' in this process; its routes fall back where they can')
      );
    }
    throw new LlmUnavailableError(id);
  }
  return provider;
}

/** Tests: forget the adapters (and their clients) built so far. */
export function resetProviders(): void {
  instances.clear();
  warned.clear();
}
