import { generateText } from 'ai';
import { model } from '@/lib/anthropic';
import type { NotionTask, NotionProject } from '@/lib/notion';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = await request.json() as {
    transcript: string;
    task: NotionTask;
    projects: NotionProject[];
  };

  const { transcript, task, projects } = body;

  if (!transcript || transcript.trim().length === 0) {
    return Response.json({ error: 'transcript is required' }, { status: 400 });
  }

  const systemPrompt =
    'You are a task field extraction assistant. Extract ONLY the fields the user explicitly mentioned. Return valid JSON only, no other text.';

  const projectList = projects
    .map((p) => `  - id: "${p.id}", name: "${p.name}"`)
    .join('\n');

  const userMessage = `Current task:
  Title: ${task.title}
  Priority: ${task.priority ?? 'not set'}
  Date To Work On: ${task.dateToWorkOn ?? 'not set'}
  Description: ${task.description ?? 'not set'}
  Project: ${task.projectName ?? 'not set'}

Available projects:
${projectList || '  (none)'}

Transcript:
"${transcript}"

Return JSON in this exact shape — include only fields the user explicitly mentioned:
{
  "fields": {
    "title": "string (optional)",
    "description": "string (optional)",
    "dateToWorkOn": "YYYY-MM-DD (optional)",
    "priority": "Urgent | High | Medium | Low (optional)",
    "projectId": "matched project id string (optional)"
  },
  "completeness": "complete if all 5 fields are present, otherwise partial"
}`;

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    // Strip markdown code fences if present
    const raw = result.text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    let parsed: { fields: Record<string, string>; completeness: 'complete' | 'partial' };
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('[parse-voice] JSON parse failed. Raw AI output:', raw);
      return Response.json({ error: 'AI response could not be parsed as JSON' }, { status: 500 });
    }

    return Response.json({ fields: parsed.fields ?? {}, completeness: parsed.completeness ?? 'partial' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[parse-voice] generateText error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
