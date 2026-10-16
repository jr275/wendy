/**
 * Weekly review: a plain, deterministic reading of what the principal already has — open tasks, open commitments, the week's meetings,
 * and what waits for their approval. No model, no guessing: every line comes from a record, and the one "next action" is chosen by a rule
 * that is written in the result itself, so it can be checked and disagreed with.
 *
 * Pure (no database, no clock of its own): `now` and the timezone come in. The loader (loader.ts) reads the records.
 */
export interface ReviewTask {
  id: string;
  title: string;
  due_at: Date | null;
}
export interface ReviewCommitment {
  id: string;
  description: string;
  due_at: Date | null;
}
export interface ReviewMeeting {
  id: string;
  title: string;
  starts_at: Date;
  ends_at: Date | null;
}
export interface ReviewAwaiting {
  id: string;
  label: string;
}
export interface ReviewInput {
  now: Date;
  timeZone: string;
  tasks: ReviewTask[];
  commitments: ReviewCommitment[];
  /** Meetings that are not cancelled; only the ones inside the window are used. */
  meetings: ReviewMeeting[];
  awaiting: ReviewAwaiting[];
  /** What was closed in the 7 days before `now` (counts only). */
  closedLastWeek: { tasks: number; commitments: number };
}

export type ReviewKind = 'task' | 'commitment' | 'meeting' | 'approval';
export interface ReviewItem {
  kind: ReviewKind;
  id: string;
  title: string;
  /** When it is due / starts; null for an approval or a task with no date. */
  at: Date | null;
}
export interface DayLoad {
  /** YYYY-MM-DD in the principal's timezone. */
  day: string;
  count: number;
  /** The simple rule says this day is full (see BUSY_DAY). */
  busy: boolean;
}
export interface WeeklyReview {
  generatedAt: Date;
  windowDays: number;
  /** Past due, oldest first. */
  overdue: ReviewItem[];
  /** Due or starting within the window, soonest first. */
  upcoming: ReviewItem[];
  /** Open tasks that have no date: listed, never ranked. */
  undated: ReviewItem[];
  waitingOnYou: ReviewItem[];
  load: DayLoad[];
  closedLastWeek: { tasks: number; commitments: number };
  /** The one thing to look at first, and the rule that picked it. null when there is nothing. */
  next: { item: ReviewItem; rule: string } | null;
  empty: boolean;
}

export const WINDOW_DAYS = 7;
/** A day with this many dated items (tasks, commitments, meetings) is flagged "cheio". A transparent threshold, not a judgement. */
export const BUSY_DAY = 4;
const DAY = 86_400_000;

export const NEXT_RULES = {
  approval: 'Primeiro o que está parado esperando a sua aprovação.',
  overdue: 'Sem aprovação pendente: o item vencido há mais tempo.',
  upcoming: 'Nada vencido: o que vence ou começa primeiro.',
} as const;

export function dayKey(d: Date, timeZone: string): string {
  return d.toLocaleDateString('en-CA', { timeZone });
}

const byAt = (a: ReviewItem, b: ReviewItem): number => (a.at!.getTime() - b.at!.getTime()) || a.title.localeCompare(b.title, 'pt-BR');

export function buildWeeklyReview(input: ReviewInput): WeeklyReview {
  const { now, timeZone } = input;
  const end = new Date(now.getTime() + WINDOW_DAYS * DAY);

  const dated: ReviewItem[] = [
    ...input.tasks.filter((t) => t.due_at).map((t): ReviewItem => ({ kind: 'task', id: t.id, title: t.title, at: t.due_at })),
    ...input.commitments.filter((c) => c.due_at).map((c): ReviewItem => ({ kind: 'commitment', id: c.id, title: c.description, at: c.due_at })),
  ];
  const overdue = dated.filter((i) => i.at!.getTime() < now.getTime()).sort(byAt);
  const dueSoon = dated.filter((i) => i.at!.getTime() >= now.getTime() && i.at!.getTime() <= end.getTime());
  const meetings = input.meetings
    .filter((m) => m.starts_at.getTime() >= now.getTime() && m.starts_at.getTime() <= end.getTime())
    .map((m): ReviewItem => ({ kind: 'meeting', id: m.id, title: m.title, at: m.starts_at }));
  const upcoming = [...dueSoon, ...meetings].sort(byAt);
  const undated = input.tasks.filter((t) => !t.due_at).map((t): ReviewItem => ({ kind: 'task', id: t.id, title: t.title, at: null }));
  const waitingOnYou = input.awaiting.map((a): ReviewItem => ({ kind: 'approval', id: a.id, title: a.label, at: null }));

  const counts = new Map<string, number>();
  for (const i of upcoming) counts.set(dayKey(i.at!, timeZone), (counts.get(dayKey(i.at!, timeZone)) ?? 0) + 1);
  const load: DayLoad[] = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count, busy: count >= BUSY_DAY }));

  const next: WeeklyReview['next'] = waitingOnYou[0]
    ? { item: waitingOnYou[0], rule: NEXT_RULES.approval }
    : overdue[0]
      ? { item: overdue[0], rule: NEXT_RULES.overdue }
      : upcoming[0]
        ? { item: upcoming[0], rule: NEXT_RULES.upcoming }
        : null;

  return {
    generatedAt: now,
    windowDays: WINDOW_DAYS,
    overdue,
    upcoming,
    undated,
    waitingOnYou,
    load,
    closedLastWeek: input.closedLastWeek,
    next,
    empty: !overdue.length && !upcoming.length && !undated.length && !waitingOnYou.length,
  };
}
