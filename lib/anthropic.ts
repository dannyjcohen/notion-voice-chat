import { createAnthropic } from '@ai-sdk/anthropic';

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('ANTHROPIC_API_KEY not set');
}

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
});

// Model is configurable via AI_MODEL env var — defaults to claude-3-5-haiku
// which is fast and cheap. Swap to claude-sonnet-4-5 for more capable responses.
export const model = anthropic(
  process.env.AI_MODEL ?? 'claude-3-5-haiku-20241022'
);
