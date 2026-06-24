export async function GET() {
  return Response.json({
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    NOTION_API_KEY: !!process.env.NOTION_API_KEY,
    NOTION_DATABASE_ID: !!process.env.NOTION_DATABASE_ID,
    AI_MODEL: process.env.AI_MODEL ?? '(not set)',
    NODE_ENV: process.env.NODE_ENV,
    cwd: process.cwd(),
  });
}
