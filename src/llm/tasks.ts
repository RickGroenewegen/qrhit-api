/**
 * The switchboard: which provider, model and effort each kind of call uses.
 * Change a route here and deploy; nothing else in the codebase names a model.
 *
 * A task is a kind of call, not a call site: the quiz's question batches and
 * the single-question regenerate share `quizQuestions`. `fallback` is tried
 * once when the primary fails (provider down, no API key, the free credit
 * used up, a refusal, an unusable answer); the admin AI costs page shows
 * every fallback that ran. Every text task falls back to the OpenAI route it
 * used before the layer existed.
 *
 * Effort is provider-neutral, see LlmEffort in ./types. How the models were
 * picked (2026-10-08, side by side with `scripts/llm-smoke.ts --routes=...`):
 *   Haiku 5.5   classification, extraction, picking from given candidates,
 *               reading a year from the sources given, short and literal
 *               translations, quiz wrong options. As good as Sonnet there,
 *               at a fifteenth of the price.
 *   Sonnet 5.5  where it was clearly better: the playlist search terms (Haiku
 *               picked artists that do not fit the theme), the long-word split
 *               (Haiku broke mid-syllable), outgoing mail (Haiku mixed "du"
 *               and a formal closing), the contact draft and chat answer (copy
 *               a customer or Rick reads), trivia facts, SEO translations.
 *   Opus 5.5    the year audit (knowledge, no sources), SEO copy, reading a
 *               photo; all low volume.
 * Haiku 5.5 bills a prompt over 100K tokens at 5x; no task here comes near
 * (the catalogue matcher is the largest at ~45K), and the layer warns if one
 * does.
 */
import type { LlmTaskConfig } from './types';

