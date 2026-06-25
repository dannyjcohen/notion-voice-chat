import { buildSystemPrompt, buildLegacySystemPrompt, PROMPT_VARIABLES } from '@/lib/prompts';
import { CopyButton } from './CopyButton';

// Server component — renders the system prompt for local inspection.
// No auth needed (local dev only).

const SAMPLE_TASK = {
  id: 'abc123-notion-page-id',
  title: 'Fix login bug on mobile',
  priority: 'High',
  dateToWorkOn: '2026-06-25',
  status: 'In Progress',
  description: 'Users on iOS cannot log in — the auth redirect fails silently.',
  effort: 'Medium',
  aiCleanUpStatus: null,
  aiAgentTakeCare: false,
  projectId: 'proj-456',
  projectName: 'MyBundle Mobile',
};

const SAMPLE_PROJECTS = [
  { id: 'proj-456', name: 'MyBundle Mobile', description: 'iOS and Android mobile app' },
  { id: 'proj-789', name: 'Vertex', description: 'Internal analytics dashboard' },
];

export default function AdminPage() {
  const today = new Date().toISOString().split('T')[0];

  const mainPrompt = buildSystemPrompt(today, SAMPLE_TASK, SAMPLE_PROJECTS);
  const legacyPrompt = buildLegacySystemPrompt();

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-8 font-mono text-sm">
      <h1 className="text-xl font-bold text-white mb-2">System Prompt Inspector</h1>
      <p className="text-gray-500 text-xs mb-8">
        Local dev only — no auth. Shows the exact prompts sent to the LLM,
        rendered with sample task and project data.
      </p>

      {/* Prompt variables legend */}
      <section className="mb-10">
        <h2 className="text-base font-semibold text-gray-300 mb-3">Prompt Variables</h2>
        <table className="w-full max-w-2xl border-collapse text-xs">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left py-2 pr-4 text-gray-400 font-medium">Variable</th>
              <th className="text-left py-2 text-gray-400 font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {PROMPT_VARIABLES.map((v) => (
              <tr key={v.name} className="border-b border-gray-900">
                <td className="py-2 pr-4 text-green-400">{v.name}</td>
                <td className="py-2 text-gray-300">{v.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Main prompt (with sample data) */}
      <section className="mb-10">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-gray-300">
            Main Prompt
            <span className="ml-2 text-xs text-gray-500 font-normal">
              (rendered with sample task + projects)
            </span>
          </h2>
          <CopyButton text={mainPrompt} label="Copy main prompt" />
        </div>
        <pre className="bg-gray-900 border border-gray-800 rounded-lg p-5 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-gray-200 max-h-[60vh] overflow-y-auto">
          {mainPrompt}
        </pre>
      </section>

      {/* Legacy prompt */}
      <section className="mb-10">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-gray-300">
            Legacy Prompt
            <span className="ml-2 text-xs text-gray-500 font-normal">
              (used when no task context is passed)
            </span>
          </h2>
          <CopyButton text={legacyPrompt} label="Copy legacy prompt" />
        </div>
        <pre className="bg-gray-900 border border-gray-800 rounded-lg p-5 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-gray-200">
          {legacyPrompt}
        </pre>
      </section>
    </div>
  );
}
