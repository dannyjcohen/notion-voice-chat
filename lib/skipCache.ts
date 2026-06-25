import { getEasternDateString } from './date';

const SKIP_CACHE_KEY = 'nvc:skip';

interface SkipCache {
  date: string;
  ids: string[];
}

/**
 * Returns the list of task IDs skipped today (Eastern time).
 * Returns [] if the cache is missing, stale (different day), or running SSR.
 */
export function getSkipIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(SKIP_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SkipCache;
    const today = getEasternDateString();
    if (parsed.date !== today) return [];
    return Array.isArray(parsed.ids) ? parsed.ids : [];
  } catch {
    return [];
  }
}

/**
 * Adds a task ID to today's skip cache (Eastern time).
 * Deduplicates — adding the same ID twice is a no-op.
 * No-op when running SSR.
 */
export function addSkipId(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    const today = getEasternDateString();
    const existing = getSkipIds();
    if (existing.includes(id)) return;
    const next: SkipCache = { date: today, ids: [...existing, id] };
    localStorage.setItem(SKIP_CACHE_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable — silently ignore
  }
}
