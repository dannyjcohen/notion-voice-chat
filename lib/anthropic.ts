import { createAnthropic } from '@ai-sdk/anthropic';

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('ANTHROPIC_API_KEY not set');
}

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
});

// Model is configurable via AI_MODEL env var.
// Older model aliases (e.g. claude-3-5-haiku-20241022) are mapped to their
// current equivalents so .env.local doesn't need to be updated.
const MODEL_ALIASES: Record<string, string> = {
  'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-5',
  'claude-3-5-sonnet-20240620': 'claude-sonnet-4-5',
  'claude-3-opus-20240229': 'claude-opus-4-5',
};

const rawModel = process.env.AI_MODEL ?? 'claude-haiku-4-5';
const resolvedModel = MODEL_ALIASES[rawModel] ?? rawModel;

export const model = anthropic(resolvedModel);
