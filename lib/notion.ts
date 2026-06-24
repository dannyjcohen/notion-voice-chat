import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY ?? '' });
const DB_ID = process.env.NOTION_TASK_DB_ID ?? 'e7870227f50445e49d23e78958bbe61b';

export interface NotionTask {
  id: string;
  title: string;
  date: string | null;
  description: string | null;
  priority: string | null;
  status: string | null;
}

export async function getNextTask(): Promise<NotionTask | null> {
  const response = await notion.databases.query({
    database_id: DB_ID,
    filter: {
      or: [
        {
          property: 'AI Clean Up Status',
          status: {
            does_not_equal: 'Completed',
          },
        },
        {
          property: 'AI Clean Up Status',
          status: {
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
    page_size: 1,
  });

  const page = response.results[0];
  if (!page || page.object !== 'page') return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = (page as any).properties;

  const title: string =
    props['Task']?.title?.[0]?.plain_text ?? '(Untitled)';

  const date: string | null =
    props['Date To Work On']?.date?.start ?? null;

  const description: string | null =
    props['Description']?.rich_text?.[0]?.plain_text ?? null;

  const priority: string | null =
    props['Priority']?.select?.name ?? null;

  const status: string | null =
    props['AI Clean Up Status']?.status?.name ?? null;

  return {
    id: page.id,
    title,
    date,
    description,
    priority,
    status,
  };
}

export async function markTaskDone(taskId: string): Promise<void> {
  await notion.pages.update({
    page_id: taskId,
    properties: {
      'AI Clean Up Status': {
        status: {
          name: 'Completed',
        },
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
        date: {
          start: dateStr,
        },
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
      title: [
        {
          text: {
            content: fields.title,
          },
        },
      ],
    };
  }

  if (fields.description !== undefined) {
    properties['Description'] = {
      rich_text: [
        {
          text: {
            content: fields.description,
          },
        },
      ],
    };
  }

  if (fields.dueDate !== undefined) {
    properties['Date To Work On'] = {
      date: {
        start: fields.dueDate,
      },
    };
  }

  if (Object.keys(properties).length === 0) return;

  await notion.pages.update({
    page_id: taskId,
    properties,
  });
}
