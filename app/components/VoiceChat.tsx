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
  projectId: string | null;
  projectName: string | null;
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

// ── TTS helpers ────────────────────────────────────────────────────────────

async function speakSentence(text: string): Promise<void> {
  try {
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    return new Promise((resolve) => {
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
      audio.play().catch(() => resolve());
    });
  } catch {
    // Non-fatal — continue without audio
  }
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
      if (ttsEnabledRef.current) {
        log(`TTS: speaking "${sentence.slice(0, 30)}..."`);
        await speakSentence(sentence);
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
    const res = await fetch(url);
    const data = await res.json() as { task: Task | null };
    if (!data.task) {
      setSessionDone(true);
      addMessage('assistant', 'All caught up — no more tasks to review!');
      return;
    }
    setCurrentTask(data.task);
    addMessage('assistant', `Next task: **${data.task.title}**`);
  }, [addMessage]);

  // ── Handle AI response (JSON action or follow-up text) ───────────────────

  const currentTaskRef = useRef<Task | null>(null);
  const skipListRef = useRef<string[]>([]);

  // Keep refs in sync with state
  useEffect(() => { currentTaskRef.current = currentTask; }, [currentTask]);
  useEffect(() => { skipListRef.current = skipList; }, [skipList]);

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
      const action = JSON.parse(trimmed) as { action: string; fields?: Record<string, string> };
      if (action.action === 'skip' && currentTaskRef.current) {
        const newSkipList = [...skipListRef.current, currentTaskRef.current.id];
        setSkipList(newSkipList);
        await fetchNextTask(newSkipList);
      } else if (action.action === 'update' && action.fields && currentTaskRef.current) {
        await fetch('/api/tasks/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: currentTaskRef.current.id, fields: action.fields }),
        });
        addMessage('assistant', 'Task updated! Pulling the next one...');
        await fetchNextTask(skipListRef.current);
      }
    } catch {
      // Not JSON — it's a follow-up question, display it normally (already in messages)
    }
  }, [fetchNextTask, addMessage]);

  // ── Load session on mount ─────────────────────────────────────────────────

  const loadSession = useCallback(async () => {
    log('loadSession: fetching projects + first task');
    const [projectsRes, taskRes] = await Promise.all([
      fetch('/api/projects'),
      fetch('/api/tasks/next'),
    ]);

    const projectsData = await projectsRes.json() as { projects: Project[] };
    const taskData = await taskRes.json() as { task: Task | null };

    setProjects(projectsData.projects ?? []);

    if (!taskData.task) {
      setSessionDone(true);
      addMessage('assistant', 'All caught up — no more tasks to review!');
      return;
    }

    setCurrentTask(taskData.task);
    addMessage('assistant', `Let's get started. First task: **${taskData.task.title}**`);
  }, [log, addMessage]);

  // ── Streaming chat send ───────────────────────────────────────────────────

  const sendMessages = useCallback(async (msgs: Message[]) => {
    setVoiceStateLogged('processing');
    setResponseText('');
    lastPayloadRef.current = msgs;

    let fullText = '';
    let sentenceBuffer = '';

    const startTime = logApiStart('/api/chat');
    log(`POST /api/chat (${msgs.length} msgs)`);

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
          addDebugMessage(`/api/chat ${response.status} ${durationS}s — ${errorPreview ?? ''}`);
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
        // Don't show JSON action responses in the live streaming preview
        const looksLikeAction = fullText.trimStart().startsWith('{') || fullText.trimStart().startsWith('```');
        if (!looksLikeAction) {
          setResponseText(fullText);
        }

        const sentences = sentenceBuffer.match(/[^.!?]+[.!?]+/g) ?? [];
        for (const s of sentences) {
          const trimmed = s.trim();
          if (trimmed && !isToolLine(trimmed)) {
            ttsQueueRef.current.push(trimmed);
          }
        }
        if (sentences.length > 0) {
          sentenceBuffer = sentenceBuffer.replace(/[\s\S]*[.!?]+/, '');
          if (!ttsDrainingRef.current) drainTtsQueue();
        }
      }

      const remaining = sentenceBuffer.trim();
      if (remaining && !isToolLine(remaining)) {
        ttsQueueRef.current.push(remaining);
        if (!ttsDrainingRef.current) drainTtsQueue();
      }

      logApiEnd('/api/chat', response.status, startTime, fullText.slice(0, 200));
      if (debugMode) {
        const durationS = ((Date.now() - startTime) / 1000).toFixed(1);
        addDebugMessage(`/api/chat ${response.status} ${durationS}s`);
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
    const newMessage: Message = { role: 'user', content: text };
    const updated = [...messages, newMessage];
    pushMessages([newMessage]);
    sendMessages(updated);
  }, [textInput, voiceState, messages, sendMessages, pushMessages, sessionDone]);

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
            const newMessage: Message = { role: 'user', content: transcript };
            const updated = [...messages, newMessage];
            pushMessages([newMessage]);
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
  }, [messages, sendMessages, setVoiceStateLogged, log, logApiStart, logApiEnd, showTranscriptFlash, debugMode, addDebugMessage, pushMessages]);

  const stopHoldRecord = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
  }, []);

  // ── VAD speech-end handler ────────────────────────────────────────────────

  const handleVADSpeechEnd = useCallback(
    async (audio: Float32Array) => {
      log('VAD speech end detected');
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
          const newMessage: Message = { role: 'user', content: transcript };
          const updated = [...messages, newMessage];
          pushMessages([newMessage]);
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
    [messages, sendMessages, setVoiceStateLogged, log, logApiStart, logApiEnd, showTranscriptFlash, debugMode, addDebugMessage, pushMessages]
  );

  // ── VAD hook ──────────────────────────────────────────────────────────────

  const vad = useMicVAD({
    startOnLoad: false,
    onSpeechEnd: handleVADSpeechEnd,
    onSpeechStart: () => { log('speech start detected'); },
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

    // Unlock iOS Audio
    try {
      const ctx = new AudioContext();
      await ctx.resume();
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch { /* Non-fatal */ }

    // Start VAD
    try {
      await vad.start();
      vadActiveRef.current = true;
      setVoiceStateLogged('listening');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`VAD start failed: ${message}`);
      vadActiveRef.current = false;
      setHoldToSpeak(true);
    }

    // Load session data
    await loadSession();
  }, [voiceState, vad, loadSession, setVoiceStateLogged, log]);

  const handleTypeInstead = useCallback(async () => {
    if (voiceState !== 'idle') return;
    log('type instead → unlocked (no audio)');
    setVoiceStateLogged('unlocked');
    setSessionStarted(true);

    // Load session data — projects + first task
    await loadSession();
  }, [voiceState, loadSession, setVoiceStateLogged, log]);

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
        <div className="flex flex-col items-center justify-center min-h-screen bg-gray-950 px-6">
          <p className="text-gray-400 text-sm tracking-wide uppercase mb-10 font-medium">
            Notion Task Review
          </p>

          <button
            onClick={handleTap}
            aria-label="Tap to begin voice session"
            className="relative flex items-center justify-center w-32 h-32 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <span className="absolute inset-0 rounded-full bg-white opacity-10 animate-ping" />
            <span className="relative flex items-center justify-center w-32 h-32 rounded-full bg-white">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-10 h-10 text-gray-950"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a4 4 0 014 4v6a4 4 0 01-8 0V5a4 4 0 014-4z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0M12 19v4M8 23h8" />
              </svg>
            </span>
          </button>

          <p className="mt-8 text-gray-400 text-base">Tap to begin</p>

          <button
            onClick={handleTypeInstead}
            className="mt-3 text-gray-600 text-sm hover:text-gray-400 transition-colors focus:outline-none focus-visible:underline"
            aria-label="Skip microphone and type instead"
          >
            or type instead
          </button>
        </div>

        <DebugPanel
          debugMode={debugMode}
          voiceState={voiceState}
          vadErrored={!!vad.errored}
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
      <div className={`relative flex flex-col min-h-screen bg-gray-950 px-4 py-8 gap-4${debugMode ? ' pb-80' : ''}`}>
        {/* TTS mute toggle */}
        <button
          onClick={toggleTts}
          aria-label={ttsEnabled ? 'Mute text-to-speech' : 'Unmute text-to-speech'}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
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
              title={currentTask.title}
              priority={currentTask.priority}
              date={currentTask.dateToWorkOn}
              status={currentTask.status}
              effort={currentTask.effort}
              projectName={currentTask.projectName}
              description={currentTask.description}
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
        {(chatItems.length > 0 || responseText) && (
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

          <StatusIndicator state={voiceState} />

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
        </div>
      </div>

      <DebugPanel
        debugMode={debugMode}
        voiceState={voiceState}
        vadErrored={!!vad.errored}
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
