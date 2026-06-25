'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';
import TaskCard from './TaskCard';
import { getSkipIds, addSkipId } from '@/lib/skipCache';

// ── Types ──────────────────────────────────────────────────────────────────

type PageState =
  | 'loading'
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'parsing'
  | 'results'
  | 'applying'
  | 'done'
  | 'error';

interface Task {
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

interface Project {
  id: string;
  name: string;
  description: string | null;
}

interface ParsedFields {
  title?: string | null;
  description?: string | null;
  dateToWorkOn?: string | null;
  priority?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  effort?: string | null;
  aiAgentTakeCare?: boolean | null;
}

interface ProjectMatch {
  id: string;
  name: string;
}

interface ParseVoiceResponse {
  fields: ParsedFields;
  completeness: 'partial' | 'complete';
  projectMatches?: ProjectMatch[];
}

// ── Field row config ───────────────────────────────────────────────────────

// Core 5 fields that determine completeness
const CORE_FIELD_KEYS: (keyof ParsedFields)[] = ['title', 'description', 'dateToWorkOn', 'priority', 'projectName'];

const FIELD_LABELS: { key: keyof ParsedFields; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'description', label: 'Description' },
  { key: 'dateToWorkOn', label: 'Date to Work On' },
  { key: 'priority', label: 'Priority' },
  { key: 'projectName', label: 'Project' },
  { key: 'effort', label: 'Effort' },
  { key: 'aiAgentTakeCare', label: 'AI Agent Task' },
];

