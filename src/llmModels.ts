/**
 * OpenAI model selection for the API. Bump the constants here when OpenAI
 * ships a new family; nothing else in the codebase names a model directly.
 *
 * Tiers follow OpenAI's own GPT-5.6 naming:
 *   sol   - unsuffixed tier: long-form writing, vision, hard string parsing
 *   terra - mini tier: the default for structured work (quiz, years)
 *   luna  - nano tier: cheap utility calls (chat helpers, mail translation)
 *           and the AI playlist generator, where a customer waits on it
 *
 * Chat Completions on the GPT-5.6 family rejects `temperature` other than 1
 * and rejects function tools whenever reasoning is on. Structured JSON is
 * therefore requested through `response_format: { type: 'json_schema' }`
 * and read from `message.content`, with `reasoning_effort` picked per call:
 * 'none' for translation and classification, 'low' or 'medium' where the
 * answer has to be factually right (release years, trivia, order extraction).
 * Prices per 1M tokens live in `aiPricing.ts`.
 */
export const LLM_MODEL_PRO = 'gpt-5.6-sol';
export const LLM_MODEL_STANDARD = 'gpt-5.6-terra';
export const LLM_MODEL_FAST = 'gpt-5.6-luna';

/**
 * Image generation and edits. `gpt-image-2.5-flare` is the faster sibling at
 * the same price; sunburst is the one tuned for edit precision, which is what
 * the product photo and card artwork flows need.
 */
export const IMAGE_MODEL = 'gpt-image-2.5-sunburst';

/** Still OpenAI's newest text-to-speech model as of 2026-09. */
export const TTS_MODEL = 'gpt-4o-mini-tts';
