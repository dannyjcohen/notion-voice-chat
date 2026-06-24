import { updateTask } from '@/lib/notion';

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      taskId: string;
      fields: {
        priority?: string;
        dateToWorkOn?: string;
        status?: string;
        description?: string;
        effort?: string;
        aiCleanUpStatus?: string;
        projectId?: string;
        aiAgentTakeCare?: boolean;
      };
    };

    const { taskId, fields } = body;

    if (!taskId || typeof taskId !== 'string') {
      return Response.json({ error: 'taskId is required' }, { status: 400 });
    }

    if (!fields || typeof fields !== 'object') {
      return Response.json({ error: 'fields is required' }, { status: 400 });
    }

    await updateTask(taskId, fields);
    return Response.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[tasks/update] error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
