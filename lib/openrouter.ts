import { createOpenRouter } from '@openrouter/ai-sdk-provider';

if (!process.env.OPENROUTER_API_KEY) {
  console.warn('OPENROUTER_API_KEY not set');
}

export const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
});

// Cap max_tokens so the request stays within the OpenRouter account credit limit.
// Without this cap OpenRouter uses the model's default max (64K for Claude Sonnet),
// which requires more credits than a modest balance can cover and returns a 402.
export const model = openrouter(
  process.env.AI_MODEL ?? 'anthropic/claude-sonnet-4-5',
  { maxTokens: 800 }
);
