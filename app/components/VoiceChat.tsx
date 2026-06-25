'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import TaskCard from './TaskCard';
import StatusIndicator from './StatusIndicator';
import DebugPanel from './DebugPanel';
import { float32ArrayToWav } from '@/lib/audio';
import { useMicVAD } from '@ricky0123/vad-react';
import { useDebugLog } from '@/hooks/useDebugLog';

// ── Types ──────────────────────────────────────────────────────────────────

type VoiceState = 'idle' | 'unlocked' | 'listening' | 'processing' | 'speaking';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

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

interface PendingUpdate {
  taskId: string;
  fields: Record<string, unknown>;
}

interface Project {
  id: string;
  name: string;
  description: string | null;
}

interface DebugMessage {
  id: string;
  timestamp: number;
  content: string;
}

// ── Tool event line pattern ────────────────────────────────────────────────

const TOOL_LINE_RE = /^\[TOOL(?:_RESULT)?:[^\]]+\]$/;
const ERROR_LINE_RE = /^\[ERROR:([^\]]*)\]$/;

function isToolLine(line: string): boolean {
  return TOOL_LINE_RE.test(line.trim());
}

function getErrorMessage(line: string): string | null {
  const m = line.trim().match(ERROR_LINE_RE);
  return m ? m[1] : null;
}

function extractToolLines(text: string): { cleaned: string; toolEvents: string[]; errorMessages: string[] } {
  const lines = text.split('\n');
  const toolEvents: string[] = [];
  const errorMessages: string[] = [];
  const kept: string[] = [];
  for (const line of lines) {
    const errMsg = getErrorMessage(line);
    if (errMsg !== null) {
      errorMessages.push(errMsg);
    } else if (isToolLine(line)) {
      toolEvents.push(line.trim());
    } else {
      kept.push(line);
    }
  }
  return { cleaned: kept.join('\n'), toolEvents, errorMessages };
}

// ── Simple markdown bold renderer ─────────────────────────────────────────
// Renders **text** as <strong> in chat bubbles. No external dependency.
function renderMarkdown(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

// ── TTS voices ────────────────────────────────────────────────────────────

const TTS_VOICES = [
  { value: 'nova',    label: 'Nova (default)' },
  { value: 'alloy',  label: 'Alloy' },
  { value: 'echo',   label: 'Echo' },
  { value: 'fable',  label: 'Fable' },
  { value: 'onyx',   label: 'Onyx' },
  { value: 'shimmer',label: 'Shimmer' },
  { value: 'coral',  label: 'Coral' },
  { value: 'sage',   label: 'Sage' },
  { value: 'ash',    label: 'Ash' },
] as const;

// ── TTS via OpenAI /api/speak ──────────────────────────────────────────────
// audioCtx must be passed in — it must have been created during a user gesture
// (iOS Safari blocks AudioContext created outside a tap/click handler).

async function speakSentence(text: string, voice: string, audioCtx: AudioContext): Promise<void> {
  try {
    // Re-resume context if iOS suspended it (e.g. phone locked mid-session)
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    });
    if (!res.ok) return;
    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    return new Promise<void>((resolve) => {
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      source.onended = () => resolve();
      source.start(0);
    });
  } catch {
    // Non-fatal — silently skip if TTS fails
  }
}

// ── Confirmation classifier ────────────────────────────────────────────────

function classifyConfirmation(text: string): 'yes' | 'no' | 'other' {
  const lower = text.toLowerCase().trim();
  const YES = [
    'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'do it',
    'update', 'confirm', 'go ahead', 'looks good', 'correct',
    'perfect', 'sounds good', "that's right", 'great',
  ];
  const NO = [
    'no', 'nope', 'cancel', 'wait', 'stop', 'change',
    'actually', 'wrong', 'not right', 'hold on', 'never mind',
  ];
  if (YES.some((w) => lower.includes(w))) return 'yes';
  if (NO.some((w) => lower.includes(w))) return 'no';
  return 'other';
}

// ── Main component ─────────────────────────────────────────────────────────

