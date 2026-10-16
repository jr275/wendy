/**
 * When is a daily routine due? Pure: the clock and the existing run for the day come in.
 *
 * The day is the routine's LOCAL day (its own timezone, normally America/Sao_Paulo), never UTC: at 23:30 in São Paulo it is already tomorrow
 * in UTC, and a routine must not run twice (or skip a day) because of that. One run per routine per local date is also what the database
 * enforces (UNIQUE (routine_id, run_date)); this decides what to TRY, the unique key decides who WINS.
 */
export const MAX_ATTEMPTS = 3;
export const RETRY_AFTER_MIN = 15;
export const LEASE_MIN = 10;

export interface RoutineRow {
  id: string;
  principal_id: string;
  kind: string;
  enabled: boolean;
  /** "HH:MM" or "HH:MM:SS", in the routine's timezone. */
  local_time: string;
  timezone: string;
  paused_until: Date | null;
}

export interface RunRow {
  status: 'RUNNING' | 'DONE' | 'FAILED';
  attempts: number;
  lease_until: Date | null;
  started_at: Date;
  finished_at: Date | null;
}

export type Decision = { action: 'claim' } | { action: 'reclaim' } | { action: 'skip'; reason: 'disabled' | 'paused' | 'too_early' | 'done' | 'running' | 'retry_later' | 'gave_up' | 'bad_time' };

/** The local calendar date (YYYY-MM-DD) and the minutes since local midnight, for an instant in a timezone. */
export function localParts(now: Date, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function timeToMinutes(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export function decide(r: RoutineRow, now: Date, today: RunRow | null): Decision {
  if (!r.enabled) return { action: 'skip', reason: 'disabled' };
  if (r.paused_until && r.paused_until.getTime() > now.getTime()) return { action: 'skip', reason: 'paused' };
  const at = timeToMinutes(r.local_time);
  if (at === null) return { action: 'skip', reason: 'bad_time' };
  if (localParts(now, r.timezone).minutes < at) return { action: 'skip', reason: 'too_early' };
  if (!today) return { action: 'claim' };
  if (today.status === 'DONE') return { action: 'skip', reason: 'done' };
  if (today.attempts >= MAX_ATTEMPTS) return { action: 'skip', reason: 'gave_up' };
  if (today.status === 'RUNNING') return today.lease_until && today.lease_until.getTime() > now.getTime() ? { action: 'skip', reason: 'running' } : { action: 'reclaim' };
  // FAILED: try again after a pause, not in a tight loop
  const since = now.getTime() - (today.finished_at ?? today.started_at).getTime();
  return since >= RETRY_AFTER_MIN * 60_000 ? { action: 'reclaim' } : { action: 'skip', reason: 'retry_later' };
}
