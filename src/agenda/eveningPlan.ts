/**
 * The 21:00 planning (docs/CONCIERGE_2_PLAN.md, phase 3): from 21:00 until 06:00 local, Wendy puts in front of the person what tomorrow looks like and ASKS
 * what the priorities are. It is computed when the person opens the app (nothing runs at 21:00 by itself, nothing is stored, nothing is pushed to the phone:
 * the channel is inside the app, as decided). Pure: `now`, the timezone, tomorrow's analysis and the open tasks come in.
 *
 * Wendy proposes, from records only: tomorrow's meetings, the free blocks, and the tasks that are overdue, due tomorrow, or that the PERSON marked HIGH/URGENT.
 * She never sets a priority, never invents a deadline, and never books anything: the proposal is text for the person to accept, change or ignore.
 */
import type { AgendaDay } from './analysis.js';

export interface PlanTask {
  id: string;
  title: string;
  due_at: Date | null;
  /** The person's own word; null = not said. */
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | null;
}

export const PLANNING_START_HOUR = 21;
export const PLANNING_END_HOUR = 6;

/** The local hour (0–23) of an instant in a timezone. */
export function localHour(d: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(d));
}

/** True from 21:00 until 05:59 local. */
export function inPlanningWindow(now: Date, timeZone: string): boolean {
  const h = localHour(now, timeZone);
  return h >= PLANNING_START_HOUR || h < PLANNING_END_HOUR;
}

export interface PlanTaskLine {
  id: string;
  title: string;
  /** Why it is on the list, in words. */
  why: 'atrasada' | 'vence amanhã' | 'marcada por você como urgente' | 'marcada por você como alta';
  dueAt: string | null;
}
export interface EveningPlan {
  generatedAt: string;
  timeZone: string;
  /** Whether it is 21:00–05:59 now. Outside it the plan is still readable, but the home does not push it. */
  inWindow: boolean;
  /** The day being planned, YYYY-MM-DD. */
  day: string;
  meetings: AgendaDay['meetings'];
  conflicts: AgendaDay['conflicts'];
  overloaded: AgendaDay['overloaded'];
  focus: AgendaDay['focus'];
  tasks: PlanTaskLine[];
  /** Text lines of the proposal (what could go where). Suggestions only. */
  proposal: string[];
  /** What Wendy asks the person. */
  question: string;
  notes: string[];
}

const WHY_ORDER: Record<PlanTaskLine['why'], number> = { atrasada: 0, 'marcada por você como urgente': 1, 'vence amanhã': 2, 'marcada por você como alta': 3 };

export function buildEveningPlan(input: { now: Date; timeZone: string; tomorrow: AgendaDay; todayKey: string; tasks: PlanTask[]; hm: (iso: string) => string }): EveningPlan {
  const { now, timeZone, tomorrow, tasks, hm } = input;
  const dayOf = (d: Date) => d.toLocaleDateString('en-CA', { timeZone });
  const lines: PlanTaskLine[] = [];
  for (const t of tasks) {
    const due = t.due_at ? dayOf(t.due_at) : null;
    let why: PlanTaskLine['why'] | null = null;
    if (due !== null && due < tomorrow.day) why = 'atrasada';
    else if (due === tomorrow.day) why = 'vence amanhã';
    else if (t.priority === 'URGENT') why = 'marcada por você como urgente';
    else if (t.priority === 'HIGH') why = 'marcada por você como alta';
    if (why) lines.push({ id: t.id, title: t.title, why, dueAt: t.due_at?.toISOString() ?? null });
  }
  lines.sort((a, b) => WHY_ORDER[a.why] - WHY_ORDER[b.why] || (a.dueAt ?? '').localeCompare(b.dueAt ?? '') || a.id.localeCompare(b.id));
  const shown = lines.slice(0, 5);

  const proposal: string[] = [];
  if (tomorrow.meetings.length) proposal.push(`Compromissos fixos: ${tomorrow.meetings.map((m) => `${hm(m.start)}–${hm(m.end)} ${m.title}`).join('; ')}.`);
  else proposal.push('Sem compromissos marcados para amanhã.');
  for (const c of tomorrow.conflicts) proposal.push(`Atenção: “${c.a.title}” e “${c.b.title}” se sobrepõem por ${c.overlapMinutes} min. Eu não mudo nada: você decide.`);
  if (tomorrow.overloaded) proposal.push(`Dia pesado: ${Math.floor(tomorrow.overloaded.minutes / 60)} h ${tomorrow.overloaded.minutes % 60} min de reunião.`);
  if (tomorrow.focus.length) {
    const first = shown[0];
    for (const [i, f] of tomorrow.focus.entries()) proposal.push(`Bloco livre ${hm(f.start)}–${hm(f.end)}${i === 0 && first ? `: dá para usar com “${first.title}” (${first.why}).` : '.'}`);
  } else if (tomorrow.workingDay) proposal.push('Não sobra um bloco livre de 90 min dentro do horário de trabalho.');
  if (!tomorrow.workingDay) proposal.push('Amanhã está fora dos dias de trabalho configurados.');

  const notes = [
    'É uma proposta feita só com a sua agenda e as suas tarefas. Eu não defino prioridade nem prazo: as tarefas listadas são as atrasadas, as que vencem amanhã e as que você mesmo marcou como urgentes ou altas.',
    'Nada é marcado nem aceito. A agenda do Google não é alterada.',
  ];
  if (lines.length > shown.length) notes.push(`Mostrei 5 de ${lines.length} tarefas; as demais continuam na sua lista.`);
  return {
    generatedAt: now.toISOString(),
    timeZone,
    inWindow: inPlanningWindow(now, timeZone),
    day: tomorrow.day,
    meetings: tomorrow.meetings,
    conflicts: tomorrow.conflicts,
    overloaded: tomorrow.overloaded,
    focus: tomorrow.focus,
    tasks: shown,
    proposal,
    question: 'Quais são as suas prioridades para amanhã?',
    notes,
  };
}