export default function VoiceChat() {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');

  // New architecture state
  const [currentTask, setCurrentTask] = useState<Task | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [skipList, setSkipList] = useState<string[]>([]);
  const [sessionDone, setSessionDone] = useState(false);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [responseText, setResponseText] = useState('');
  const [holdToSpeak, setHoldToSpeak] = useState(false);

  const [debugMessages, setDebugMessages] = useState<DebugMessage[]>([]);
  const debugMsgCounterRef = useRef(0);

  const msgTimestampsRef = useRef<number[]>([]);

  const pushMessages = useCallback((newMsgs: Message[]) => {
    const now = Date.now();
    setMessages((prev) => {
      const next = [...prev, ...newMsgs];
      for (let i = prev.length; i < next.length; i++) {
        msgTimestampsRef.current[i] = now;
      }
      return next;
    });
  }, []);

  const addMessage = useCallback((role: 'user' | 'assistant', content: string) => {
    const now = Date.now();
    setMessages((prev) => {
      const next = [...prev, { role, content }];
      msgTimestampsRef.current[next.length - 1] = now;
      return next;
    });
  }, []);

  const [ttsEnabled, setTtsEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return localStorage.getItem('ttsEnabled') !== 'false';
  });
  const ttsEnabledRef = useRef(ttsEnabled);
  useEffect(() => { ttsEnabledRef.current = ttsEnabled; }, [ttsEnabled]);

  const [ttsVoice, setTtsVoice] = useState<string>(() => {
    if (typeof window === 'undefined') return 'nova';
    return localStorage.getItem('ttsVoice') ?? 'nova';
  });
  const ttsVoiceRef = useRef(ttsVoice);
  useEffect(() => { ttsVoiceRef.current = ttsVoice; }, [ttsVoice]);

  const handleVoiceChange = useCallback((voice: string) => {
    setTtsVoice(voice);
    localStorage.setItem('ttsVoice', voice);
  }, []);

  const [projectsRefreshing, setProjectsRefreshing] = useState(false);

  const [vadSpeaking, setVadSpeaking] = useState(false);

  const toggleTts = useCallback(() => {
    setTtsEnabled((prev) => {
      const next = !prev;
      localStorage.setItem('ttsEnabled', String(next));
      return next;
    });
  }, []);

  const [textInput, setTextInput] = useState('');
  const [transcriptFlash, setTranscriptFlash] = useState('');
  const transcriptFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [debugMode, setDebugMode] = useState(false);
  useEffect(() => {
    setDebugMode(new URLSearchParams(window.location.search).get('debug') === '1');
  }, []);

  const { events, lastApiCall, log, logApiStart, logApiEnd } = useDebugLog();
  const lastPayloadRef = useRef<Message[]>([]);
  const chatListRef = useRef<HTMLDivElement>(null);

  const setVoiceStateLogged = useCallback(
    (next: VoiceState) => {
      setVoiceState((prev) => {
        if (prev !== next) log(`state: ${prev} → ${next}`);
        return next;
      });
    },
    [log]
  );

  const addDebugMessage = useCallback((content: string) => {
    const id = `debug-${Date.now()}-${debugMsgCounterRef.current++}`;
    setDebugMessages((prev) => [...prev, { id, timestamp: Date.now(), content }]);
  }, []);

  useEffect(() => {
    if (chatListRef.current) {
      chatListRef.current.scrollTop = chatListRef.current.scrollHeight;
    }
  }, [messages, responseText, debugMessages]);

  const showTranscriptFlash = useCallback((text: string) => {
    setTranscriptFlash(text);
    if (transcriptFlashTimerRef.current) clearTimeout(transcriptFlashTimerRef.current);
    transcriptFlashTimerRef.current = setTimeout(() => setTranscriptFlash(''), 2500);
  }, []);

  const ttsQueueRef = useRef<string[]>([]);
  const ttsDrainingRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const holdChunksRef = useRef<Blob[]>([]);
  const vadActiveRef = useRef(false);

  // ── TTS queue drainer ────────────────────────────────────────────────────

  const drainTtsQueue = useCallback(async () => {
    if (ttsDrainingRef.current) return;
    ttsDrainingRef.current = true;
    setVoiceStateLogged('speaking');

    while (ttsQueueRef.current.length > 0) {
      const sentence = ttsQueueRef.current.shift()!;
      if (ttsEnabledRef.current && audioCtxRef.current) {
        log(`TTS: speaking "${sentence.slice(0, 30)}..."`);
        await speakSentence(sentence, ttsVoiceRef.current, audioCtxRef.current);
      } else {
        log(`TTS: muted, skipping "${sentence.slice(0, 30)}..."`);
      }
    }

    ttsDrainingRef.current = false;
    if (vadActiveRef.current) {
      setVoiceStateLogged('listening');
    } else {
      setVoiceStateLogged('unlocked');
    }
  }, [setVoiceStateLogged, log]);

  // ── Fetch next task ───────────────────────────────────────────────────────

  const fetchNextTask = useCallback(async (currentSkipList: string[]) => {
    const skipParam = currentSkipList.join(',');
    const url = `/api/tasks/next${skipParam ? `?skip=${encodeURIComponent(skipParam)}` : ''}`;

    if (debugMode) {
      addDebugMessage(`📤 GET /api/tasks/next — skip list: ${currentSkipList.length ? currentSkipList.join(', ') : '(none)'}`);
    }

    const startTime = logApiStart('/api/tasks/next');
    try {
      const res = await fetch(url);
      const data = await res.json() as { task: Task | null };
      const durationS = ((Date.now() - startTime) / 1000).toFixed(1);
      logApiEnd('/api/tasks/next', res.status, startTime);

      if (!data.task) {
        if (debugMode) {
          addDebugMessage(`📥 /api/tasks/next → ${res.status}  ${durationS}s — no more tasks`);
        }
        setSessionDone(true);
        // Task D: clear context before showing all-done message
        setMessages([]);
        msgTimestampsRef.current = [];
        setDebugMessages([]);
        setPendingUpdate(null);
        addMessage('assistant', 'All caught up — no more tasks to review!');
        setVoiceStateLogged('unlocked');
        return;
      }

      if (debugMode) {
        const t = data.task;
        addDebugMessage(
          `📥 /api/tasks/next → ${res.status}  ${durationS}s — task: "${t.title}" (priority: ${t.priority ?? 'none'}, date: ${t.dateToWorkOn ?? 'none'})`
        );
      }

      // Task D: clear message history so each task gets a clean slate
      setMessages([]);
      msgTimestampsRef.current = [];
      setDebugMessages([]);
      setPendingUpdate(null);

      setCurrentTask(data.task);
      const taskTitle = data.task.title;
      addMessage('assistant', `Next task: **${taskTitle}**`);

      // Task C: speak the new task title aloud
      ttsQueueRef.current.push(`Next task: ${taskTitle}`);
      if (!ttsDrainingRef.current) drainTtsQueue();

      setVoiceStateLogged('unlocked');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const durationS = ((Date.now() - startTime) / 1000).toFixed(1);
      logApiEnd('/api/tasks/next', 0, startTime, message);
      if (debugMode) {
        addDebugMessage(`📥 /api/tasks/next → error  ${durationS}s — ${message}`);
      }
      addMessage('assistant', 'Failed to load next task — please try again.');
      setVoiceStateLogged('unlocked');
    }
  }, [addMessage, debugMode, addDebugMessage, logApiStart, logApiEnd, setVoiceStateLogged, drainTtsQueue]);

  // ── Handle AI response (JSON action or follow-up text) ───────────────────

  const currentTaskRef = useRef<Task | null>(null);
  const skipListRef = useRef<string[]>([]);
  const pendingUpdateRef = useRef<PendingUpdate | null>(null);

  // Keep refs in sync with state
  useEffect(() => { currentTaskRef.current = currentTask; }, [currentTask]);
  useEffect(() => { skipListRef.current = skipList; }, [skipList]);
  useEffect(() => { pendingUpdateRef.current = pendingUpdate; }, [pendingUpdate]);

  const handleAIResponse = useCallback(async (responseText: string) => {
    // Strip markdown code fences (```json ... ```) if present
    let trimmed = responseText.trim();
    const codeFenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (codeFenceMatch) trimmed = codeFenceMatch[1].trim();

    // Also try to extract JSON object from mixed text
    if (!trimmed.startsWith('{')) {
      const jsonMatch = trimmed.match(/\{[\s\S]*"action"[\s\S]*\}/);
      if (jsonMatch) trimmed = jsonMatch[0];
    }

    try {
      const action = JSON.parse(trimmed) as {
        action: string;
        fields?: Record<string, unknown>;
        summary?: string;
      };
      if (action.action === 'skip' && currentTaskRef.current) {
        const newSkipList = [...skipListRef.current, currentTaskRef.current.id];
        setSkipList(newSkipList);
        await fetchNextTask(newSkipList);
      } else if (action.action === 'confirm' && action.fields && currentTaskRef.current) {
        // Store pending update — user must confirm before anything touches Notion
        setPendingUpdate({ taskId: currentTaskRef.current.id, fields: action.fields });
        // Summary is shown as an assistant message bubble and spoken via TTS
        if (action.summary) {
          addMessage('assistant', action.summary);
          // Queue summary for TTS (the JSON was suppressed from TTS above)
          ttsQueueRef.current.push(action.summary);
          if (!ttsDrainingRef.current) drainTtsQueue();
        }
        // The confirm/cancel buttons are rendered based on pendingUpdate state
      }
      // Note: "update" action no longer handled here — always go through "confirm" first
    } catch {
      // Not JSON — it's a follow-up question, display it normally (already in messages)
    }
  }, [fetchNextTask, addMessage]);

  // ── Projects localStorage cache ──────────────────────────────────────────

  const PROJECTS_CACHE_KEY = 'nvc:projects';
  const PROJECTS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

  function loadCachedProjects(): Project[] | null {
    try {
      const raw = localStorage.getItem(PROJECTS_CACHE_KEY);
      if (!raw) return null;
      const { projects, cachedAt } = JSON.parse(raw) as { projects: Project[]; cachedAt: number };
      if (Date.now() - cachedAt > PROJECTS_CACHE_TTL) return null;
      return projects;
    } catch { return null; }
  }

  function cacheProjects(projects: Project[]) {
    try {
      localStorage.setItem(PROJECTS_CACHE_KEY, JSON.stringify({ projects, cachedAt: Date.now() }));
    } catch { /* storage full or unavailable */ }
  }

  const refreshProjects = useCallback(async () => {
    if (projectsRefreshing) return;
    setProjectsRefreshing(true);
    try {
      const res = await fetch('/api/projects');
      const data = await res.json() as { projects: Project[] };
      const fresh = data.projects ?? [];
      setProjects(fresh);
      cacheProjects(fresh);
      log(`Projects refreshed: ${fresh.length} loaded`);
    } catch (err) {
      log(`Projects refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setProjectsRefreshing(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsRefreshing, log]);

  // ── Prefetch on mount (silent — no chat messages) ────────────────────────
  // Runs immediately when the page loads so data is ready before the user taps.

  const prefetchDoneRef = useRef(false);

  useEffect(() => {
    if (prefetchDoneRef.current) return;
    prefetchDoneRef.current = true;

    // Check for cache-bust signal
    const shouldBustCache = new URLSearchParams(window.location.search).get('refresh') === 'projects';
    if (shouldBustCache) {
      try { localStorage.removeItem(PROJECTS_CACHE_KEY); } catch { /* ignore */ }
    }

    // Use window.location.search directly to avoid depending on debugMode state
    // (which is set by a separate useEffect and may not be true yet when prefetch runs)
    const isDebug = new URLSearchParams(window.location.search).get('debug') === '1';

    const run = async () => {
      log('prefetch: fetching projects + first task');

      // ── Projects: try cache first ──────────────────────────────────────
      const cachedProjects = loadCachedProjects();

      let projectsFetch: Promise<Response> | null = null;
      let projectsStart = 0;

      if (cachedProjects) {
        setProjects(cachedProjects);
        if (isDebug) {
          addDebugMessage(`📦 /api/projects — loaded ${cachedProjects.length} projects from cache`);
        }
      } else {
        projectsStart = logApiStart('/api/projects');
        projectsFetch = fetch('/api/projects');
        if (isDebug) addDebugMessage(`📤 GET /api/projects — fetching project list`);
      }

      // ── Tasks: always fetch fresh ──────────────────────────────────────
      const tasksStart = logApiStart('/api/tasks/next');
      if (isDebug) addDebugMessage(`📤 GET /api/tasks/next — skip list: (none)`);

      const tasksFetch = fetch('/api/tasks/next');

      // Await both in parallel (projects fetch may be null if using cache)
      const [projectsRes, taskRes] = await Promise.all([
        projectsFetch ?? Promise.resolve(null),
        tasksFetch,
      ]);

      logApiEnd('/api/tasks/next', taskRes.status, tasksStart);

      // ── Process projects response (only if we fetched) ─────────────────
      if (projectsRes !== null) {
        logApiEnd('/api/projects', projectsRes.status, projectsStart);
        const projectsData = await projectsRes.json() as { projects: Project[] };
        const projectsDuration = ((Date.now() - projectsStart) / 1000).toFixed(1);
        const names = (projectsData.projects ?? []).map((p) => p.name).join(', ');
        if (isDebug) {
          addDebugMessage(
            `📥 /api/projects → ${projectsRes.status}  ${projectsDuration}s — loaded ${projectsData.projects?.length ?? 0} projects: ${names || '(none)'}`
          );
        }
        const freshProjects = projectsData.projects ?? [];
        setProjects(freshProjects);
        cacheProjects(freshProjects);
      }

      // ── Process task response ──────────────────────────────────────────
      const taskData = await taskRes.json() as { task: Task | null };
      const tasksDuration = ((Date.now() - tasksStart) / 1000).toFixed(1);

      if (!taskData.task) {
        if (isDebug) addDebugMessage(`📥 /api/tasks/next → ${taskRes.status}  ${tasksDuration}s — no more tasks`);
        setSessionDone(true);
        return;
      }

      const t = taskData.task;
      if (isDebug) {
        addDebugMessage(
          `📥 /api/tasks/next → ${taskRes.status}  ${tasksDuration}s — task: "${t.title}" (priority: ${t.priority ?? 'none'}, date: ${t.dateToWorkOn ?? 'none'})`
        );
      }
      setCurrentTask(taskData.task);
    };

    run().catch((err) => log(`prefetch error: ${err instanceof Error ? err.message : String(err)}`));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Start session (called on tap / type-instead — data already prefetched) ─

  const loadSession = useCallback(() => {
    // Read from ref, not state — avoids stale closure if the user taps before
    // the prefetch useEffect's setCurrentTask re-render has propagated.
    const task = currentTaskRef.current;

    const speakIntro = (title: string) => {
      const msg = `Let's get started. First task: ${title}`;
      ttsQueueRef.current.push(msg);
      if (!ttsDrainingRef.current) drainTtsQueue();
    };

    if (task) {
      addMessage('assistant', `Let's get started. First task: **${task.title}**`);
      speakIntro(task.title);
    } else if (sessionDone) {
      addMessage('assistant', 'All caught up — no more tasks to review!');
    } else {
      // Prefetch still in flight — show a placeholder so the chat area appears,
      // then replace it once the task arrives.
      addMessage('assistant', 'Loading your first task...');
      const wait = setInterval(() => {
        if (currentTaskRef.current) {
          clearInterval(wait);
          const t = currentTaskRef.current;
          // Replace placeholder with real intro
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.content === 'Loading your first task...');
            if (idx === -1) return [...prev, { role: 'assistant', content: `Let's get started. First task: **${t.title}**` }];
            const next = [...prev];
            next[idx] = { role: 'assistant', content: `Let's get started. First task: **${t.title}**` };
            return next;
          });
          speakIntro(t.title);
        }
      }, 100);
      // Give up after 10 seconds (session done or genuine no-task state)
      setTimeout(() => clearInterval(wait), 10000);
    }
  }, [sessionDone, addMessage, drainTtsQueue]); // currentTask removed from deps — using ref instead

  // ── Confirm / cancel pending update ──────────────────────────────────────

  const handleConfirmUpdate = useCallback(async () => {
    const pending = pendingUpdateRef.current;
    if (!pending) return;
    setPendingUpdate(null);

    if (debugMode) {
      const fieldsSummary = Object.entries(pending.fields)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ');
      addDebugMessage(`📤 POST /api/tasks/update — taskId: ${pending.taskId}\n   fields: {${fieldsSummary}}`);
    }

    const startTime = logApiStart('/api/tasks/update');
    try {
      const res = await fetch('/api/tasks/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: pending.taskId, fields: pending.fields }),
      });
      const durationS = ((Date.now() - startTime) / 1000).toFixed(1);
      logApiEnd('/api/tasks/update', res.status, startTime);

      if (res.ok) {
        if (debugMode) {
          addDebugMessage(`📥 /api/tasks/update → ${res.status}  ${durationS}s — updated successfully`);
        }
        addMessage('assistant', 'Task updated!');
      } else {
        let errBody = '';
        try { errBody = await res.text(); } catch { /* ignore */ }
        if (debugMode) {
          addDebugMessage(`📥 /api/tasks/update → ${res.status}  ${durationS}s — ${errBody.slice(0, 200) || 'error'}`);
        }
        addMessage('assistant', 'Update failed — please try again.');
        return;
      }
      await fetchNextTask(skipListRef.current);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const durationS = ((Date.now() - startTime) / 1000).toFixed(1);
      logApiEnd('/api/tasks/update', 0, startTime, message);

      if (debugMode) {
        addDebugMessage(`📥 /api/tasks/update → error  ${durationS}s — ${message}`);
      }

      addMessage('assistant', 'Update failed — please try again.');
    }
  }, [addMessage, fetchNextTask, logApiStart, logApiEnd, debugMode, addDebugMessage]);

  const handleCancelUpdate = useCallback(() => {
    setPendingUpdate(null);
    addMessage('assistant', "Okay, what would you like to change?");
  }, [addMessage]);

  // ── Streaming chat send ───────────────────────────────────────────────────

  const sendMessages = useCallback(async (msgs: Message[]) => {
    setVoiceStateLogged('processing');
    setResponseText('');
    lastPayloadRef.current = msgs;

    let fullText = '';
    let sentenceBuffer = '';

    const startTime = logApiStart('/api/chat');
    log(`POST /api/chat (${msgs.length} msgs)`);

    // Debug: request bubble
    if (debugMode) {
      const lastUserMsg = [...msgs].reverse().find((m) => m.role === 'user');
      const lastUserPreview = lastUserMsg ? lastUserMsg.content.slice(0, 100) : '(none)';
      const taskTitle = currentTaskRef.current?.title ?? '(no task)';
      addDebugMessage(
        `📤 POST /api/chat — ${msgs.length} messages, task: "${taskTitle}"\n   last user: "${lastUserPreview}"`
      );
    }

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: msgs,
          currentTask: currentTaskRef.current,
          projects: projects,
        }),
      });

      if (!response.ok || !response.body) {
        let errorPreview: string | undefined;
        try { errorPreview = await response.text(); } catch { /* ignore */ }
        const durationS = ((Date.now() - startTime) / 1000).toFixed(1);
        logApiEnd('/api/chat', response.status, startTime, errorPreview);
        if (debugMode) {
          addDebugMessage(`📥 /api/chat → ${response.status}  ${durationS}s — ${errorPreview ?? 'error'}`);
        }
        setResponseText(
          response.status === 503
            ? 'API not configured — check environment variables.'
            : 'Something went wrong. Try again.'
        );
        setTimeout(() => setResponseText(''), 3000);
        setVoiceStateLogged('unlocked');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const { cleaned, toolEvents, errorMessages } = extractToolLines(chunk);

        for (const event of toolEvents) {
          log(event);
          if (debugMode) {
            const toolCallMatch = event.match(/^\[TOOL:([^:]+):(.+)\]$/);
            const toolResultMatch = event.match(/^\[TOOL_RESULT:([^:]+):(.+)\]$/);
            if (toolCallMatch) {
              const [, name, rawArgs] = toolCallMatch;
              let prettyArgs: string;
              try { prettyArgs = JSON.stringify(JSON.parse(rawArgs), null, 2); }
              catch { prettyArgs = rawArgs; }
              addDebugMessage(`tool ${name} called — ${prettyArgs}`);
            } else if (toolResultMatch) {
              const [, name, rawResult] = toolResultMatch;
              let prettyResult: string;
              try { prettyResult = JSON.stringify(JSON.parse(rawResult), null, 2); }
              catch { prettyResult = rawResult; }
              addDebugMessage(`${name} result — ${prettyResult.slice(0, 800)}`);
            }
          }
        }

        for (const errMsg of errorMessages) {
          log(`[ERROR] ${errMsg}`);
          if (debugMode) addDebugMessage(`Error: ${errMsg}`);
          if (!fullText) {
            setResponseText(`Error: ${errMsg}`);
            setTimeout(() => setResponseText(''), 5000);
            setVoiceStateLogged('unlocked');
            logApiEnd('/api/chat', 0, startTime, errMsg);
            reader.cancel();
            return;
          }
        }

        fullText += cleaned;
        sentenceBuffer += cleaned;
        // Don't show or speak JSON action responses (confirm/skip/update)
        const looksLikeAction = fullText.trimStart().startsWith('{') || fullText.trimStart().startsWith('```');
        if (!looksLikeAction) {
          setResponseText(fullText);

          // Only chunk on sentence endings (.!?) — avoids choppy mid-sentence splits
          const hasSentenceEnd = /[.!?]/.test(sentenceBuffer.slice(-1));
          if (hasSentenceEnd) {
            const chunk = sentenceBuffer.trim();
            sentenceBuffer = '';
            if (chunk && !isToolLine(chunk)) {
              ttsQueueRef.current.push(chunk);
              if (!ttsDrainingRef.current) drainTtsQueue();
            }
          }
        }
      }

      // Flush any leftover buffer after stream ends
      const remaining = sentenceBuffer.trim();
      const looksLikeActionFinal = fullText.trimStart().startsWith('{') || fullText.trimStart().startsWith('```');
      if (remaining && !isToolLine(remaining) && !looksLikeActionFinal) {
        ttsQueueRef.current.push(remaining);
        if (!ttsDrainingRef.current) drainTtsQueue();
      }

      logApiEnd('/api/chat', response.status, startTime, fullText.slice(0, 200));
      if (debugMode) {
        const durationS = ((Date.now() - startTime) / 1000).toFixed(1);
        // Parse action type for richer response bubble
        let actionSummary = '';
        try {
          let trimmedFull = fullText.trim();
          const fenceMatch = trimmedFull.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
          if (fenceMatch) trimmedFull = fenceMatch[1].trim();
          if (!trimmedFull.startsWith('{')) {
            const jsonMatch = trimmedFull.match(/\{[\s\S]*"action"[\s\S]*\}/);
            if (jsonMatch) trimmedFull = jsonMatch[0];
          }
          const parsed = JSON.parse(trimmedFull) as { action?: string; summary?: string };
          if (parsed.action === 'confirm') {
            actionSummary = `action: confirm — ${(parsed.summary ?? '').slice(0, 200)}`;
          } else if (parsed.action === 'skip') {
            actionSummary = 'action: skip';
          } else {
            actionSummary = `action: ${parsed.action ?? 'unknown'}`;
          }
        } catch {
          actionSummary = fullText.slice(0, 150);
        }
        addDebugMessage(`📥 /api/chat → ${response.status}  ${durationS}s — ${actionSummary}`);
      }

      // Detect JSON actions — don't add them to visible chat history
      const isJsonAction = /\{[\s\S]*"action"[\s\S]*\}/.test(fullText.trim()) ||
        /^```(?:json)?\s*\{[\s\S]*"action"[\s\S]*\}\s*```$/.test(fullText.trim());

      // Add assistant message to history only for non-action responses
      if (fullText.trim() && !isJsonAction) {
        pushMessages([{ role: 'assistant', content: fullText }]);
      }
      setResponseText('');

      // Handle AI action response (skip/update) or follow-up question
      await handleAIResponse(fullText);

      // If no TTS was queued (e.g. JSON action with no summary, or empty response),
      // ensure we don't stay stuck in 'processing'.
      if (!ttsDrainingRef.current && ttsQueueRef.current.length === 0) {
        if (vadActiveRef.current) {
          setVoiceStateLogged('listening');
        } else {
          setVoiceStateLogged('unlocked');
        }
      }

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`/api/chat error: ${message}`);
      logApiEnd('/api/chat', 0, startTime, message);
      setVoiceStateLogged('unlocked');
    }
  }, [
    drainTtsQueue, setVoiceStateLogged, log, logApiStart, logApiEnd,
    debugMode, addDebugMessage, pushMessages, handleAIResponse, projects,
  ]);

  // ── Text input submit ─────────────────────────────────────────────────────

  const handleTextSubmit = useCallback(() => {
    const text = textInput.trim();
    if (!text) return;
    if (voiceState === 'processing' || voiceState === 'speaking') return;
    if (sessionDone) return;

    setTextInput('');

    // Task E: intercept message when a confirmation is pending
    const pending = pendingUpdateRef.current;
    if (pending) {
      const intent = classifyConfirmation(text);
      if (intent === 'yes') {
        handleConfirmUpdate();
        return;
      } else if (intent === 'no') {
        handleCancelUpdate();
        return;
      }
      // 'other' — fall through to AI with pending fields as context
    }

    // Pass pending fields as context for 'other' intent (or no pending update)
    let messageContent = text;
    if (pending) {
      setPendingUpdate(null);
      messageContent = `[Revising pending update with fields: ${JSON.stringify(pending.fields)}] ${text}`;
    }

    const newMessage: Message = { role: 'user', content: messageContent };
    const displayMessage: Message = { role: 'user', content: text };
    const updated = [...messages, newMessage];
    pushMessages([displayMessage]);
    sendMessages(updated);
  }, [textInput, voiceState, messages, sendMessages, pushMessages, sessionDone, handleConfirmUpdate, handleCancelUpdate]);

  const handleTextKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') { e.preventDefault(); handleTextSubmit(); }
    },
    [handleTextSubmit]
  );

  // ── Hold-to-speak recording ───────────────────────────────────────────────

  const startHoldRecord = useCallback(async () => {
    log('hold-to-speak recording started');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      holdChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) holdChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(holdChunksRef.current, { type: recorder.mimeType });
        const formData = new FormData();
        formData.append('audio', blob, 'audio.webm');

        setVoiceStateLogged('processing');
        const tStartTime = logApiStart('/api/transcribe');
        try {
          const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
          const data = await res.json() as { transcript?: string };
          logApiEnd('/api/transcribe', res.status, tStartTime, data.transcript);
          const transcript: string = data.transcript ?? '';
          if (transcript.trim()) {
            if (debugMode) addDebugMessage(`Transcribed: "${transcript}"`);
            showTranscriptFlash(transcript);

            // Task E: intercept hold-to-speak transcript when confirmation is pending
            const pending = pendingUpdateRef.current;
            if (pending) {
              const intent = classifyConfirmation(transcript);
              if (intent === 'yes') {
                handleConfirmUpdate();
                return;
              } else if (intent === 'no') {
                handleCancelUpdate();
                return;
              }
              // 'other' — fall through with pending fields as context
            }

            let messageContent = transcript;
            if (pending) {
              setPendingUpdate(null);
              messageContent = `[Revising pending update with fields: ${JSON.stringify(pending.fields)}] ${transcript}`;
            }
            const newMessage: Message = { role: 'user', content: messageContent };
            const displayMessage: Message = { role: 'user', content: transcript };
            const updated = [...messages, newMessage];
            pushMessages([displayMessage]);
            sendMessages(updated);
          } else {
            setVoiceStateLogged('unlocked');
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`/api/transcribe error: ${message}`);
          logApiEnd('/api/transcribe', 0, tStartTime, message);
          setVoiceStateLogged('unlocked');
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setVoiceStateLogged('listening');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`hold-to-speak mic error: ${message}`);
    }
  }, [messages, sendMessages, setVoiceStateLogged, log, logApiStart, logApiEnd, showTranscriptFlash, debugMode, addDebugMessage, pushMessages, handleConfirmUpdate, handleCancelUpdate]);

  const stopHoldRecord = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
  }, []);

  // ── VAD speech-end handler ────────────────────────────────────────────────

  const handleVADSpeechEnd = useCallback(
    async (audio: Float32Array) => {
      setVadSpeaking(false);
      log('VAD speech end detected');

      // Audio gate — skip clips that are too short (likely noise/breath)
      if (audio.length < 4800) {
        log(`VAD: clip too short (${audio.length} samples), skipping`);
        return;
      }

      const wavBlob = float32ArrayToWav(audio, 16000);
      const formData = new FormData();
      formData.append('audio', wavBlob, 'audio.wav');

      setVoiceStateLogged('processing');
      const tStartTime = logApiStart('/api/transcribe');
      try {
        const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
        const data = await res.json() as { transcript?: string };
        logApiEnd('/api/transcribe', res.status, tStartTime, data.transcript);
        const transcript: string = data.transcript ?? '';
        if (transcript.trim()) {
          if (debugMode) addDebugMessage(`Transcribed: "${transcript}"`);
          showTranscriptFlash(transcript);

          // Task E: intercept VAD transcript when confirmation is pending
          const pending = pendingUpdateRef.current;
          if (pending) {
            const intent = classifyConfirmation(transcript);
            if (intent === 'yes') {
              handleConfirmUpdate();
              return;
            } else if (intent === 'no') {
              handleCancelUpdate();
              return;
            }
            // 'other' — fall through with pending fields as context
          }

          let messageContent = transcript;
          if (pending) {
            setPendingUpdate(null);
            messageContent = `[Revising pending update with fields: ${JSON.stringify(pending.fields)}] ${transcript}`;
          }
          const newMessage: Message = { role: 'user', content: messageContent };
          const displayMessage: Message = { role: 'user', content: transcript };
          const updated = [...messages, newMessage];
          pushMessages([displayMessage]);
          sendMessages(updated);
        } else {
          setVoiceStateLogged('listening');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`/api/transcribe error: ${message}`);
        logApiEnd('/api/transcribe', 0, tStartTime, message);
        setVoiceStateLogged('listening');
      }
    },
    [messages, sendMessages, setVoiceStateLogged, log, logApiStart, logApiEnd, showTranscriptFlash, debugMode, addDebugMessage, pushMessages, handleConfirmUpdate, handleCancelUpdate]
  );

  // ── VAD hook ──────────────────────────────────────────────────────────────

  const vad = useMicVAD({
    startOnLoad: false,
    onSpeechEnd: handleVADSpeechEnd,
    onSpeechStart: () => {
      log('speech start detected');
      setVadSpeaking(true);
    },
    onVADMisfire: () => {
      log('VAD misfire — resetting vadSpeaking');
      setVadSpeaking(false);
    },
    positiveSpeechThreshold: 0.70,
    negativeSpeechThreshold: 0.45,
    minSpeechMs: 250,
    redemptionMs: 600,
    baseAssetPath: '/',
    onnxWASMBasePath: '/',
  });

  useEffect(() => {
    if (vad.errored) {
      log('VAD errored — switching to hold-to-speak');
      vadActiveRef.current = false;
      setHoldToSpeak(true);
    }
  }, [vad.errored, log]);

  // ── Entry points ──────────────────────────────────────────────────────────

  const handleTap = useCallback(async () => {
    if (voiceState !== 'idle') return;
    log('tap → unlocked');
    setVoiceStateLogged('unlocked');
    setSessionStarted(true);

    // Unlock iOS Audio — create the shared AudioContext during this user gesture
    // and keep it alive in audioCtxRef for all subsequent TTS playback.
    try {
      const ctx = new AudioContext();
      await ctx.resume();
      // Play a silent buffer to fully unlock the context on iOS
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
      audioCtxRef.current = ctx;
    } catch { /* Non-fatal */ }

    // Start VAD — wait up to 5s for ONNX model to finish loading
    try {
      if (vad.loading) {
        log('VAD still loading ONNX model, waiting...');
        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const poll = setInterval(() => {
            if (!vad.loading) { clearInterval(poll); resolve(); }
            else if (Date.now() > deadline) { clearInterval(poll); reject(new Error('VAD load timeout')); }
          }, 100);
        });
      }
      await vad.start();
      vadActiveRef.current = true;
      setVoiceStateLogged('listening');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = message.includes('Permission') || message.includes('permission')
        ? ' (microphone permission denied — check browser settings)'
        : '';
      log(`VAD start failed: ${message}${hint}`);
      vadActiveRef.current = false;
      setHoldToSpeak(true);
    }

    // Data already prefetched — just show intro message
    loadSession();
  }, [voiceState, vad, loadSession, setVoiceStateLogged, log]);

  const handleTypeInstead = useCallback(async () => {
    if (voiceState !== 'idle') return;
    log('type instead → unlocked (no audio)');
    setVoiceStateLogged('unlocked');
    setSessionStarted(true);

    // Data already prefetched — just show intro message
    loadSession();
  }, [voiceState, loadSession, setVoiceStateLogged, log]);

  // ── Pause / Resume / End session ─────────────────────────────────────────

  const handlePause = useCallback(() => {
    log('session paused');
    if (vadActiveRef.current) vad.pause();
    ttsQueueRef.current = [];
    ttsDrainingRef.current = false;
    setPaused(true);
    setVoiceStateLogged('unlocked');
  }, [vad, setVoiceStateLogged, log]);

  const handleResume = useCallback(async () => {
    log('session resumed');
    setPaused(false);
    try {
      await vad.start();
      setVoiceStateLogged('listening');
    } catch (err) {
      log(`VAD restart failed: ${err instanceof Error ? err.message : String(err)}`);
      setVoiceStateLogged('unlocked');
    }
  }, [vad, setVoiceStateLogged, log]);

  const handleEndSession = useCallback(() => {
    log('session ended');
    if (vadActiveRef.current) vad.pause();
    vadActiveRef.current = false;
    ttsQueueRef.current = [];
    ttsDrainingRef.current = false;
    setVoiceStateLogged('idle');
    setSessionStarted(false);
    setSessionDone(false);
    setPaused(false);
    setMessages([]);
    msgTimestampsRef.current = [];
    setDebugMessages([]);
    setCurrentTask(null);
    setSkipList([]);
    skipListRef.current = [];
    setPendingUpdate(null);
    setResponseText('');
    setTranscriptFlash('');
  }, [vad, setVoiceStateLogged, log]);

  // ── Pause/restart VAD around TTS ─────────────────────────────────────────

  useEffect(() => {
    if (voiceState === 'speaking' && vadActiveRef.current) {
      vad.pause();
    } else if (voiceState === 'listening' && vadActiveRef.current && !vad.listening) {
      vad.start().catch(() => {});
    }
  }, [voiceState, vad]);

  // ── Render ────────────────────────────────────────────────────────────────

  const isSendDisabled = voiceState === 'processing' || voiceState === 'speaking' || sessionDone;

  // Build combined chat item list
  type ChatItem =
    | { kind: 'message'; msg: Message; key: string }
    | { kind: 'debug'; dbg: DebugMessage; key: string };

  const chatItems: ChatItem[] = [];
  {
    let msgIdx = 0;
    let dbgIdx = 0;
    while (msgIdx < messages.length || dbgIdx < debugMessages.length) {
      const msgTs = msgIdx < messages.length
        ? (msgTimestampsRef.current[msgIdx] ?? Infinity)
        : Infinity;
      const dbgTs = dbgIdx < debugMessages.length ? debugMessages[dbgIdx].timestamp : Infinity;

      if (msgTs <= dbgTs) {
        chatItems.push({ kind: 'message', msg: messages[msgIdx], key: `msg-${msgIdx}` });
        msgIdx++;
      } else {
        chatItems.push({ kind: 'debug', dbg: debugMessages[dbgIdx], key: debugMessages[dbgIdx].id });
        dbgIdx++;
      }
    }
  }

  // ── Idle screen ──

  if (voiceState === 'idle') {
    return (
      <>
        <div
          className="flex flex-col items-center justify-center min-h-screen px-6 bg-gray-950"
        >
          {/* App icon with green glow */}
          <img
            src="/app-icon.png"
            alt="Notion Voice Chat"
            width={90}
            height={90}
            className="mb-5 rounded-2xl"
            style={{ boxShadow: '0 0 24px rgba(94, 224, 41, 0.35)' }}
          />

          {/* App title */}
          <p
            className="text-base font-light tracking-wide mb-10"
            style={{ color: '#EAEFF5' }}
          >
            Notion Voice Chat
          </p>

          {/* Tap to Begin button — Electric Blue pill with blue glow */}
          <button
            onClick={handleTap}
            aria-label="Tap to begin voice session"
            className="relative px-10 py-3.5 rounded-full text-white text-base font-medium tracking-wide focus:outline-none focus-visible:ring-2 focus-visible:ring-white transition-all"
            style={{
              background: '#0DA0E5',
              boxShadow: '0 0 16px rgba(13, 160, 229, 0.45)',
            }}
          >
            Tap to Begin
          </button>

          <button
            onClick={handleTypeInstead}
            className="mt-4 text-sm transition-colors focus:outline-none focus-visible:underline"
            style={{ color: 'rgba(234, 239, 245, 0.45)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'rgba(234, 239, 245, 0.75)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(234, 239, 245, 0.45)')}
            aria-label="Skip microphone and type instead"
          >
            or type instead
          </button>
        </div>

        <DebugPanel
          debugMode={debugMode}
          voiceState={voiceState}
          vadErrored={!!vad.errored}
          vadLoading={vad.loading}
          vadListening={vad.listening}
          holdToSpeak={holdToSpeak}
          messageCount={messages.length}
          events={events}
          lastApiCall={lastApiCall}
          lastPayload={lastPayloadRef.current}
        />
      </>
    );
  }

  // ── Active screen ──

  return (
    <>
      <div
        className={`relative flex flex-col min-h-screen px-4 py-8 gap-4 bg-gray-950${debugMode ? ' pb-80' : ''}`}
      >
        {/* Top-left: voice dropdown + refresh projects button */}
        <div className="absolute top-4 left-4 flex items-center gap-2">
          <select
            value={ttsVoice}
            onChange={(e) => handleVoiceChange(e.target.value)}
            className="text-xs bg-gray-800 border border-gray-700 text-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:border-gray-500"
            aria-label="TTS voice"
          >
            {TTS_VOICES.map((v) => (
              <option key={v.value} value={v.value}>{v.label}</option>
            ))}
          </select>
          <button
            onClick={refreshProjects}
            disabled={projectsRefreshing}
            className="text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40"
            aria-label="Refresh projects cache"
            title="Refresh projects"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`w-4 h-4${projectsRefreshing ? ' animate-spin' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        {/* Top-right: circular mute button */}
        <button
          onClick={toggleTts}
          aria-label={ttsEnabled ? 'Mute text-to-speech' : 'Unmute text-to-speech'}
          className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          {ttsEnabled ? (
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5L6 9H3a1 1 0 00-1 1v4a1 1 0 001 1h3l5 4V5z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.54 8.46a5 5 0 010 7.07" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.07 4.93a10 10 0 010 14.14" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5L6 9H3a1 1 0 00-1 1v4a1 1 0 001 1h3l5 4V5z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l4-4m0 4l-4-4" />
            </svg>
          )}
        </button>

        {/* Task card */}
        <div className="flex justify-center">
          {sessionStarted && !sessionDone && currentTask === null ? (
            // Loading skeleton
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

        {/* Empty state prompt — text mode only, no messages yet */}
        {messages.length === 0 && !sessionStarted && (
          <p className="text-gray-600 text-sm text-center mt-8">
            Loading your tasks...
          </p>
        )}

        {/* Conversation history */}
        {(chatItems.length > 0 || responseText || pendingUpdate) && (
          <div
            ref={chatListRef}
            className="w-full max-w-lg mx-auto flex flex-col gap-2 overflow-y-auto"
            style={{ maxHeight: '40vh' }}
            aria-label="Conversation history"
            aria-live="polite"
          >
            {chatItems.map((item) => {
              if (item.kind === 'message') {
                const msg = item.msg;
                return (
                  <div key={item.key} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-gray-600 text-white rounded-br-sm'
                          : 'bg-gray-800 text-gray-100 rounded-bl-sm'
                      }`}
                    >
                      {msg.role === 'assistant' ? renderMarkdown(msg.content) : msg.content}
                    </div>
                  </div>
                );
              }
              if (!debugMode) return null;
              return (
                <div key={item.key} className="flex justify-start">
                  <pre className="bg-teal-950 border border-teal-800 text-teal-300 font-mono text-xs rounded-lg px-3 py-2 w-full whitespace-pre-wrap break-all">
                    {item.dbg.content}
                  </pre>
                </div>
              );
            })}
            {responseText && (
              <div className="flex justify-start">
                <div className="max-w-[80%] px-3 py-2 rounded-2xl rounded-bl-sm text-sm leading-relaxed bg-gray-800 text-gray-100 italic opacity-80">
                  {responseText}
                </div>
              </div>
            )}

            {/* Pending update hint — user confirms by saying/typing "yes" or "no" */}
            {pendingUpdate && (
              <div className="px-3 py-2 rounded-xl bg-gray-900 border border-gray-700 text-gray-400 text-xs text-center">
                Say or type <span className="text-green-400 font-medium">"yes"</span> to update, or <span className="text-red-400 font-medium">"no"</span> / a correction to revise.
              </div>
            )}
          </div>
        )}

        {/* Bottom controls */}
        <div className="flex flex-col items-center gap-4 mt-auto">
          {transcriptFlash && (
            <div
              className="px-4 py-2 rounded-xl bg-gray-800/90 text-gray-200 text-sm text-center max-w-xs animate-fade-in"
              aria-live="polite"
              aria-label="Transcript"
            >
              &ldquo;{transcriptFlash}&rdquo;
            </div>
          )}

          <StatusIndicator state={voiceState} vadSpeaking={vadSpeaking} />

          {/* Text input bar */}
          <div className="flex w-full max-w-lg gap-2">
            <input
              type="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={handleTextKeyDown}
              placeholder={sessionDone ? 'Session complete' : 'Type a message...'}
              disabled={sessionDone}
              className="flex-1 px-4 py-2.5 rounded-xl bg-gray-800 border border-gray-700 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-gray-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Type a message"
            />
            <button
              onClick={handleTextSubmit}
              disabled={isSendDisabled || !textInput.trim()}
              className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
              aria-label="Send message"
            >
              Send
            </button>
          </div>

          {/* Hold-to-speak fallback */}
          {holdToSpeak && !sessionDone && (
            <button
              onPointerDown={startHoldRecord}
              onPointerUp={stopHoldRecord}
              onPointerLeave={stopHoldRecord}
              className="flex items-center gap-2 px-5 py-3 rounded-xl bg-gray-800 border border-gray-700 text-gray-300 text-sm select-none active:bg-gray-700 transition-colors"
              aria-label="Hold to speak"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a4 4 0 014 4v6a4 4 0 01-8 0V5a4 4 0 014-4z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0M12 19v4M8 23h8" />
              </svg>
              Hold to speak
            </button>
          )}

          {/* Pause / End session controls */}
          {sessionStarted && !sessionDone && (
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={paused ? handleResume : handlePause}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gray-800 border border-gray-700 text-gray-300 text-sm hover:bg-gray-700 transition-colors"
                aria-label={paused ? 'Resume session' : 'Pause session'}
              >
                {paused ? (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    Resume
                  </>
                ) : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                      <line x1="6" y1="4" x2="6" y2="20" strokeLinecap="round" />
                      <line x1="18" y1="4" x2="18" y2="20" strokeLinecap="round" />
                    </svg>
                    Pause
                  </>
                )}
              </button>
              <button
                onClick={handleEndSession}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gray-800 border border-gray-700 text-gray-400 text-sm hover:bg-red-900/40 hover:text-red-300 hover:border-red-800 transition-colors"
                aria-label="End session"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" strokeLinecap="round" />
                  <line x1="6" y1="6" x2="18" y2="18" strokeLinecap="round" />
                </svg>
                End Session
              </button>
            </div>
          )}
        </div>
      </div>

      <DebugPanel
        debugMode={debugMode}
        voiceState={voiceState}
        vadErrored={!!vad.errored}
        vadLoading={vad.loading}
        vadListening={vad.listening}
        holdToSpeak={holdToSpeak}
        messageCount={messages.length}
        events={events}
        lastApiCall={lastApiCall}
        lastPayload={lastPayloadRef.current}
      />
    </>
  );
}
