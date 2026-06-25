import { Client } from '@notionhq/client';
import { getEasternTomorrowString } from './date';

const notion = new Client({ auth: process.env.NOTION_API_KEY ?? '' });
const DB_ID = process.env.NOTION_TASK_DB_ID ?? 'e7870227f50445e49d23e78958bbe61b';
const PROJECTS_DB_ID = '1b0bc768-b9e6-4104-bec4-6db7f0cd0977';

// Danny Cohen's Notion user ID — used for "Assigned" people_contains filter
const DANNY_NOTION_USER_ID =
  process.env.NOTION_USER_ID ?? 'dfca4d29-d375-4915-9dc2-3fb2512d5864';

// Priority sort order for in-memory secondary sort
const PRIORITY_ORDER: Record<string, number> = {
  Urgent: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

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
  aiAgentTakeCare: boolean;
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
 *
 * Filter logic:
 *   Assigned contains Danny
 *   AND Status != Completed
 *   AND Status != In Review
 *   AND Status != Icebox
 *   AND AI Clean Up Status != Completed
 *   AND AI Clean Up Status != In Progress
 *
 * Sort: primary = Date To Work On ascending (nulls last via in-code sort),
 *       secondary = Priority (Urgent → High → Medium → Low → null) in code.
 */
export async function getNextTaskDirect(skipIds: string[]): Promise<NotionTask | null> {
  const response = await notion.databases.query({
    database_id: DB_ID,
    filter: {
      and: [
        {
          property: 'Assigned',
          people: {
            contains: DANNY_NOTION_USER_ID,
          },
        },
        {
          property: 'Status',
          status: {
            does_not_equal: 'Completed',
          },
        },
        {
          property: 'Status',
          status: {
            does_not_equal: 'In Review',
          },
        },
        {
          property: 'Status',
          status: {
            does_not_equal: 'Icebox',
          },
        },
        {
          property: 'AI Clean Up Status',
          select: {
            does_not_equal: 'Completed',
          },
        },
        {
          property: 'AI Clean Up Status',
          select: {
            does_not_equal: 'In Progress',
          },
        },
      ],
    } as Parameters<typeof notion.databases.query>[0]['filter'],
    sorts: [
      {
        property: 'Date To Work On',
        direction: 'ascending',
      },
    ],
    page_size: skipIds.length + 50, // fetch extra to account for skip list + in-code sort
  });

  // Filter out skipped tasks
  const candidates = response.results.filter(
    (p) => p.object === 'page' && !skipIds.includes(p.id)
  );

  if (candidates.length === 0) return null;

  // Secondary sort by priority (Notion only supports one sort key)
  // Primary: Date To Work On ascending (nulls last) — already sorted by Notion
  // Secondary: in-code priority sort within same date bucket
  const sorted = [...candidates].sort((a, b) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aProps = (a as any).properties;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bProps = (b as any).properties;

    const aDate: string | null = aProps['Date To Work On']?.date?.start ?? null;
    const bDate: string | null = bProps['Date To Work On']?.date?.start ?? null;

    // Nulls last
    if (aDate === null && bDate !== null) return 1;
    if (aDate !== null && bDate === null) return -1;
    if (aDate !== bDate) {
      if (aDate === null || bDate === null) return 0;
      return aDate < bDate ? -1 : 1;
    }

    // Same date — sort by priority
    const aPri: string | null = aProps['Priority']?.select?.name ?? null;
    const bPri: string | null = bProps['Priority']?.select?.name ?? null;
    const aOrder = aPri !== null ? (PRIORITY_ORDER[aPri] ?? 4) : 4;
    const bOrder = bPri !== null ? (PRIORITY_ORDER[bPri] ?? 4) : 4;
    return aOrder - bOrder;
  });

  const page = sorted[0];
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
  const aiAgentTakeCare: boolean = props['AI Agent Take Care']?.checkbox ?? false;

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
    aiAgentTakeCare,
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
    title?: string;
    priority?: string;
    dateToWorkOn?: string;
    status?: string;
    description?: string;
    effort?: string;
    aiCleanUpStatus?: string;
    projectId?: string;
    aiAgentTakeCare?: boolean;
  }
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const properties: Record<string, any> = {};

  if (fields.title != null) {
    properties['Task'] = {
      title: [{ text: { content: fields.title } }],
    };
  }

  if (fields.priority != null) {
    properties['Priority'] = { select: { name: fields.priority } };
  }

  if (fields.dateToWorkOn != null) {
    properties['Date To Work On'] = { date: { start: fields.dateToWorkOn } };
  }

  if (fields.status != null) {
    // Status is a "status" type in Notion (not "select")
    properties['Status'] = { status: { name: fields.status } };
  }

  if (fields.description != null) {
    properties['Description'] = {
      rich_text: [{ text: { content: fields.description } }],
    };
  }

  if (fields.effort != null) {
    properties['Effort'] = { select: { name: fields.effort } };
  }

  if (fields.aiCleanUpStatus != null) {
    properties['AI Clean Up Status'] = { select: { name: fields.aiCleanUpStatus } };
  }

  if (fields.projectId != null) {
    properties['Projects'] = {
      relation: [{ id: fields.projectId }],
    };
  }

  if (fields.aiAgentTakeCare != null) {
    properties['AI Agent Take Care'] = { checkbox: fields.aiAgentTakeCare };
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
  const dateStr = getEasternTomorrowString();

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
