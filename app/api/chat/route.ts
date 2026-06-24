import { streamText, stepCountIs } from 'ai';
import { zodSchema } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { model } from '@/lib/openrouter';
import {
  getNextTask,
  markTaskDone,
  skipTask,
  updateTaskFields,
} from '@/lib/notion';

// ── Types for tool events ──────────────────────────────────────────────────

type StreamPart =
  | { type: 'text-delta'; textDelta: string }
  | { type: 'tool-call'; toolName: string; args: unknown }
  | { type: 'tool-result'; toolName: string; result: unknown }
  | { type: 'finish' | 'error' | 'step-start' | 'step-finish'; [key: string]: unknown };

export const maxDuration = 30;

const SYSTEM_PROMPT = `You are a helpful AI task reviewer. You have access to the user's Notion task queue via tools.

Start by calling getNextTask to fetch the first task, then have a brief voice conversation about it. Help the user decide what to do: mark it done, skip it to tomorrow, update its details, or ask questions. After each decision, automatically get the next task and continue.

Keep responses concise — this is a voice conversation, not a text chat. Aim for 1-3 sentences per response. When proposing to mark done or skip, briefly state what you're about to do and do it.`;

export async function POST(request: Request) {
  if (!process.env.OPENROUTER_API_KEY) {
    return new Response(
      JSON.stringify({
        error: 'OPENROUTER_API_KEY is not configured. Set it in your environment variables.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const { messages } = await request.json();

  try {
    const result = streamText({
      model,
      system: SYSTEM_PROMPT,
      messages,
      stopWhen: stepCountIs(10),
      tools: {
        getNextTask: {
          description:
            'Fetch the next unreviewed task from the Notion task queue. Returns the task details or indicates the queue is empty.',
          inputSchema: zodSchema(z.object({})),
          execute: async () => {
            const task = await getNextTask();
            if (!task) {
              return { empty: true, message: 'No more tasks in the queue.' };
            }
            return { empty: false, task };
          },
        },
        markTaskDone: {
          description:
            'Mark a Notion task as completed by setting its AI Clean Up Status to Completed.',
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
            return {
              success: true,
              message: `Task ${taskId} rescheduled to ${dateStr}.`,
            };
          },
        },
        updateTaskFields: {
          description:
            'Update one or more fields on a Notion task: title, description, or due date.',
          inputSchema: zodSchema(
            z.object({
              taskId: z.string().describe('The Notion page ID of the task to update.'),
              title: z.string().optional().describe('New title for the task.'),
              description: z.string().optional().describe('New description for the task.'),
              dueDate: z
                .string()
                .optional()
                .describe('New due date in YYYY-MM-DD format.'),
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
      },
    });

    // Build a custom text stream that injects [TOOL:...] / [TOOL_RESULT:...] lines
    // so the client can log tool calls in the debug panel without a separate channel.
    const encoder = new TextEncoder();
    const customStream = new ReadableStream({
      async start(controller) {
        try {
          for await (const part of result.fullStream as AsyncIterable<StreamPart>) {
            if (part.type === 'text-delta') {
              controller.enqueue(encoder.encode(part.textDelta));
            } else if (part.type === 'tool-call') {
              // Inject a tool call marker line (filtered out on the client side)
              controller.enqueue(
                encoder.encode(`\n[TOOL:${part.toolName}:${JSON.stringify(part.args)}]\n`)
              );
            } else if (part.type === 'tool-result') {
              // Inject a tool result marker line (filtered out on the client side)
              const resultStr = JSON.stringify(part.result).slice(0, 500);
              controller.enqueue(
                encoder.encode(`\n[TOOL_RESULT:${part.toolName}:${resultStr}]\n`)
              );
            }
          }
        } catch (streamErr) {
          const message = streamErr instanceof Error ? streamErr.message : String(streamErr);
          console.error('[chat] stream error:', message);
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
