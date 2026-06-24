interface TaskCardProps {
  title: string;
  priority: string | null;
  date: string | null;
  description: string | null;
}

const PRIORITY_COLORS: Record<string, string> = {
  Urgent: 'bg-red-600',
  High: 'bg-orange-500',
  Medium: 'bg-yellow-500',
  Low: 'bg-slate-500',
};

export default function TaskCard({ title, priority, date, description }: TaskCardProps) {
  const badgeClass = priority ? (PRIORITY_COLORS[priority] ?? 'bg-slate-500') : null;

  const formattedDate = date
    ? new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <div className="w-full max-w-lg rounded-2xl bg-gray-900 border border-gray-800 p-5 space-y-3">
      <div className="flex items-start gap-3">
        <h2 className="flex-1 text-xl font-semibold text-white leading-snug">{title}</h2>
        {badgeClass && (
          <span
            className={`shrink-0 mt-0.5 px-2.5 py-0.5 rounded-full text-xs font-semibold text-white ${badgeClass}`}
          >
            {priority}
          </span>
        )}
      </div>

      {formattedDate && (
        <p className="text-gray-400 text-sm">{formattedDate}</p>
      )}

      {description && (
        <p className="text-gray-400 text-sm line-clamp-2">{description}</p>
      )}
    </div>
  );
}
