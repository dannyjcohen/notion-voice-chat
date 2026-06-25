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
    'You are a task cleanup assistant. You receive a voice transcript and a Notion task, and you return cleaned-up task fields as JSON. Return valid JSON only, no markdown, no explanation. Your entire response must be a single line of compact JSON — no literal newlines or extra whitespace.';

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
3. DATE TO WORK ON: If the user mentions a day of the week (e.g. "Monday") or a relative date, resolve it to a specific YYYY-MM-DD date. Rules: (a) A named day like "Monday" means the next future Monday — never today, never a past date. (b) "Next week" means the Monday of next calendar week. (c) "This week" means the Monday of the current calendar week (or the next weekday if Monday has passed). (d) "Next month" means the 1st of next month. If no date is mentioned, omit this field.
4. PRIORITY: Include only if the user explicitly mentions a priority level. Values: Urgent, High, Medium, Low.
5. PROJECT MATCHES: Return a top-level "projectMatches" array (NOT inside "fields") containing up to 3 project IDs ordered from most to least likely. Use any context clue — keywords, abbreviations, company names, product names, topics. Partial/approximate matches are fine. Include all plausible candidates up to 3. Return an empty array only if there is genuinely zero connection to any project.
6. EFFORT: Include only if the user explicitly mentions effort level. Values: High, Medium, Low.
7. AI AGENT TAKE CARE:
   - Set to true if the user says AI/an agent should handle it ("AI can handle this", "have the agent do it", "delegate to AI", etc.).
   - Set to false if the user explicitly says they will do it themselves ("I'll do this", "me working on it", "I'm handling it", "it's going to be me", etc.).
   - Omit entirely only if the user says nothing about who will do the task.
8. COMPLETENESS: Set to "complete" if dateToWorkOn AND priority are both present (title, description, and project are always generated so they don't affect completeness). Otherwise "partial".

Return a JSON object in exactly this shape (example values shown):
{"fields":{"title":"Review NCTC contract proposal","description":"User wants to review the contract before Tuesday call. Original: nctc contract","dateToWorkOn":"2026-06-30","priority":"High","effort":"Medium","aiAgentTakeCare":false},"projectMatches":["abc-123","def-456","ghi-789"],"completeness":"complete"}

Field rules:
- "title" and "description" must always be present.
- "dateToWorkOn", "priority", "effort" — include only when applicable. If not applicable, omit the key entirely (do not include null or empty string).
- "projectMatches" — top-level array of up to 3 project IDs (strings), most likely first. Do NOT put project inside "fields".
- "aiAgentTakeCare" — include true (AI handles it), false (user explicitly said they will do it), or omit entirely (not mentioned).
- "completeness" must be either "complete" or "partial".
- Output only the JSON object. No explanation, no markdown fences.`;

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    // Strip markdown code fences if present
    let raw = result.text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    // Replace literal newlines/tabs inside JSON string values with their escape sequences.
    // LLMs sometimes emit them unescaped even when asked not to.
    raw = raw.replace(/"((?:[^"\\]|\\.)*)"/g, (_match, inner: string) => {
      return '"' + inner.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
    });

    let parsed: { fields: Record<string, unknown>; completeness: 'complete' | 'partial'; projectMatches?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('[parse-voice] JSON parse failed. Raw AI output:', raw);
      const preview = raw.slice(0, 800);
      return Response.json({ error: `AI response could not be parsed as JSON. Raw: ${preview}` }, { status: 500 });
    }

    // Resolve projectMatches IDs → { id, name } objects, server-side
    const rawMatchIds: string[] = Array.isArray(parsed.projectMatches)
      ? (parsed.projectMatches as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];

    // Also support legacy projectId in fields (graceful fallback)
    const legacyId = typeof parsed.fields.projectId === 'string' ? parsed.fields.projectId : null;
    const allCandidateIds = rawMatchIds.length > 0 ? rawMatchIds : (legacyId ? [legacyId] : []);

    const projectMatches = allCandidateIds
      .slice(0, 3)
      .map((id) => projects.find((p) => p.id === id))
      .filter((p): p is NotionProject => p != null)
      .map((p) => ({ id: p.id, name: p.name }));

    // Inject top match into fields so consumers can read projectId/projectName directly
    if (projectMatches.length > 0) {
      parsed.fields.projectId = projectMatches[0].id;
      parsed.fields.projectName = projectMatches[0].name;
    } else {
      delete parsed.fields.projectId;
      delete parsed.fields.projectName;
    }

    return Response.json({
      fields: parsed.fields ?? {},
      completeness: parsed.completeness ?? 'partial',
      projectMatches,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[parse-voice] generateText error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
