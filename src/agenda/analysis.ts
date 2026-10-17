/**
 * Smart agenda (docs/CONCIERGE_2_PLAN.md, phase 3). A plain, deterministic reading of the meetings already in the calendar: conflicts, stretches with
 * no break, overloaded days, free windows that could be protected for focus, and layered reminders. It only SUGGESTS: nothing here accepts, declines,
 * moves or cancels a meeting, and nothing is written to Google. Every threshold is in `AgendaConfig` and is echoed in the result so it can be checked
 * and changed. Travel time is NOT estimated: it needs a place and a map service, so the departure reminder says so instead of guessing.
 *
 * Pure: no database, no clock of its own. `now` and the timezone (default America/Sao_Paulo) come in.
 */
export interface AgendaMeeting {
  id: string;
  title: string;
  starts_at: Date;
  ends_at: Date;
}

export interface AgendaConfig {
  /** Local working window, HH:MM. Focus suggestions are made only inside it. */
  workStart: string;
  workEnd: string;
  /** Days of the week that are working days (0 = Sunday). */
  workDays: number[];
  /** A free window shorter than this is not offered as a focus block. */
  minFocusMinutes: number;
  /** A suggested focus block is at most this long (the first part of the window). */
  maxFocusBlockMinutes: number;
  /** Meetings closer than this are "back to back". */
  minGapMinutes: number;
  /** A run of back-to-back meetings this long, or longer, is flagged as having no break. */
  maxContinuousMinutes: number;
  /** More meeting time than this in one day is flagged as overloaded. */
  maxMeetingMinutesPerDay: number;
  reminders: { label: string; minutes: number }[];
}

export const DEFAULT_AGENDA_CONFIG: AgendaConfig = {
  workStart: '09:00',
  workEnd: '18:00',
  workDays: [1, 2, 3, 4, 5],
  minFocusMinutes: 90,
  maxFocusBlockMinutes: 180,
  minGapMinutes: 10,
  maxContinuousMinutes: 180,
  maxMeetingMinutesPerDay: 360,
  reminders: [
    { label: '1 dia antes', minutes: 1440 },
    { label: '1 hora antes', minutes: 60 },
  ],
};

export interface AgendaConflict {
  a: { id: string; title: string };
  b: { id: string; title: string };
  overlapMinutes: number;
}
export interface AgendaChain {
  meetingIds: string[];
  count: number;
  totalMinutes: number;
}
export interface FocusSuggestion {
  start: string;
  end: string;
  minutes: number;
}
export interface AgendaReminder {
  meetingId: string;
  title: string;
  label: string;
  at: string;
}
export interface AgendaDay {
  /** YYYY-MM-DD in the principal's timezone. */
  day: string;
  workingDay: boolean;
  meetings: { id: string; title: string; start: string; end: string }[];
  meetingMinutes: number;
  conflicts: AgendaConflict[];
  noBreak: AgendaChain[];
  overloaded: { minutes: number; limit: number } | null;
  focus: FocusSuggestion[];
}
export interface AgendaAnalysis {
  generatedAt: string;
  timeZone: string;
  days: AgendaDay[];
  reminders: AgendaReminder[];
  /** Said plainly: the departure time is not estimated. */
  departure: string;
  rules: string[];
  summary: { conflicts: number; overloadedDays: number; noBreakRuns: number; focusBlocks: number; meetings: number };
}

const MIN = 60_000;
const DAY = 86_400_000;

/** The timezone's offset from UTC at a given instant, in ms (positive east of Greenwich). */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(utcMs / 1000) * 1000;
}

/** A local wall-clock time ("2026-10-16", "09:00") as the real instant, in that timezone. */
export function localInstant(day: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - tzOffsetMs(guess, timeZone);
  t = guess - tzOffsetMs(t, timeZone); // once more: near a clock change the first offset can be the wrong side
  return new Date(t);
}

export const localDay = (d: Date, timeZone: string): string => d.toLocaleDateString('en-CA', { timeZone });
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (day: string): number => new Date(`${day}T12:00:00Z`).getUTCDay();
const minutesBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / MIN);

