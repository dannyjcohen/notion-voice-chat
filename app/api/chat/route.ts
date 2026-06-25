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
import { buildSystemPrompt, buildLegacySystemPrompt } from '@/lib/prompts';
import { getEasternDateString, getEasternTomorrowString } from '@/lib/date';

// ── Types for tool events ──────────────────────────────────────────────────
type StreamPart =
  | { type: 'text-delta'; text: string | undefined }
  | { type: 'tool-call'; toolName: string; input: unknown }
  | { type: 'tool-result'; toolName: string; output: unknown }
  | { type: 'error'; error: unknown }
  | { type: string; [key: string]: unknown };

export const maxDuration = 30;

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
  const today = getEasternDateString();

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
        const dateStr = getEasternTomorrowString();
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
