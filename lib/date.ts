/**
 * Date helpers that are always Eastern time (America/New_York).
 * Handles EST/EDT automatically — no manual offset needed.
 */

/** Returns today's date in Eastern time as YYYY-MM-DD */
export function getEasternDateString(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date);
}

/** Returns tomorrow's date in Eastern time as YYYY-MM-DD */
export function getEasternTomorrowString(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return getEasternDateString(tomorrow);
}
