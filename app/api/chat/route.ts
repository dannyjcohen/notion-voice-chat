import { streamText, stepCountIs } from 'ai';
import { zodSchema } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { model } from '@/lib/anthropic';
import {
  markTaskDone,
  skipTask,
  updateTaskFields,
} from '@/lib/notion';
import type { NotionTask, NotionProject } from '@/lib/notion';

// ── Types for tool events ──────────────────────────────────────────────────
type StreamPart =
  | { type: 'text-delta'; text: string | undefined }
  | { type: 'tool-call'; toolName: string; input: unknown }
  | { type: 'tool-result'; toolName: string; output: unknown }
  | { type: 'error'; error: unknown }
  | { type: string; [key: string]: unknown };

export const maxDuration = 30;

// ── System prompt template ─────────────────────────────────────────────────

function buildSystemPrompt(
  today: string,
  currentTask: NotionTask | null,
  projects: NotionProject[]
): string {
  const taskJson = currentTask ? JSON.stringify(currentTask, null, 2) : 'null';
  const projectsJson = JSON.stringify(
    projects.map((p) => ({ id: p.id, name: p.name, description: p.description })),
    null,
    2
  );

  return `You are a Notion task reviewer helping the user quickly process their task backlog in a voice/text conversation.

CONTEXT PROVIDED PER REQUEST:
- currentTask: the task being reviewed (id, title, existing properties)
- projects: list of all available projects [{id, name, description}]

CURRENT TASK:
${taskJson}

AVAILABLE PROJECTS:
${projectsJson}

YOUR JOB:
Analyze the user's message and decide ONE of:

1. SKIP — User wants to skip this task for now (says things like "skip", "not now", "next task", "move on", etc.)
   Respond with ONLY this JSON (no other text):
   {"action":"skip"}

2. UPDATE — User provided information about the task.
   Extract as many fields as possible from the message + existing task data.
   Fields to fill: priority, dateToWorkOn (YYYY-MM-DD), status, description, effort, aiCleanUpStatus, projectId

   For projectId: match the task to the most appropriate project from the projects list based on the task title, description, and user's message. Use your best judgment.

   If you have enough info to fill ALL required fields (at minimum: description and either priority or dateToWorkOn), respond with ONLY this JSON:
   {"action":"update","fields":{"priority":"...","dateToWorkOn":"...","status":"...","description":"...","effort":"...","aiCleanUpStatus":"Completed","projectId":"..."}}

   If you're missing critical info, ask ONE focused follow-up question as plain text (not JSON). Keep it short — one sentence.

IMPORTANT RULES:
- When responding with action JSON, output ONLY the raw JSON object with NO markdown formatting, NO code blocks, NO backticks, NO extra text before or after
- When asking a follow-up, keep it to one sentence
- Never wrap output in markdown code fences or backticks
- aiCleanUpStatus should be set to "Completed" whenever you update a task (it's been reviewed)
- For dateToWorkOn: if user says "tomorrow" calculate from today's date
- For priority: normalize to one of: Urgent, High, Medium, Low
- For effort: normalize to one of: High, Medium, Low
- For status: normalize to one of: Backlog, Blocked, On Deck, Scheduled, Today, Icebox, In Progress, Pending, Approved, Ongoing, In Review, Completed
- Today's date: ${today}`;
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({
        error: 'ANTHROPIC_API_KEY is not configured. Set it in your environment variables.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const body = await request.json() as {
    messages: { role: string; content: string }[];
    currentTask?: NotionTask | null;
    projects?: NotionProject[];
  };

  const { messages, currentTask = null, projects = [] } = body;
  const today = new Date().toISOString().split('T')[0];

  // Build context-aware system prompt when task/projects are provided
  const systemPrompt =
    currentTask || projects.length > 0
      ? buildSystemPrompt(today, currentTask, projects)
      : buildLegacySystemPrompt();

  try {
    // In the new flow (currentTask provided), AI returns JSON actions — no tools needed.
    // In legacy flow (no currentTask), wire up the old Notion tools.
    const streamOptions = currentTask
      ? { model, system: systemPrompt, messages, stopWhen: stepCountIs(10) }
      : { model, system: systemPrompt, messages, stopWhen: stepCountIs(10), tools: buildLegacyTools() };

    const result = streamText(streamOptions as Parameters<typeof streamText>[0]);

    const encoder = new TextEncoder();
    const customStream = new ReadableStream({
      async start(controller) {
        try {
          for await (const part of result.fullStream as AsyncIterable<StreamPart>) {
            if (part.type === 'text-delta') {
              controller.enqueue(encoder.encode(typeof part.text === 'string' ? part.text : ''));
            } else if (part.type === 'tool-call') {
              controller.enqueue(
                encoder.encode(`\n[TOOL:${part.toolName}:${JSON.stringify(part.input)}]\n`)
              );
            } else if (part.type === 'tool-result') {
              const resultStr = JSON.stringify(part.output).slice(0, 500);
              controller.enqueue(
                encoder.encode(`\n[TOOL_RESULT:${part.toolName}:${resultStr}]\n`)
              );
            } else if (part.type === 'error') {
              const errMsg =
                part.error instanceof Error ? part.error.message : String(part.error ?? 'Unknown error');
              console.error('[chat] stream error part:', errMsg);
              controller.enqueue(encoder.encode(`\n[ERROR:${errMsg.slice(0, 300)}]\n`));
            }
          }
        } catch (streamErr) {
          const message = streamErr instanceof Error ? streamErr.message : String(streamErr);
          console.error('[chat] stream exception:', message);
          controller.enqueue(encoder.encode(`\n[ERROR:${message.slice(0, 300)}]\n`));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(customStream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[chat] streamText error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}

// ── Legacy system prompt (no task context) ────────────────────────────────

function buildLegacySystemPrompt(): string {
  return `You are a helpful AI task reviewer. You have access to the user's Notion task queue via tools.

Start by calling getNextTask to fetch the first task, then have a brief voice conversation about it. Help the user decide what to do: mark it done, skip it to tomorrow, update its details, or ask questions. After each decision, automatically get the next task and continue.

Keep responses concise — this is a voice conversation, not a text chat. Aim for 1-3 sentences per response. When proposing to mark done or skip, briefly state what you're about to do and do it.`;
}

// ── Legacy tools (kept for backward compat) ───────────────────────────────

function buildLegacyTools() {
  return {
    markTaskDone: {
      description: 'Mark a Notion task as completed by setting its AI Clean Up Status to Completed.',
      inputSchema: zodSchema(
        z.object({
          taskId: z.string().describe('The Notion page ID of the task to mark as done.'),
        })
      ),
      execute: async ({ taskId }: { taskId: string }) => {
        await markTaskDone(taskId);
        return { success: true, message: `Task ${taskId} marked as completed.` };
      },
    },
    skipTask: {
      description: "Skip a Notion task by rescheduling it to tomorrow's date.",
      inputSchema: zodSchema(
        z.object({
          taskId: z.string().describe('The Notion page ID of the task to skip.'),
        })
      ),
      execute: async ({ taskId }: { taskId: string }) => {
        await skipTask(taskId);
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dateStr = tomorrow.toISOString().split('T')[0];
        return { success: true, message: `Task ${taskId} rescheduled to ${dateStr}.` };
      },
    },
    updateTaskFields: {
      description: 'Update one or more fields on a Notion task: title, description, or due date.',
      inputSchema: zodSchema(
        z.object({
          taskId: z.string().describe('The Notion page ID of the task to update.'),
          title: z.string().optional().describe('New title for the task.'),
          description: z.string().optional().describe('New description for the task.'),
          dueDate: z.string().optional().describe('New due date in YYYY-MM-DD format.'),
        })
      ),
      execute: async ({
        taskId,
        title,
        description,
        dueDate,
      }: {
        taskId: string;
        title?: string;
        description?: string;
        dueDate?: string;
      }) => {
        await updateTaskFields(taskId, { title, description, dueDate });
        return { success: true, message: `Task ${taskId} updated.` };
      },
    },
  };
}