export const LLM_TASKS = {
  // Release years -----------------------------------------------------------
  yearLookup: {
    kind: 'text',
    label: 'Release year lookup',
    description: 'Picks the release year of a new track from Google, Wikipedia, MusicBrainz and Discogs data.',
    // 2026-10-08, 16 tracks with conflicting source data (llm-smoke.ts
    // --sources): Haiku medium 16/16 at $0.00023 a call, Sonnet low 15/16 at
    // $0.0032, terra 15/16 at $0.0020. Haiku low missed one (a cover's year).
    primary: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium' },
    fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'low' },
  },
  yearAudit: {
    kind: 'text',
    label: 'Year audit',
    description: 'Admin check of a whole playlist for wrong release years (batches of 20).',
    primary: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium' },
    fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'medium' },
    timeoutMs: 240_000,
  },
  wordSplit: {
    kind: 'text',
    label: 'Long word split',
    description: 'Splits an artist or title word over 20 characters for the printed card.',
    primary: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' },
    fallback: { provider: 'openai', model: 'gpt-5.6-sol', effort: 'none' },
  },

  // "Describe your playlist" ---------------------------------------------------
  aiKeywords: {
    kind: 'text',
    label: 'Playlist search terms',
    description: 'Turns the customer\'s description into artists, title words and a year range (and more of them when the first set finds too little).',
    primary: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'none' },
    fallback: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'none' },
    timeoutMs: 60_000,
  },
  aiCurate: {
    kind: 'text',
    label: 'Playlist curation',
    description: 'Picks the fitting tracks from batches of 100 candidates.',
    primary: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'none' },
    fallback: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'none' },
    timeoutMs: 60_000,
  },
  aiSuggestFeatured: {
    kind: 'text',
    label: 'Featured playlist suggestions',
    description: 'Matches the description against the featured catalogue on the progress page.',
    primary: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'low' },
    fallback: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'none' },
  },
  aiSpotifyQuery: {
    kind: 'text',
    label: 'Spotify search queries',
    description: 'Writes Spotify playlist searches for the progress page suggestions.',
    primary: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'none' },
    fallback: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'none' },
  },
  aiSpotifyPick: {
    kind: 'text',
    label: 'Spotify suggestion pick',
    description: 'Chooses the matching playlists from the Spotify search results.',
    primary: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'none' },
    fallback: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'none' },
  },

  // Website chat and contact form -----------------------------------------------
  chatAnswer: {
    kind: 'text',
    label: 'Chat answer',
    description: 'The support chat\'s streamed answer, from the knowledge base.',
    primary: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' },
    fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'none' },
    timeoutMs: 60_000,
  },
  chatTopics: {
    kind: 'text',
    label: 'Chat topic pick',
    description: 'Picks the knowledge-base topics for a chat question or contact mail.',
    primary: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'none' },
    fallback: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'none' },
    timeoutMs: 30_000,
  },
  chatExtract: {
    kind: 'text',
    label: 'Chat data extraction',
    description: 'Pulls an order number, e-mail or country out of the conversation.',
    primary: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'none' },
    fallback: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'none' },
    timeoutMs: 30_000,
  },
  chatTranslate: {
    kind: 'text',
    label: 'Chat translation',
    description: 'Dutch copies of chat messages and admin replies in the customer\'s language.',
    primary: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'none' },
    fallback: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'none' },
    timeoutMs: 30_000,
  },
  contactTranslate: {
    kind: 'text',
    label: 'Contact mail translation',
    description: 'Detects the language of a contact-form message and makes a Dutch copy.',
    primary: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'none' },
    fallback: { provider: 'openai', model: 'gpt-5.6-luna', effort: 'none' },
  },
  contactDraft: {
    kind: 'text',
    label: 'Contact reply draft',
    description: 'A Dutch draft reply to a contact-form message.',
    primary: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' },
    fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'none' },
  },

  // Quiz ----------------------------------------------------------------------
  quizTrivia: {
    kind: 'text',
    label: 'Quiz trivia',
    description: 'Trivia questions about a track (batches and single regenerations).',
    primary: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' },
    fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'medium' },
    timeoutMs: 240_000,
  },
  quizQuestions: {
    kind: 'text',
    label: 'Quiz questions',
    description: 'Artist, missing-word and title questions, regenerations and new wrong options.',
    primary: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium' },
    fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'low' },
    timeoutMs: 180_000,
  },

  // App Designer ------------------------------------------------------------------
  appPalette: {
    kind: 'text',
    label: 'App theme from an image',
    description: 'Colours, font and button style for the scan app from the customer\'s photo.',
    primary: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low' },
    fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'none' },
    timeoutMs: 60_000,
  },

  // Catalogue copy ---------------------------------------------------------------
  seoWrite: {
    kind: 'text',
    label: 'SEO description',
    description: 'The English product-page description of a featured playlist.',
    primary: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium' },
    fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'low' },
  },
  seoTranslate: {
    kind: 'text',
    label: 'SEO description translation',
    description: 'Localises the SEO description into every other site language.',
    primary: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' },
    fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'none' },
  },
  literalTranslate: {
    kind: 'text',
    label: 'Literal translation',
    description: 'Word-for-word translation of a kept customer description, with language detection.',
    primary: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium' },
    fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'none' },
  },
  textTranslate: {
    kind: 'text',
    label: 'Text translation',
    description: 'Occasion texts, promotional descriptions and empty translation fields.',
    primary: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium' },
    fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'none' },
  },
  genreTranslate: {
    kind: 'text',
    label: 'Genre names',
    description: 'Translates genre names (nightly).',
    primary: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'none' },
    fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'none' },
  },
  baseEvents: {
    kind: 'text',
    label: 'Occasion match',
    description: 'Decides which gift occasions a playlist belongs to (calendar backfill).',
    primary: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'low' },
    fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'none' },
  },

  // Admin -----------------------------------------------------------------------
  mailTranslate: {
    kind: 'text',
    label: 'Mail translation',
    description: 'Translates a Dutch mail to a customer or business contact into their language.',
    primary: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' },
    fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'none' },
  },
  orderExtract: {
    kind: 'text',
    label: 'Printer invoice extraction',
    description: 'Reads order numbers, dates and amounts from a pasted printer invoice.',
    primary: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium' },
    fallback: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'low' },
  },

  // Images and speech (OpenAI only: Anthropic has neither) -------------------------
  eventBanner: {
    kind: 'image',
    label: 'Occasion hero image',
    description: 'The hero banner of a gift-occasion page.',
    primary: { provider: 'openai', model: 'gpt-image-2.5-sunburst' },
    timeoutMs: 300_000,
  },
  productPhoto: {
    kind: 'image',
    label: 'Merchant Center product photo',
    description: 'The Google Shopping product photo of a featured playlist (nightly).',
    primary: { provider: 'openai', model: 'gpt-image-2.5-sunburst' },
    timeoutMs: 300_000,
  },
  speechTest: {
    kind: 'speech',
    label: 'Text to speech',
    description: 'The dev-only audio test route.',
    primary: { provider: 'openai', model: 'gpt-4o-mini-tts' },
  },
} as const satisfies Record<string, LlmTaskConfig>;

export type LlmTask = keyof typeof LLM_TASKS;

type TasksOfKind<K> = {
  [T in LlmTask]: (typeof LLM_TASKS)[T]['kind'] extends K ? T : never;
}[LlmTask];

export type TextTask = TasksOfKind<'text'>;
export type ImageTask = TasksOfKind<'image'>;
export type SpeechTask = TasksOfKind<'speech'>;

export function taskConfig(task: LlmTask): LlmTaskConfig {
  return LLM_TASKS[task] as LlmTaskConfig;
}
