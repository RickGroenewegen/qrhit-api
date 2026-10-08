import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * One single LLM source: only the adapters in src/llm/providers may import an
 * AI provider's SDK. Everything else calls the layer (src/llm), so every call
 * is routed per task, falls back, and lands in the llm_calls cost ledger.
 */
const SRC = path.resolve(__dirname, '../../../src');
const PROVIDERS = path.join(SRC, 'llm', 'providers');
const SDKS = ['openai', '@anthropic-ai/sdk', 'llmlayer', '@google/genai', 'groq-sdk', '@mistralai/mistralai'];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|js|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}

describe('single LLM source', () => {
  it('imports AI SDKs only inside src/llm/providers', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.startsWith(PROVIDERS + path.sep)) continue;
      const code = fs.readFileSync(file, 'utf8');
      for (const sdk of SDKS) {
        const escaped = sdk.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
        const pattern = new RegExp(
          `(from\\s+['"]${escaped}(/[^'"]*)?['"]|require\\(\\s*['"]${escaped}(/[^'"]*)?['"]\\s*\\)|import\\(\\s*['"]${escaped}(/[^'"]*)?['"]\\s*\\))`
        );
        if (pattern.test(code)) offenders.push(`${path.relative(SRC, file)} imports ${sdk}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