// ── Spinner ────────────────────────────────────────────────────────────────

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8">
      <svg
        className="w-8 h-8 animate-spin text-blue-400"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12" cy="12" r="10"
          stroke="currentColor" strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
        />
      </svg>
      <p className="text-sm text-gray-400">{label}</p>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function VoiceDump() {
  const [pageState, setPageState] = useState<PageState>('loading');
  const [currentTask, setCurrentTask] = useState<Task | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  // Recording state
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Processing state
  const [transcript, setTranscript] = useState('');
  const [accumulatedTranscript, setAccumulatedTranscript] = useState('');
  const [parseResult, setParseResult] = useState<ParseVoiceResponse | null>(null);

  // Skip list — initialized from localStorage
  const [skipList, setSkipList] = useState<string[]>(() => getSkipIds());

  // ── Fetch next task ──────────────────────────────────────────────────────

  const fetchNextTask = useCallback(async (currentSkipList: string[]) => {
    setPageState('loading');
    setTranscript('');
    setAccumulatedTranscript('');
    setParseResult(null);

    const skipParam = currentSkipList.join(',');
    const url = `/api/tasks/next?mode=voice-dump${skipParam ? `&skip=${encodeURIComponent(skipParam)}` : ''}`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { task: Task | null };
      if (!data.task) {
        setPageState('done');
        return;
      }
      setCurrentTask(data.task);
      setPageState('idle');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(`Failed to load task: ${msg}`);
      setPageState('error');
    }
  }, []);

  // ── Initial load — fetch task + projects in parallel ────────────────────

  useEffect(() => {
    const initialSkipList = getSkipIds();

    const skipParam = initialSkipList.join(',');
    const taskUrl = `/api/tasks/next?mode=voice-dump${skipParam ? `&skip=${encodeURIComponent(skipParam)}` : ''}`;

    const PROJECTS_CACHE_KEY = 'nvc:projects';
    const PROJECTS_CACHE_TTL = 24 * 60 * 60 * 1000;

    let cachedProjects: Project[] | null = null;
    try {
      const raw = localStorage.getItem(PROJECTS_CACHE_KEY);
      if (raw) {
        const { projects: p, cachedAt } = JSON.parse(raw) as { projects: Project[]; cachedAt: number };
        if (Date.now() - cachedAt < PROJECTS_CACHE_TTL) cachedProjects = p;
      }
    } catch { /* ignore */ }

    const run = async () => {
      const taskFetch = fetch(taskUrl);
      const projectsFetch = cachedProjects ? Promise.resolve(null) : fetch('/api/projects');

      const [taskRes, projectsRes] = await Promise.all([taskFetch, projectsFetch]);

      // Projects
      if (projectsRes) {
        try {
          const data = await projectsRes.json() as { projects: Project[] };
          const fresh = data.projects ?? [];
          setProjects(fresh);
          localStorage.setItem(PROJECTS_CACHE_KEY, JSON.stringify({ projects: fresh, cachedAt: Date.now() }));
        } catch { /* non-fatal */ }
      } else if (cachedProjects) {
        setProjects(cachedProjects);
      }

      // Task
      if (!taskRes.ok) {
        setErrorMessage(`Failed to load task: HTTP ${taskRes.status}`);
        setPageState('error');
        return;
      }
      const taskData = await taskRes.json() as { task: Task | null };
      if (!taskData.task) {
        setPageState('done');
        return;
      }
      setCurrentTask(taskData.task);
      setPageState('idle');
    };

    run().catch((err) => {
      setErrorMessage(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
      setPageState('error');
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Recording ─────────────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();

      // Start elapsed timer
      setRecordingSeconds(0);
      timerRef.current = setInterval(() => {
        setRecordingSeconds((s) => s + 1);
      }, 1000);

      setPageState('recording');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(`Microphone error: ${msg}`);
      setPageState('error');
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const recorder = mediaRecorderRef.current;
    if (!recorder) return;

    recorder.onstop = async () => {
      // Stop all tracks
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;

      const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
      chunksRef.current = [];

      setPageState('transcribing');

      // Send to Whisper
      try {
        const formData = new FormData();
        formData.append('audio', blob, 'audio.webm');
        const transcribeRes = await fetch('/api/transcribe', {
          method: 'POST',
          body: formData,
        });
        if (!transcribeRes.ok) throw new Error(`Transcribe HTTP ${transcribeRes.status}`);
        const transcribeData = await transcribeRes.json() as { transcript?: string };
        const text = transcribeData.transcript ?? '';
        setTranscript(text);

        if (!text.trim()) {
          setErrorMessage('No speech detected — try again.');
          setPageState('error');
          return;
        }

        // Accumulate: if we already have a transcript from a previous recording,
        // append this one as a follow-up so parse-voice gets full context.
        const fullTranscript = accumulatedTranscript
          ? `${accumulatedTranscript}\n\n[Follow-up:]\n${text}`
          : text;
        setAccumulatedTranscript(fullTranscript);

        // Send to parse-voice
        setPageState('parsing');
        const task = currentTask;
        const parseRes = await fetch('/api/parse-voice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript: fullTranscript, task, projects }),
        });
        if (!parseRes.ok) {
          let detail = '';
          try { const e = await parseRes.json() as { error?: string }; detail = e.error ?? ''; } catch { /* ignore */ }
          throw new Error(`Parse-voice HTTP ${parseRes.status}${detail ? ': ' + detail : ''}`);
        }
        const parseData = await parseRes.json() as ParseVoiceResponse;
        setParseResult(parseData);
        setPageState('results');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(`Processing failed: ${msg}`);
        setPageState('error');
      }
    };

    recorder.stop();
    mediaRecorderRef.current = null;
  }, [currentTask, projects, accumulatedTranscript]);

  // ── Apply ─────────────────────────────────────────────────────────────────

  const handleApply = useCallback(async () => {
    if (!currentTask || !parseResult) return;
    setPageState('applying');

    // Only include fields that were identified (non-null/undefined)
    const identifiedFields: Record<string, unknown> = {};
    const f = parseResult.fields;
    if (f.title != null) identifiedFields.title = f.title;
    if (f.description != null) identifiedFields.description = f.description;
    if (f.dateToWorkOn != null) identifiedFields.dateToWorkOn = f.dateToWorkOn;
    if (f.priority != null) identifiedFields.priority = f.priority;
    if (f.projectId != null) identifiedFields.projectId = f.projectId;
    if (f.effort != null) identifiedFields.effort = f.effort;
    // aiAgentTakeCare: send both true AND false — false is an explicit human declaration
    if (f.aiAgentTakeCare != null) identifiedFields.aiAgentTakeCare = f.aiAgentTakeCare;

    identifiedFields.aiCleanUpStatus =
      parseResult.completeness === 'complete' ? 'Completed' : 'In Progress';

    try {
      const res = await fetch('/api/tasks/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: currentTask.id, fields: identifiedFields }),
      });
      if (!res.ok) throw new Error(`Update HTTP ${res.status}`);
      // Advance to next task
      const newSkipList = [...skipList, currentTask.id];
      setSkipList(newSkipList);
      await fetchNextTask(newSkipList);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(`Update failed: ${msg}`);
      setPageState('error');
    }
  }, [currentTask, parseResult, skipList, fetchNextTask]);

  // ── Skip ──────────────────────────────────────────────────────────────────

  const handleSkip = useCallback(async () => {
    if (!currentTask) return;
    addSkipId(currentTask.id);
    const newSkipList = [...skipList, currentTask.id];
    setSkipList(newSkipList);
    await fetchNextTask(newSkipList);
  }, [currentTask, skipList, fetchNextTask]);

  // ── Add details / fix — go back to idle keeping accumulated context ────────

  const handleAddDetails = useCallback(() => {
    setPageState('idle');
    // accumulatedTranscript is preserved; next recording appends to it
  }, []);

  // ── Switch project match ──────────────────────────────────────────────────

  const handleSwitchProject = useCallback((match: ProjectMatch) => {
    setParseResult((prev) => {
      if (!prev) return prev;
      const reordered = [
        match,
        ...(prev.projectMatches?.filter((m) => m.id !== match.id) ?? []),
      ];
      return {
        ...prev,
        fields: { ...prev.fields, projectId: match.id, projectName: match.name },
        projectMatches: reordered,
      };
    });
  }, []);

  // ── Re-record (start over) — wipes everything ────────────────────────────

  const handleReRecord = useCallback(() => {
    setTranscript('');
    setAccumulatedTranscript('');
    setParseResult(null);
    setPageState('idle');
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // ── Format recording time ─────────────────────────────────────────────────

  function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ── Results helpers ───────────────────────────────────────────────────────

  function countIdentified(fields: ParsedFields): number {
    return CORE_FIELD_KEYS.filter((key) => {
      const val = fields[key];
      return val != null && val !== '';
    }).length;
  }

  function getFieldDisplayValue(key: keyof ParsedFields, fields: ParsedFields): string | null {
    if (key === 'projectName') return fields.projectName ?? null;
    if (key === 'aiAgentTakeCare') {
      if (fields.aiAgentTakeCare === true) return 'Yes — delegate to AI';
      if (fields.aiAgentTakeCare === false) return "No — I'll handle it";
      return null;
    }
    const val = fields[key];
    return (val != null && val !== '') ? String(val) : null;
  }

  // Returns the existing value on the task card for a given field key, if present
  function getOriginalCardValue(key: keyof ParsedFields, task: Task): string | null {
    if (!task) return null;
    if (key === 'priority') return task.priority ?? null;
    if (key === 'dateToWorkOn') return task.dateToWorkOn ?? null;
    if (key === 'projectName') return task.projectName ?? null;
    if (key === 'effort') return task.effort ?? null;
    if (key === 'aiAgentTakeCare') return task.aiAgentTakeCare ? 'Yes' : null;
    return null;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  // Done state
  if (pageState === 'done') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-6 bg-gray-950 gap-4">
        <p className="text-2xl font-semibold text-white">All caught up!</p>
        <p className="text-sm text-gray-400">No more tasks to review.</p>
        <Link
          href="/"
          className="mt-4 text-sm text-blue-400 hover:text-blue-300 transition-colors focus:outline-none focus-visible:underline"
        >
          Back to Voice Chat
        </Link>
      </div>
    );
  }

  // Error state (recoverable — show retry)
  if (pageState === 'error') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-6 bg-gray-950 gap-4">
        <p className="text-red-400 text-sm text-center max-w-xs">{errorMessage}</p>
        <button
          onClick={() => {
            setErrorMessage('');
            if (currentTask) {
              setPageState('idle');
            } else {
              setPageState('loading');
              fetchNextTask(skipList);
            }
          }}
          className="px-6 py-2.5 rounded-xl bg-gray-800 border border-gray-700 text-gray-200 text-sm hover:bg-gray-700 transition-colors"
        >
          Try Again
        </button>
        <Link
          href="/"
          className="text-xs text-gray-500 hover:text-gray-400 transition-colors focus:outline-none focus-visible:underline"
        >
          Back to Voice Chat
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen px-4 py-8 gap-6 bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between max-w-lg mx-auto w-full">
        <p className="text-sm font-medium text-gray-400 tracking-wide">Voice Dump</p>
        <Link
          href="/"
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors focus:outline-none focus-visible:underline"
          aria-label="Back to Voice Chat"
        >
          Voice Chat
        </Link>
      </div>

      {/* Task card */}
      <div className="flex justify-center">
        {pageState === 'loading' ? (
          <div className="w-full max-w-lg h-36 rounded-2xl bg-gray-900 border border-gray-800 animate-pulse" />
        ) : currentTask ? (
          <TaskCard
            id={currentTask.id}
            title={currentTask.title}
            priority={currentTask.priority}
            date={currentTask.dateToWorkOn}
            status={currentTask.status}
            effort={currentTask.effort}
            projectName={currentTask.projectName}
            description={currentTask.description}
            aiAgentTakeCare={currentTask.aiAgentTakeCare}
          />
        ) : null}
      </div>

      {/* Main content area */}
      <div className="flex flex-col items-center gap-4 w-full max-w-lg mx-auto">

        {/* Loading */}
        {pageState === 'loading' && (
          <Spinner label="Loading task..." />
        )}

        {/* Idle — ready to record */}
        {pageState === 'idle' && currentTask && (
          <div className="flex flex-col items-center gap-4 w-full">
            {accumulatedTranscript && parseResult ? (
              <div className="w-full rounded-xl bg-gray-900 border border-gray-800 overflow-hidden">
                <p className="px-4 pt-3 pb-1 text-xs text-gray-500 uppercase tracking-wide font-medium">Identified so far</p>
                <div className="px-4 pb-1">
                  {FIELD_LABELS.map(({ key, label }) => {
                    const value = getFieldDisplayValue(key, parseResult.fields);
                    if (!value) return null;
                    return (
                      <div key={key} className="flex items-start gap-2 py-1.5 border-t border-gray-800 first:border-t-0">
                        <span className="w-4 h-4 rounded-full bg-green-900 border border-green-700 flex items-center justify-center shrink-0 mt-0.5" aria-hidden="true">
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-2.5 h-2.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </span>
                        <div className="flex flex-col min-w-0">
                          <span className="text-xs text-gray-500">{label}</span>
                          <span className="text-xs text-gray-300 leading-snug break-words" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}>{value}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="px-4 py-2.5 text-xs text-blue-400 border-t border-gray-800">
                  Record more to add details or correct any of the above
                </p>
              </div>
            ) : (
              <p className="text-sm text-gray-400 text-center">
                Tap to record your notes about this task. Talk as long as you need.
              </p>
            )}
            <button
              onClick={startRecording}
              className="flex items-center gap-2.5 px-8 py-3.5 rounded-full text-white text-base font-medium tracking-wide transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
              style={{ background: '#0DA0E5', boxShadow: '0 0 16px rgba(13, 160, 229, 0.35)' }}
              aria-label="Start recording"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a4 4 0 014 4v6a4 4 0 01-8 0V5a4 4 0 014-4z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0M12 19v4M8 23h8" />
              </svg>
              Start Recording
            </button>
            <button
              onClick={handleSkip}
              className="text-sm text-gray-500 hover:text-gray-300 transition-colors focus:outline-none focus-visible:underline"
              aria-label="Skip this task"
            >
              Skip
            </button>
          </div>
        )}

        {/* Recording — show live timer + done button */}
        {pageState === 'recording' && (
          <div className="flex flex-col items-center gap-5 w-full">
            {/* Pulsing indicator + timer */}
            <div className="flex items-center gap-3">
              <span
                className="w-3 h-3 rounded-full bg-red-500"
                style={{ animation: 'vd-pulse 1.2s ease-in-out infinite' }}
                aria-hidden="true"
              />
              <span className="text-lg font-mono text-white tabular-nums" aria-live="polite" aria-label={`Recording: ${formatTime(recordingSeconds)}`}>
                {formatTime(recordingSeconds)}
              </span>
              <span className="text-sm text-gray-400">Recording...</span>
            </div>

            <button
              onClick={stopRecording}
              className="flex items-center gap-2.5 px-8 py-3.5 rounded-full text-white text-base font-medium tracking-wide transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
              style={{ background: '#22c55e', boxShadow: '0 0 16px rgba(34, 197, 94, 0.35)' }}
              aria-label="Done recording"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Done Recording
            </button>

            <button
              onClick={handleSkip}
              className="text-sm text-gray-500 hover:text-gray-300 transition-colors focus:outline-none focus-visible:underline"
              aria-label="Skip this task"
            >
              Skip
            </button>
          </div>
        )}

        {/* Transcribing */}
        {pageState === 'transcribing' && (
          <Spinner label="Transcribing audio..." />
        )}

        {/* Parsing — show transcript + spinner */}
        {pageState === 'parsing' && (
          <div className="flex flex-col gap-4 w-full">
            {transcript && (
              <div className="px-4 py-3 rounded-xl bg-gray-900 border border-gray-800">
                <p className="text-xs text-gray-500 mb-1">Transcript</p>
                <p className="text-sm text-gray-300 leading-relaxed">{transcript}</p>
              </div>
            )}
            <Spinner label="Extracting fields..." />
          </div>
        )}

        {/* Results */}
        {pageState === 'results' && parseResult && (
          <div className="flex flex-col gap-4 w-full">
            {/* Transcript — show full accumulated text */}
            {accumulatedTranscript && (
              <div className="px-4 py-3 rounded-xl bg-gray-900 border border-gray-800">
                <p className="text-xs text-gray-500 mb-1">Transcript</p>
                <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">{accumulatedTranscript}</p>
              </div>
            )}

            {/* Fields panel */}
            <div className="rounded-2xl bg-gray-900 border border-gray-800 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-800">
                <p className="text-sm font-medium text-gray-200">
                  {countIdentified(parseResult.fields)} of {CORE_FIELD_KEYS.length} fields identified
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  AI Clean Up Status will be set to{' '}
                  <span className={parseResult.completeness === 'complete' ? 'text-green-400' : 'text-yellow-400'}>
                    {parseResult.completeness === 'complete' ? 'Completed' : 'In Progress'}
                  </span>
                </p>
              </div>

              <div className="divide-y divide-gray-800">
                {FIELD_LABELS.map(({ key, label }) => {
                  const value = getFieldDisplayValue(key, parseResult.fields);
                  const identified = value != null;
                  const originalValue = !identified && currentTask ? getOriginalCardValue(key, currentTask) : null;
                  return (
                    <div key={key} className="flex items-start gap-3 px-4 py-3">
                      {identified ? (
                        <span className="w-5 h-5 rounded-full bg-green-900 border border-green-700 flex items-center justify-center shrink-0 mt-0.5" aria-hidden="true">
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </span>
                      ) : (
                        <span className="w-5 h-5 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center shrink-0 mt-0.5 text-gray-600 text-xs font-bold" aria-hidden="true">
                          —
                        </span>
                      )}
                      <div className="flex flex-col min-w-0 gap-0.5">
                        <span className="text-xs text-gray-500">{label}</span>
                        {identified ? (
                          <>
                            <span className="text-sm text-gray-200 leading-snug break-words">{value}</span>
                            {/* Alternative project chips */}
                            {key === 'projectName' && parseResult.projectMatches && parseResult.projectMatches.length > 1 && (
                              <div className="flex flex-wrap gap-1.5 mt-1">
                                {parseResult.projectMatches.slice(1).map((match, i) => (
                                  <button
                                    key={match.id}
                                    onClick={() => handleSwitchProject(match)}
                                    className="px-2 py-0.5 rounded text-xs bg-gray-800 border border-gray-700 text-gray-400 hover:border-blue-500 hover:text-blue-300 transition-colors"
                                    aria-label={`Switch project to ${match.name}`}
                                  >
                                    {i + 2}. {match.name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-sm text-gray-600 italic">
                            not mentioned{originalValue ? <span className="text-gray-700"> · from original card</span> : null}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex flex-col items-center gap-3">
              <button
                onClick={handleApply}
                className="w-full px-6 py-3 rounded-xl font-medium text-white text-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-green-400"
                style={{ background: '#16a34a', boxShadow: '0 0 12px rgba(22, 163, 74, 0.3)' }}
                aria-label="Apply identified fields to Notion and move to next task"
              >
                Apply &amp; Next
              </button>
              <button
                onClick={handleAddDetails}
                className="w-full px-6 py-3 rounded-xl border text-sm font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                style={{ background: 'rgba(13, 160, 229, 0.08)', borderColor: 'rgba(13, 160, 229, 0.35)', color: '#7dd3fc' }}
                aria-label="Record more to add details or correct wrong fields"
              >
                Add Details / Fix
              </button>
              <div className="flex items-center gap-4 pt-1">
                <button
                  onClick={handleReRecord}
                  className="text-sm text-gray-500 hover:text-gray-300 transition-colors focus:outline-none focus-visible:underline"
                  aria-label="Start over with a completely fresh recording"
                >
                  Start Over
                </button>
                <span className="text-gray-700 text-xs select-none">·</span>
                <button
                  onClick={handleSkip}
                  className="text-sm text-gray-500 hover:text-gray-300 transition-colors focus:outline-none focus-visible:underline"
                  aria-label="Skip this task"
                >
                  Skip
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Applying */}
        {pageState === 'applying' && (
          <Spinner label="Saving to Notion..." />
        )}
      </div>

      {/* Pulse keyframe for recording indicator */}
      <style>{`
        @keyframes vd-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.85); }
        }
      `}</style>
    </div>
  );
}
