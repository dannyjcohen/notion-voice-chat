'use client';

import { useState } from 'react';

interface TaskCardProps {
  title: string;
  priority: string | null;
  date: string | null;
  status: string | null;
  effort: string | null;
  projectName: string | null;
  description: string | null;
  aiAgentTakeCare?: boolean;
}

const PRIORITY_COLORS: Record<string, string> = {
  Urgent: 'bg-red-600 text-white',
  High: 'bg-orange-500 text-white',
  Medium: 'bg-yellow-500 text-gray-900',
  Low: 'bg-slate-500 text-white',
};

export default function TaskCard({
  title,
  priority,
  date,
  status,
  effort,
  projectName,
  description,
  aiAgentTakeCare = false,
}: TaskCardProps) {
  const [descExpanded, setDescExpanded] = useState(false);

  const badgeClass = priority ? (PRIORITY_COLORS[priority] ?? 'bg-slate-500 text-white') : null;

  const formattedDate = date
    ? new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <div className="w-full max-w-lg rounded-2xl bg-gray-900 border border-gray-800 p-5 space-y-3">
      {/* Title + priority badge */}
      <div className="flex items-start gap-3">
        <h2 className="flex-1 text-xl font-semibold text-white leading-snug">{title}</h2>
        {badgeClass && (
          <span
            className={`shrink-0 mt-0.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${badgeClass}`}
          >
            {priority}
          </span>
        )}
      </div>

      {/* Metadata row */}
      {(formattedDate || status || effort || projectName) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-400">
          {formattedDate && (
            <span className="flex items-center gap-1">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-3.5 h-3.5 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
              >
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              {formattedDate}
            </span>
          )}
          {status && (
            <span className="flex items-center gap-1">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-3.5 h-3.5 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              {status}
            </span>
          )}
          {effort && (
            <span className="flex items-center gap-1">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-3.5 h-3.5 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
              >
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
              {effort} effort
            </span>
          )}
          {projectName && (
            <span className="flex items-center gap-1">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-3.5 h-3.5 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
              >
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              </svg>
              {projectName}
            </span>
          )}
        </div>
      )}

      {/* Description (truncated, expandable) */}
      {description && (
        <div>
          <p
            className={`text-gray-400 text-sm leading-relaxed${descExpanded ? '' : ' line-clamp-2'}`}
          >
            {description}
          </p>
          {description.length > 120 && (
            <button
              onClick={() => setDescExpanded((prev) => !prev)}
              className="mt-1 text-xs text-gray-600 hover:text-gray-400 transition-colors focus:outline-none focus-visible:underline"
              aria-label={descExpanded ? 'Collapse description' : 'Expand description'}
            >
              {descExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      {/* AI Agent Task checkbox row */}
      <div className="flex items-center gap-2 pt-1" aria-label={`AI Agent Task: ${aiAgentTakeCare ? 'yes' : 'no'}`}>
        <span
          className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
            aiAgentTakeCare
              ? 'bg-blue-600 border-blue-500'
              : 'bg-transparent border-gray-600'
          }`}
          aria-hidden="true"
        >
          {aiAgentTakeCare && (
            <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </span>
        <span className="text-xs text-gray-500">AI Agent Task</span>
      </div>
    </div>
  );
}
