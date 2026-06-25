'use client';

import { useState } from 'react';
import type { DebugEvent, ApiCall } from '@/hooks/useDebugLog';

type VoiceState = 'idle' | 'unlocked' | 'listening' | 'processing' | 'speaking';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface DebugPanelProps {
  debugMode: boolean;
  voiceState: VoiceState;
  vadErrored: boolean;
  vadLoading: boolean;
  vadListening: boolean;
  holdToSpeak: boolean;
  messageCount: number;
  events: DebugEvent[];
  lastApiCall: ApiCall | null;
  lastPayload: Message[];
}

// ── Badge helpers ──────────────────────────────────────────────────────────

const STATE_COLORS: Record<VoiceState, string> = {
  idle: 'bg-gray-600 text-gray-100',
  unlocked: 'bg-blue-600 text-white',
  listening: 'bg-green-600 text-white',
  processing: 'bg-yellow-500 text-gray-900',
  speaking: 'bg-purple-600 text-white',
};

function statusColor(status: number | 'pending'): string {
  if (status === 'pending') return 'text-gray-400';
  if (status >= 200 && status < 300) return 'text-green-400';
  if (status >= 400 && status < 500) return 'text-yellow-400';
  if (status >= 500) return 'text-red-400';
  return 'text-gray-400';
}

function formatApiCallLine(call: ApiCall): string {
  const dur = call.duration !== undefined ? `   [${call.duration}s]` : '';
  if (call.status === 'pending') {
    return `POST ${call.endpoint} → pending...`;
  }
  const statusText = httpStatusText(call.status);
  return `POST ${call.endpoint} → ${call.status} ${statusText}${dur}`;
}

function httpStatusText(status: number): string {
  const map: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    422: 'Unprocessable Entity',
    500: 'Internal Server Error',
    503: 'Service Unavailable',
  };
  return map[status] ?? '';
}

// ── Main component ─────────────────────────────────────────────────────────

export default function DebugPanel({
  debugMode,
  voiceState,
  vadErrored,
  vadLoading,
  vadListening,
  holdToSpeak,
  messageCount,
  events,
  lastApiCall,
  lastPayload,
}: DebugPanelProps) {
  const [responseExpanded, setResponseExpanded] = useState(false);
  const [payloadExpanded, setPayloadExpanded] = useState(false);

  if (!debugMode) return null;

  const has503 = lastApiCall !== null && lastApiCall.status === 503;

  // Tool call events extracted from the event log
  const toolEvents = events.filter(
    (ev) => ev.message.startsWith('[TOOL:') || ev.message.startsWith('[TOOL_RESULT:')
  );

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 bg-gray-900/95 border-t border-gray-700 text-xs font-mono"
      style={{ maxHeight: '300px' }}
      aria-label="Debug panel"
    >
      {/* Header label */}
      <div className="px-3 py-1 border-b border-gray-700 flex items-center gap-2">
        <span className="text-gray-500 uppercase tracking-widest text-[10px] font-semibold">
          DEBUG
        </span>
      </div>

      <div className="overflow-y-auto" style={{ maxHeight: '270px' }}>
        {/* Row 1 — State badges */}
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-gray-800">
          {/* Voice State */}
          <span
            className={`px-2 py-0.5 rounded text-[11px] font-semibold uppercase ${STATE_COLORS[voiceState]}`}
          >
            {voiceState}
          </span>

          {/* VAD status */}
          {vadErrored ? (
            <span className="px-2 py-0.5 rounded bg-red-900 text-red-300 text-[11px]">
              VAD errored
            </span>
          ) : vadLoading ? (
            <span className="px-2 py-0.5 rounded bg-yellow-700 text-yellow-200 text-[11px]">
              VAD loading…
            </span>
          ) : vadListening ? (
            <span className="px-2 py-0.5 rounded bg-green-900 text-green-300 text-[11px]">
              VAD active
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded bg-gray-700 text-gray-400 text-[11px]">
              VAD not started
            </span>
          )}

          {/* Hold-to-speak */}
          {holdToSpeak ? (
            <span className="px-2 py-0.5 rounded bg-orange-700 text-orange-100 text-[11px]">
              hold-to-speak on
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded bg-gray-700 text-gray-400 text-[11px]">
              hold-to-speak off
            </span>
          )}

          {/* Message count */}
          <span className="px-2 py-0.5 rounded bg-gray-700 text-gray-300 text-[11px]">
            {messageCount} msgs
          </span>
        </div>

        {/* Row 2 — Last API call */}
        {lastApiCall && (
          <div className={`px-3 py-1.5 border-b border-gray-800 ${statusColor(lastApiCall.status)}`}>
            {formatApiCallLine(lastApiCall)}
          </div>
        )}

        {/* Row — 503 warning */}
        {has503 && (
          <div className="px-3 py-1.5 border-b border-gray-800 bg-yellow-900/40 text-yellow-300">
            API returning 503 — env vars not configured. Create .env.local from .env.local.example
          </div>
        )}

        {/* Row 3 — Event log */}
        <div className="px-3 py-2 border-b border-gray-800">
          {events.length === 0 ? (
            <span className="text-gray-600">No events yet.</span>
          ) : (
            <div className="space-y-0.5">
              {events.map((ev, i) => (
                <div key={i} className={`${ev.message.startsWith('[TOOL') ? 'text-cyan-400' : 'text-gray-300'}`}>
                  <span className="text-gray-500 mr-2">{ev.time}</span>
                  {ev.message}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Row 4 — Tool calls log (summary of tool events only) */}
        {toolEvents.length > 0 && (
          <div className="px-3 py-2 border-b border-gray-800">
            <div className="text-gray-500 uppercase tracking-widest text-[10px] font-semibold mb-1">
              Tool calls ({toolEvents.length})
            </div>
            <div className="space-y-0.5">
              {toolEvents.map((ev, i) => (
                <div key={i} className="text-cyan-300 text-[11px]">
                  <span className="text-gray-500 mr-2">{ev.time}</span>
                  {ev.message.slice(0, 120)}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Row 5 — Last API response (collapsible) */}
        {lastApiCall?.responsePreview && (
          <div className="px-3 py-2 border-b border-gray-800">
            <button
              onClick={() => setResponseExpanded((v) => !v)}
              className="text-gray-400 hover:text-gray-200 transition-colors"
              aria-expanded={responseExpanded}
            >
              Response {responseExpanded ? '▲' : '▼'}
            </button>
            {responseExpanded && (
              <pre className="mt-1 text-gray-300 whitespace-pre-wrap break-all text-[11px] leading-relaxed">
                {lastApiCall.responsePreview.slice(0, 500)}
              </pre>
            )}
          </div>
        )}

        {/* Row 6 — Last sent payload (collapsible) */}
        {lastPayload.length > 0 && (
          <div className="px-3 py-2">
            <button
              onClick={() => setPayloadExpanded((v) => !v)}
              className="text-gray-400 hover:text-gray-200 transition-colors"
              aria-expanded={payloadExpanded}
            >
              Last payload ({lastPayload.length} msgs) {payloadExpanded ? '▲' : '▼'}
            </button>
            {payloadExpanded && (
              <div className="mt-1 space-y-0.5">
                {lastPayload.map((msg, i) => (
                  <div key={i} className="text-[11px]">
                    <span className={msg.role === 'user' ? 'text-blue-400' : 'text-green-400'}>
                      [{msg.role}]
                    </span>
                    <span className="text-gray-400 ml-1">
                      {msg.content.slice(0, 80)}{msg.content.length > 80 ? '…' : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
