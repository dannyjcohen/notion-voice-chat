type VoiceState = 'idle' | 'unlocked' | 'listening' | 'processing' | 'speaking';

interface StatusIndicatorProps {
  state: VoiceState;
}

export default function StatusIndicator({ state }: StatusIndicatorProps) {
  if (state === 'idle') {
    return null;
  }

  if (state === 'listening') {
    return (
      <div className="flex items-center gap-2" role="status" aria-label="Listening">
        {/* Pulse rings */}
        <div className="relative flex items-center justify-center w-10 h-10">
          <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-60 animate-ping" />
          <span className="relative inline-flex rounded-full h-4 w-4 bg-red-500" />
        </div>
        <span className="text-gray-400 text-sm">Listening…</span>
      </div>
    );
  }

  if (state === 'processing') {
    return (
      <div className="flex items-center gap-2" role="status" aria-label="Processing">
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="w-2 h-2 rounded-full bg-blue-400"
              style={{
                animation: 'bounce 1s infinite',
                animationDelay: `${i * 0.15}s`,
              }}
            />
          ))}
        </span>
        <span className="text-gray-400 text-sm">Thinking…</span>
      </div>
    );
  }

  if (state === 'speaking') {
    return (
      <div className="flex items-center gap-2" role="status" aria-label="Speaking">
        <span className="flex items-end gap-0.5 h-5">
          {[1, 3, 2, 4, 2].map((h, i) => (
            <span
              key={i}
              className="w-1 rounded-full bg-green-400"
              style={{
                height: `${h * 4}px`,
                animation: 'wave 0.8s ease-in-out infinite',
                animationDelay: `${i * 0.12}s`,
              }}
            />
          ))}
        </span>
        <span className="text-gray-400 text-sm">Speaking…</span>
      </div>
    );
  }

  // unlocked or other transient states — blank
  return null;
}
