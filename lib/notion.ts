import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY ?? '' });
const DB_ID = process.env.NOTION_TASK_DB_ID ?? 'e7870227f50445e49d23e78958bbe61b';
const PROJECTS_DB_ID = '1b0bc768-b9e6-4104-bec4-6db7f0cd0977';

// ── Shared types ─────────────────────────────────────────────────────────────

export interface NotionTask {
  id: string;
  title: string;
  priority: string | null;
  dateToWorkOn: string | null;
  status: string | null;
  description: string | null;
  effort: string | null;
  aiCleanUpStatus: string | null;
  projectId: string | null;
  projectName: string | null;
}

export interface NotionProject {
  id: string;
  name: string;
  description: string | null;
}

// ── Legacy alias kept for backward compat with old /api/chat route ───────────

/** @deprecated Use getNextTaskDirect instead */
export async function getNextTask(): Promise<NotionTask | null> {
  return getNextTaskDirect([]);
}

// ── New direct-query functions ────────────────────────────────────────────────

/**
 * Fetch the next unreviewed task, excluding any task IDs in the skip list.
 * "Unreviewed" = AI Clean Up Status is not "Completed" (or is empty).
 */
export async function getNextTaskDirect(skipIds: string[]): Promise<NotionTask | null> {
  const response = await notion.databases.query({
    database_id: DB_ID,
    filter: {
      or: [
        {
          property: 'AI Clean Up Status',
          select: {
            does_not_equal: 'Completed',
          },
        },
        {
          property: 'AI Clean Up Status',
          select: {
            is_empty: true,
          },
        },
      ],
    },
    sorts: [
      {
        timestamp: 'created_time',
        direction: 'ascending',
      },
    ],
    page_size: skipIds.length + 10, // fetch extra to account for skip list
  });

  // Find the first result not in skipIds
  const page = response.results.find(
    (p) => p.object === 'page' && !skipIds.includes(p.id)
  );

  if (!page || page.object !== 'page') return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = (page as any).properties;

  const title: string = props['Task']?.title?.[0]?.plain_text ?? '(Untitled)';
  const priority: string | null = props['Priority']?.select?.name ?? null;
  const dateToWorkOn: string | null = props['Date To Work On']?.date?.start ?? null;
  // Status is a "status" type, not "select" — access via .status.name
  const status: string | null = props['Status']?.status?.name ?? null;
  const description: string | null = props['Description']?.rich_text?.[0]?.plain_text ?? null;
  const effort: string | null = props['Effort']?.select?.name ?? null;
  const aiCleanUpStatus: string | null = props['AI Clean Up Status']?.select?.name ?? null;

  // First related project ID
  const projectRelations: { id: string }[] = props['Projects']?.relation ?? [];
  const projectId: string | null = projectRelations[0]?.id ?? null;

  // Resolve project name if we have a project ID
  let projectName: string | null = null;
  if (projectId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const projectPage = await notion.pages.retrieve({ page_id: projectId }) as any;
      projectName = projectPage.properties?.['Name']?.title?.[0]?.plain_text ?? null;
    } catch {
      // Non-fatal — project might be archived or inaccessible
    }
  }

  return {
    id: page.id,
    title,
    priority,
    dateToWorkOn,
    status,
    description,
    effort,
    aiCleanUpStatus,
    projectId,
    projectName,
  };
}

/**
 * Fetch all projects from the Projects database.
 */
export async function getAllProjects(): Promise<NotionProject[]> {
  const projects: NotionProject[] = [];
  let cursor: string | undefined;

  do {
    const response = await notion.databases.query({
      database_id: PROJECTS_DB_ID,
      sorts: [{ property: 'Name', direction: 'ascending' }],
      page_size: 100,
      start_cursor: cursor,
    });

    for (const page of response.results) {
      if (page.object !== 'page') continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const props = (page as any).properties;
      const name: string = props['Name']?.title?.[0]?.plain_text ?? '(Untitled)';
      const description: string | null =
        props['Project Description']?.rich_text?.[0]?.plain_text ?? null;
      projects.push({ id: page.id, name, description });
    }

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return projects;
}

/**
 * Update a task's properties. Only fields present in the `fields` object are updated.
 */
export async function updateTask(
  taskId: string,
  fields: {
    priority?: string;
    dateToWorkOn?: string;
    status?: string;
    description?: string;
    effort?: string;
    aiCleanUpStatus?: string;
    projectId?: string;
  }
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const properties: Record<string, any> = {};

  if (fields.priority !== undefined) {
    properties['Priority'] = { select: { name: fields.priority } };
  }

  if (fields.dateToWorkOn !== undefined) {
    properties['Date To Work On'] = { date: { start: fields.dateToWorkOn } };
  }

  if (fields.status !== undefined) {
    // Status is a "status" type in Notion (not "select")
    properties['Status'] = { status: { name: fields.status } };
  }

  if (fields.description !== undefined) {
    properties['Description'] = {
      rich_text: [{ text: { content: fields.description } }],
    };
  }

  if (fields.effort !== undefined) {
    properties['Effort'] = { select: { name: fields.effort } };
  }

  if (fields.aiCleanUpStatus !== undefined) {
    properties['AI Clean Up Status'] = { select: { name: fields.aiCleanUpStatus } };
  }

  if (fields.projectId !== undefined) {
    properties['Projects'] = {
      relation: [{ id: fields.projectId }],
    };
  }

  if (Object.keys(properties).length === 0) return;

  await notion.pages.update({ page_id: taskId, properties });
}

// ── Legacy functions kept for backward compat with old /api/chat tools ───────

export async function markTaskDone(taskId: string): Promise<void> {
  await notion.pages.update({
    page_id: taskId,
    properties: {
      'AI Clean Up Status': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        select: { name: 'Completed' } as any,
      },
    },
  });
}

export async function skipTask(taskId: string): Promise<void> {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().split('T')[0];

  await notion.pages.update({
    page_id: taskId,
    properties: {
      'Date To Work On': {
        date: { start: dateStr },
      },
    },
  });
}

export async function updateTaskFields(
  taskId: string,
  fields: { title?: string; description?: string; dueDate?: string }
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const properties: Record<string, any> = {};

  if (fields.title !== undefined) {
    properties['Task'] = {
      title: [{ text: { content: fields.title } }],
    };
  }

  if (fields.description !== undefined) {
    properties['Description'] = {
      rich_text: [{ text: { content: fields.description } }],
    };
  }

  if (fields.dueDate !== undefined) {
    properties['Date To Work On'] = {
      date: { start: fields.dueDate },
    };
  }

  if (Object.keys(properties).length === 0) return;

  await notion.pages.update({ page_id: taskId, properties });
}
