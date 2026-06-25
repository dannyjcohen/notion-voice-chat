import { generateText } from 'ai';
import { model } from '@/lib/anthropic';
import { getEasternDateString } from '@/lib/date';
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

  const today = getEasternDateString();

  const systemPrompt =
    'You are a task cleanup assistant. You receive a voice transcript and a Notion task, and you return cleaned-up task fields as JSON. Return valid JSON only, no other text.';

  const projectList = projects
    .map((p) => `  - id: "${p.id}", name: "${p.name}"`)
    .join('\n');

  const userMessage = `Today's date: ${today}

Current task:
  Title: ${task.title}
  Priority: ${task.priority ?? 'not set'}
  Date To Work On: ${task.dateToWorkOn ?? 'not set'}
  Description: ${task.description ?? 'not set'}
  Effort: ${task.effort ?? 'not set'}
  Project: ${task.projectName ?? 'not set'}
  AI Agent Take Care: ${task.aiAgentTakeCare ? 'yes' : 'no'}

Available projects:
${projectList || '  (none)'}

Transcript:
"${transcript}"

Instructions:
1. TITLE (always required): Write a concise imperative action statement describing what needs to be done (e.g. "Set up project timeline for NCTC"). Never use the original title as-is.
2. DESCRIPTION (always required): Summarize what the user said about this task. Always append the original task title at the very end, on its own line, prefixed with "Original: ".
3. DATE TO WORK ON: If the user mentions a day of the week (e.g. "Monday") or a relative date (e.g. "next week"), resolve it to a specific YYYY-MM-DD date. ALWAYS choose the next future occurrence — never a date in the past or today. If no date is mentioned, omit this field.
4. PRIORITY: Include only if the user explicitly mentions a priority level. Values: Urgent, High, Medium, Low.
5. PROJECT: Try to match to one of the available projects based on context clues in the transcript, even if not explicitly named. If you can make a reasonable match, include the project id. If genuinely unclear, omit.
6. EFFORT: Include only if the user explicitly mentions effort level. Values: High, Medium, Low.
7. AI AGENT TAKE CARE: Set to true only if the user explicitly says something like "AI can handle this", "have the agent do it", "delegate to AI", etc. Omit otherwise.
8. COMPLETENESS: Set to "complete" if dateToWorkOn AND priority are both present (title, description, and project are always generated so they don't affect completeness). Otherwise "partial".

Return JSON in this exact shape:
{
  "fields": {
    "title": "string (always required)",
    "description": "string (always required, ends with 'Original: <original title>')",
    "dateToWorkOn": "YYYY-MM-DD (omit if not mentioned)",
    "priority": "Urgent | High | Medium | Low (omit if not mentioned)",
    "projectId": "matched project id (omit if genuinely unclear)",
    "effort": "High | Medium | Low (omit if not mentioned)",
    "aiAgentTakeCare": true (omit if not mentioned)
  },
  "completeness": "complete | partial"
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

    let parsed: { fields: Record<string, unknown>; completeness: 'complete' | 'partial' };
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
