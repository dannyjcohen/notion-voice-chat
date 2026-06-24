import { getAllProjects } from '@/lib/notion';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const projects = await getAllProjects();
    return Response.json({ projects });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[projects] error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
