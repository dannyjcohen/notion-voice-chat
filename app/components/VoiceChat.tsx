'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import TaskCard from './TaskCard';
import StatusIndicator from './StatusIndicator';
import DebugPanel from './DebugPanel';
import { float32ArrayToWav } from '@/lib/audio';
import { useMicVAD } from '@ricky0123/vad-react';
import { useDebugLog } from '@/hooks/useDebugLog';

// ── Types ──────────────────────────────────────────────────────────────────

type VoiceState = 'idle' | 'unlocked' | 'listening' | 'processing' | 'speaking' | 'empty';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface CurrentTask {
  title: string;
  priority: string | null;
  date: string | null;
  description: string | null;
}

// ── Empty-state detector ───────────────────────────────────────────────────

const EMPTY_PHRASES = [
  'no more tasks',
  "all done",
  'queue is empty',
  'nothing left',
  'all caught up',
  'no tasks remaining',
  'nothing to review',
];

function detectEmpty(text: string): boolean {
  const lower = text.toLowerCase();
  return EMPTY_PHRASES.some((phrase) => lower.includes(phrase));
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [responseText, setResponseText] = useState('');
  const [currentTask, setCurrentTask] = useState<CurrentTask | null>(null);
  const [holdToSpeak, setHoldToSpeak] = useState(false);

  // Debug mode — read from URL param via useEffect to avoid SSR issues
  const [debugMode, setDebugMode] = useState(false);
  useEffect(() => {
    setDebugMode(new URLSearchParams(window.location.search).get('debug') === '1');
  }, []);

  // Debug log hook
  const { events, lastApiCall, log, logApiStart, logApiEnd } = useDebugLog();

  // Helper: setState with logging
  const setVoiceStateLogged = useCallback(
    (next: VoiceState) => {
      setVoiceState((prev) => {
        if (prev !== next) {
          log(`state: ${prev} → ${next}`);
        }
        return next;
      });
    },
    [log]
  );

  // TTS queue state
  const ttsQueueRef = useRef<string[]>([]);
  const ttsDrainingRef = useRef(false);

  // Fallback recording for hold-to-speak
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const holdChunksRef = useRef<Blob[]>([]);

  // VAD active flag to know whether we launched VAD successfully
  const vadActiveRef = useRef(false);

  // ── TTS queue drainer ────────────────────────────────────────────────────

  const drainTtsQueue = useCallback(async () => {
    if (ttsDrainingRef.current) return;
    ttsDrainingRef.current = true;
    setVoiceStateLogged('speaking');

    while (ttsQueueRef.current.length > 0) {
      const sentence = ttsQueueRef.current.shift()!;
      log(`TTS: speaking "${sentence.slice(0, 30)}..."`);
      await speakSentence(sentence);
    }

    ttsDrainingRef.current = false;
    // After TTS drains, start listening again (VAD or hold-to-speak)
    if (vadActiveRef.current) {
      setVoiceStateLogged('listening');
    } else {
      setVoiceStateLogged('unlocked');
    }
  }, [setVoiceStateLogged, log]);

  // ── Streaming chat ────────────────────────────────────────────────────────

  const sendMessages = useCallback(async (msgs: Message[]) => {
    setVoiceStateLogged('processing');
    setResponseText('');

    let fullText = '';
    let sentenceBuffer = '';

    const startTime = logApiStart('/api/chat');
    log(`POST /api/chat (${msgs.length} msgs)`);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: msgs }),
      });

      if (!response.ok || !response.body) {
        // Try to capture response body for debug preview
        let errorPreview: string | undefined;
        try {
          errorPreview = await response.text();
        } catch {
          // ignore
        }
        logApiEnd('/api/chat', response.status, startTime, errorPreview);

        // Show user-visible error for non-ok responses
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
        fullText += chunk;
        sentenceBuffer += chunk;
        setResponseText(fullText);

        // Push complete sentences to TTS queue
        const sentences = sentenceBuffer.match(/[^.!?]+[.!?]+/g) ?? [];
        for (const s of sentences) {
          const trimmed = s.trim();
          if (trimmed) {
            ttsQueueRef.current.push(trimmed);
          }
        }
        if (sentences.length > 0) {
          // Strip everything up to and including the last sentence-ending punctuation.
          sentenceBuffer = sentenceBuffer.replace(/[\s\S]*[.!?]+/, '');
          if (!ttsDrainingRef.current) {
            drainTtsQueue();
          }
        }
      }

      // Push any remaining buffer
      const remaining = sentenceBuffer.trim();
      if (remaining) {
        ttsQueueRef.current.push(remaining);
        if (!ttsDrainingRef.current) {
          drainTtsQueue();
        }
      }

      logApiEnd('/api/chat', response.status, startTime, fullText.slice(0, 200));

      // Update messages with assistant response
      setMessages((prev) => [...prev, { role: 'assistant', content: fullText }]);

      // Detect empty state
      if (detectEmpty(fullText)) {
        setVoiceStateLogged('empty');
        return;
      }

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`/api/chat error: ${message}`);
      logApiEnd('/api/chat', 0, startTime, message);
      setVoiceStateLogged('unlocked');
    }
  }, [drainTtsQueue, setVoiceStateLogged, log, logApiStart, logApiEnd]);

  // ── Manual Done / Skip buttons ────────────────────────────────────────────

  const handleDone = useCallback(() => {
    const newMessage: Message = { role: 'user', content: 'Mark this task as done.' };
    const updated = [...messages, newMessage];
    setMessages(updated);
    sendMessages(updated);
  }, [messages, sendMessages]);

  const handleSkip = useCallback(() => {
    const newMessage: Message = { role: 'user', content: 'Skip this task to tomorrow.' };
    const updated = [...messages, newMessage];
    setMessages(updated);
    sendMessages(updated);
  }, [messages, sendMessages]);

  // ── Hold-to-speak recording ────────────────────────────────────────────────

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
            const newMessage: Message = { role: 'user', content: transcript };
            const updated = [...messages, newMessage];
            setMessages(updated);
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
      // Mic permission denied — stay unlocked
    }
  }, [messages, sendMessages, setVoiceStateLogged, log, logApiStart, logApiEnd]);

  const stopHoldRecord = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
  }, []);

  // ── VAD speech-end handler ─────────────────────────────────────────────────

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
          const newMessage: Message = { role: 'user', content: transcript };
          const updated = [...messages, newMessage];
          setMessages(updated);
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
    [messages, sendMessages, setVoiceStateLogged, log, logApiStart, logApiEnd]
  );

  // ── VAD hook ──────────────────────────────────────────────────────────────

  const vad = useMicVAD({
    startOnLoad: false,
    onSpeechEnd: handleVADSpeechEnd,
    onSpeechStart: () => {
      log('speech start detected');
    },
    // Point ONNX runtime and VAD assets to files served from public/
    // Without this, Turbopack tries to serve ort-wasm-simd-threaded.mjs from
    // /_next/static/chunks/ which 404s.
    baseAssetPath: '/',
    onnxWASMBasePath: '/',
  });

  // Track whether VAD errored so we can show hold-to-speak fallback
  useEffect(() => {
    if (vad.errored) {
      log('VAD errored — switching to hold-to-speak');
      vadActiveRef.current = false;
      setHoldToSpeak(true);
    }
  }, [vad.errored, log]);

  // ── iOS AudioContext unlock + first message ───────────────────────────────

  const handleTap = useCallback(async () => {
    if (voiceState !== 'idle') return;
    log('tap → unlocked');
    setVoiceStateLogged('unlocked');

    // Step 1: Unlock iOS Audio
    try {
      const ctx = new AudioContext();
      await ctx.resume();
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch {
      // Non-fatal — some browsers don't require this
    }

    // Step 2: Start VAD (may fail on iOS — fallback handles it)
    try {
      await vad.start();
      vadActiveRef.current = true;
      setVoiceStateLogged('listening');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`VAD start failed: ${message}`);
      vadActiveRef.current = false;
      log('holdToSpeak = true');
      setHoldToSpeak(true);
    }

    // Step 3: Send initial message to kick off the session
    const initial: Message[] = [{ role: 'user', content: 'Start the review session.' }];
    setMessages(initial);
    sendMessages(initial);
  }, [voiceState, vad, sendMessages, setVoiceStateLogged, log]);

  // ── Pause/restart VAD around TTS ─────────────────────────────────────────

  useEffect(() => {
    if (voiceState === 'speaking' && vadActiveRef.current) {
      vad.pause();
    } else if (voiceState === 'listening' && vadActiveRef.current && !vad.listening) {
      vad.start().catch(() => {});
    }
  }, [voiceState, vad]);

  // ── Render ─────────────────────────────────────────────────────────────────

  // ── Idle screen ──
  if (voiceState === 'idle') {
    return (
      <>
        <div className="flex flex-col items-center justify-center min-h-screen bg-gray-950 px-6">
          <p className="text-gray-400 text-sm tracking-wide uppercase mb-10 font-medium">
            Notion Voice Chat
          </p>

          <button
            onClick={handleTap}
            aria-label="Tap to begin voice session"
            className="relative flex items-center justify-center w-32 h-32 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            {/* Pulsing outer ring */}
            <span className="absolute inset-0 rounded-full bg-white opacity-10 animate-ping" />
            {/* Solid circle */}
            <span className="relative flex items-center justify-center w-32 h-32 rounded-full bg-white">
              {/* Mic icon */}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-10 h-10 text-gray-950"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 1a4 4 0 014 4v6a4 4 0 01-8 0V5a4 4 0 014-4z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 11a7 7 0 01-14 0M12 19v4M8 23h8"
                />
              </svg>
            </span>
          </button>

          <p className="mt-8 text-gray-400 text-base">Tap to begin</p>
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
        />
      </>
    );
  }

  // ── Empty state ──
  if (voiceState === 'empty') {
    return (
      <>
        <div className="flex flex-col items-center justify-center min-h-screen bg-gray-950 px-6 gap-4">
          <div className="flex items-center justify-center w-20 h-20 rounded-full bg-green-600">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-10 h-10 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-semibold text-white">All caught up!</h2>
          <p className="text-gray-400 text-sm">No more tasks to review.</p>
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
        />
      </>
    );
  }

  // ── Active screen (unlocked / listening / processing / speaking) ──
  return (
    <>
      <div className="flex flex-col min-h-screen bg-gray-950 px-4 py-8 gap-6">
        {/* Top: task card */}
        <div className="flex justify-center">
          {currentTask ? (
            <TaskCard
              title={currentTask.title}
              priority={currentTask.priority}
              date={currentTask.date}
              description={currentTask.description}
            />
          ) : (
            <div className="w-full max-w-lg h-28 rounded-2xl bg-gray-900 border border-gray-800 animate-pulse" />
          )}
        </div>

        {/* Middle: streaming response text */}
        {responseText && (
          <div className="w-full max-w-lg mx-auto">
            <p className="text-white text-base leading-relaxed">{responseText}</p>
          </div>
        )}

        {/* Bottom: status + controls */}
        <div className="flex flex-col items-center gap-4 mt-auto">
          <StatusIndicator state={voiceState} />

          {/* Done + Skip buttons */}
          <div className="flex gap-4">
            <button
              onClick={handleDone}
              disabled={voiceState === 'processing' || voiceState === 'speaking'}
              className="px-5 py-2.5 rounded-xl bg-green-700 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
              aria-label="Mark task as done"
            >
              Done
            </button>
            <button
              onClick={handleSkip}
              disabled={voiceState === 'processing' || voiceState === 'speaking'}
              className="px-5 py-2.5 rounded-xl bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
              aria-label="Skip task to tomorrow"
            >
              Skip
            </button>
          </div>

          {/* Hold-to-speak fallback (shown when VAD unavailable) */}
          {holdToSpeak && (
            <button
              onPointerDown={startHoldRecord}
              onPointerUp={stopHoldRecord}
              onPointerLeave={stopHoldRecord}
              className="mt-2 flex items-center gap-2 px-5 py-3 rounded-xl bg-gray-800 border border-gray-700 text-gray-300 text-sm select-none active:bg-gray-700 transition-colors"
              aria-label="Hold to speak"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 1a4 4 0 014 4v6a4 4 0 01-8 0V5a4 4 0 014-4z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 11a7 7 0 01-14 0M12 19v4M8 23h8"
                />
              </svg>
              Hold to speak
            </button>
          )}
        </div>
      </div>

      {/* Debug panel — fixed overlay, zero production impact */}
      <DebugPanel
        debugMode={debugMode}
        voiceState={voiceState}
        vadErrored={!!vad.errored}
        vadListening={vad.listening}
        holdToSpeak={holdToSpeak}
        messageCount={messages.length}
        events={events}
        lastApiCall={lastApiCall}
      />
    </>
  );
}
