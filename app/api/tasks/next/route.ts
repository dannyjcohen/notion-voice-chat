import { getNextTaskDirect } from '@/lib/notion';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const skipParam = searchParams.get('skip');
  const skipIds = skipParam ? skipParam.split(',').filter(Boolean) : [];

  try {
    const task = await getNextTaskDirect(skipIds);
    return Response.json({ task });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[tasks/next] error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
