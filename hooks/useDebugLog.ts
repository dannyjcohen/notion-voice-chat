'use client';

import { useCallback, useRef, useState } from 'react';

export interface DebugEvent {
  time: string;
  message: string;
}

export interface ApiCall {
  endpoint: string;
  status: number | 'pending';
  duration?: number;
  responsePreview?: string;
}

export function useDebugLog() {
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [lastApiCall, setLastApiCall] = useState<ApiCall | null>(null);

  const log = useCallback((message: string) => {
    const time = new Date().toTimeString().slice(0, 8);
    setEvents((prev) => [{ time, message }, ...prev].slice(0, 20));
  }, []);

  const logApiStart = useCallback((endpoint: string): number => {
    const start = Date.now();
    const time = new Date().toTimeString().slice(0, 8);
    setEvents((prev) =>
      [{ time, message: `POST ${endpoint} → pending...` }, ...prev].slice(0, 20)
    );
    setLastApiCall({ endpoint, status: 'pending' });
    return start;
  }, []);

  const logApiEnd = useCallback((
    endpoint: string,
    status: number,
    startTime: number,
    responsePreview?: string
  ) => {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const time = new Date().toTimeString().slice(0, 8);
    setEvents((prev) =>
      [{ time, message: `POST ${endpoint} → ${status} (${duration}s)` }, ...prev].slice(0, 20)
    );
    setLastApiCall({
      endpoint,
      status,
      duration: parseFloat(duration),
      responsePreview,
    });
  }, []);

  return { events, lastApiCall, log, logApiStart, logApiEnd };
}