type Span = { start: number; end: number };
function union(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

export interface AgendaInput {
  now: Date;
  timeZone?: string;
  /** Meetings that are not cancelled. */
  meetings: AgendaMeeting[];
  /** How many local days to analyse, starting with today. */
  days?: number;
  config?: Partial<AgendaConfig>;
}

export function analyzeAgenda(input: AgendaInput): AgendaAnalysis {
  const timeZone = input.timeZone ?? 'America/Sao_Paulo';
  const cfg: AgendaConfig = { ...DEFAULT_AGENDA_CONFIG, ...input.config };
  const nDays = Math.min(31, Math.max(1, Math.floor(input.days ?? 7)));
  const today = localDay(input.now, timeZone);
  const valid = input.meetings.filter((m) => m.ends_at.getTime() > m.starts_at.getTime());
  const days: AgendaDay[] = [];
  const reminders: AgendaReminder[] = [];

  for (let i = 0; i < nDays; i++) {
    const day = addDays(today, i);
    const dayStart = localInstant(day, '00:00', timeZone).getTime();
    const dayEnd = localInstant(addDays(day, 1), '00:00', timeZone).getTime();
    const mine = valid.filter((m) => m.starts_at.getTime() >= dayStart && m.starts_at.getTime() < dayEnd).sort((a, b) => a.starts_at.getTime() - b.starts_at.getTime() || a.id.localeCompare(b.id));

    const conflicts: AgendaConflict[] = [];
    for (let x = 0; x < mine.length; x++)
      for (let y = x + 1; y < mine.length; y++) {
        const a = mine[x]!;
        const b = mine[y]!;
        if (b.starts_at.getTime() >= a.ends_at.getTime()) continue;
        conflicts.push({ a: { id: a.id, title: a.title }, b: { id: b.id, title: b.title }, overlapMinutes: minutesBetween(b.starts_at, new Date(Math.min(a.ends_at.getTime(), b.ends_at.getTime()))) });
      }

    // Runs of meetings with less than minGapMinutes between them; a run is reported when it lasts maxContinuousMinutes or more.
    const noBreak: AgendaChain[] = [];
    let run: AgendaMeeting[] = [];
    let runEnd = 0;
    const flush = () => {
      if (run.length >= 2) {
        const total = Math.round((runEnd - run[0]!.starts_at.getTime()) / MIN);
        if (total >= cfg.maxContinuousMinutes) noBreak.push({ meetingIds: run.map((m) => m.id), count: run.length, totalMinutes: total });
      }
      run = [];
    };
    for (const m of mine) {
      if (run.length && m.starts_at.getTime() - runEnd < cfg.minGapMinutes * MIN) {
        run.push(m);
        runEnd = Math.max(runEnd, m.ends_at.getTime());
      } else {
        flush();
        run = [m];
        runEnd = m.ends_at.getTime();
      }
    }
    flush();

    const busy = union(mine.map((m) => ({ start: m.starts_at.getTime(), end: m.ends_at.getTime() })));
    const meetingMinutes = Math.round(busy.reduce((n, s) => n + (s.end - s.start), 0) / MIN);
    const overloaded = meetingMinutes > cfg.maxMeetingMinutesPerDay ? { minutes: meetingMinutes, limit: cfg.maxMeetingMinutesPerDay } : null;

    // Free windows inside the working window (today: only what is still ahead, rounded up to a quarter hour), offered as focus blocks.
    const workingDay = cfg.workDays.includes(weekday(day));
    const focus: FocusSuggestion[] = [];
    if (workingDay) {
      let from = localInstant(day, cfg.workStart, timeZone).getTime();
      const to = localInstant(day, cfg.workEnd, timeZone).getTime();
      if (i === 0) from = Math.max(from, Math.ceil(input.now.getTime() / (15 * MIN)) * 15 * MIN);
      const free: Span[] = [];
      let cursor = from;
      for (const b of busy) {
        if (b.end <= cursor) continue;
        if (b.start >= to) break;
        if (b.start > cursor) free.push({ start: cursor, end: Math.min(b.start, to) });
        cursor = Math.max(cursor, b.end);
      }
      if (cursor < to) free.push({ start: cursor, end: to });
      const candidates = free.map((w) => ({ start: w.start, minutes: Math.min(cfg.maxFocusBlockMinutes, Math.floor((w.end - w.start) / MIN)), whole: Math.floor((w.end - w.start) / MIN) })).filter((w) => w.whole >= cfg.minFocusMinutes);
      candidates.sort((a, b) => b.minutes - a.minutes || a.start - b.start);
      for (const c of candidates.slice(0, 2).sort((a, b) => a.start - b.start)) focus.push({ start: new Date(c.start).toISOString(), end: new Date(c.start + c.minutes * MIN).toISOString(), minutes: c.minutes });
    }

    days.push({ day, workingDay, meetings: mine.map((m) => ({ id: m.id, title: m.title, start: m.starts_at.toISOString(), end: m.ends_at.toISOString() })), meetingMinutes, conflicts, noBreak, overloaded, focus });

    for (const m of mine)
      for (const r of cfg.reminders) {
        const at = m.starts_at.getTime() - r.minutes * MIN;
        if (at > input.now.getTime() && m.starts_at.getTime() > input.now.getTime()) reminders.push({ meetingId: m.id, title: m.title, label: r.label, at: new Date(at).toISOString() });
      }
  }
  reminders.sort((a, b) => a.at.localeCompare(b.at) || a.meetingId.localeCompare(b.meetingId));

  const rules = [
    `Janela de trabalho: ${cfg.workStart}–${cfg.workEnd}, dias ${cfg.workDays.join(',')} (0 = domingo), fuso ${timeZone}.`,
    `Bloco de foco: janela livre de pelo menos ${cfg.minFocusMinutes} min, oferecido por até ${cfg.maxFocusBlockMinutes} min, no máximo 2 por dia.`,
    `Sem pausa: reuniões com menos de ${cfg.minGapMinutes} min entre elas, somando ${cfg.maxContinuousMinutes} min ou mais.`,
    `Dia sobrecarregado: mais de ${cfg.maxMeetingMinutesPerDay} min de reunião (sem contar sobreposição duas vezes).`,
    'Isto só sugere. Nada é aceito, recusado, remarcado ou cancelado, e nada é gravado na agenda do Google.',
  ];
  return {
    generatedAt: input.now.toISOString(),
    timeZone,
    days,
    reminders,
    departure: 'O horário de saída não é estimado: precisa do local do compromisso, do meio de transporte e de um serviço de mapas, que ainda não estão ligados.',
    rules,
    summary: {
      meetings: days.reduce((n, d) => n + d.meetings.length, 0),
      conflicts: days.reduce((n, d) => n + d.conflicts.length, 0),
      overloadedDays: days.filter((d) => d.overloaded).length,
      noBreakRuns: days.reduce((n, d) => n + d.noBreak.length, 0),
      focusBlocks: days.reduce((n, d) => n + d.focus.length, 0),
    },
  };
}
