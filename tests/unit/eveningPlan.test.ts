/**
 * The 21:00 planning (src/agenda/eveningPlan.ts). Pure. America/Sao_Paulo is UTC-3.
 * What is proven: the 21:00–06:00 window and its edges; which tasks make the list and why, in what order; that Wendy never sets a priority or a deadline;
 * and that the proposal is text built from records only.
 */
import { describe, expect, it } from 'vitest';
import { analyzeAgenda, localInstant, type AgendaMeeting } from '../../src/agenda/analysis.js';
import { buildEveningPlan, inPlanningWindow, localHour, type PlanTask } from '../../src/agenda/eveningPlan.js';

const TZ = 'America/Sao_Paulo';
const L = (day: string, hhmm: string) => localInstant(day, hhmm, TZ);
const hm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const MON = '2026-10-19';
const TUE = '2026-10-20';
const NOW = L(MON, '21:30');
let n = 0;
const meet = (day: string, a: string, b: string, title: string): AgendaMeeting => ({ id: `m${++n}`, title, starts_at: L(day, a), ends_at: L(day, b) });
const task = (title: string, due: Date | null, priority: PlanTask['priority'] = null): PlanTask => ({ id: `t${++n}`, title, due_at: due, priority });
const plan = (meetings: AgendaMeeting[], tasks: PlanTask[], now = NOW) => {
  const a = analyzeAgenda({ now, timeZone: TZ, meetings, days: 2 });
  return buildEveningPlan({ now, timeZone: TZ, tomorrow: a.days[1]!, todayKey: a.days[0]!.day, tasks, hm });
};

describe('the planning window', () => {
  it('is open from 21:00 to 05:59 local and closed otherwise, on the right side of each edge', () => {
    expect(inPlanningWindow(L(MON, '20:59'), TZ)).toBe(false);
    expect(inPlanningWindow(L(MON, '21:00'), TZ)).toBe(true);
    expect(inPlanningWindow(L(MON, '23:59'), TZ)).toBe(true);
    expect(inPlanningWindow(L(TUE, '00:00'), TZ)).toBe(true);
    expect(inPlanningWindow(L(TUE, '05:59'), TZ)).toBe(true);
    expect(inPlanningWindow(L(TUE, '06:00'), TZ)).toBe(false);
    expect(inPlanningWindow(L(TUE, '12:00'), TZ)).toBe(false);
  });
  it('uses the LOCAL hour, not the UTC one', () => {
    const t = L(MON, '21:30'); // 00:30Z of the 20th
    expect(t.toISOString()).toBe('2026-10-20T00:30:00.000Z');
    expect(localHour(t, TZ)).toBe(21);
    expect(plan([], [], t).inWindow).toBe(true);
    expect(plan([], [], L(MON, '15:00')).inWindow).toBe(false);
  });
});

describe('which tasks are on the list, and why', () => {
  it('lists overdue, due tomorrow, and the ones the PERSON marked urgent or high, in that order of weight', () => {
    const p = plan([], [task('Alta', null, 'HIGH'), task('Amanhã', L(TUE, '10:00')), task('Urgente', null, 'URGENT'), task('Atrasada', L(MON, '09:00'))]);
    expect(p.tasks.map((t) => [t.title, t.why])).toEqual([
      ['Atrasada', 'atrasada'],
      ['Urgente', 'marcada por você como urgente'],
      ['Amanhã', 'vence amanhã'],
      ['Alta', 'marcada por você como alta'],
    ]);
  });
  it('leaves out tasks with no reason: no date, normal or low or unsaid priority, or due after tomorrow', () => {
    const p = plan([], [task('Sem nada', null), task('Normal', null, 'NORMAL'), task('Baixa', null, 'LOW'), task('Depois', L('2026-10-25', '10:00'))]);
    expect(p.tasks).toEqual([]);
  });
  it('a task due late tomorrow evening is "tomorrow" by the LOCAL date, even if it is the day after in UTC', () => {
    const p = plan([], [task('Tarde', L(TUE, '23:30'))]);
    expect(p.tasks[0]).toMatchObject({ title: 'Tarde', why: 'vence amanhã' });
  });
  it('a task due today, even at 23:59, is overdue for tomorrow\'s plan; one due at 00:00 tomorrow is due tomorrow', () => {
    expect(plan([], [task('Hoje', L(MON, '23:59'))]).tasks[0]!.why).toBe('atrasada');
    expect(plan([], [task('Meia-noite', L(TUE, '00:00'))]).tasks[0]!.why).toBe('vence amanhã');
  });
  it('shows at most five and says how many were left out', () => {
    const many = Array.from({ length: 8 }, (_, i) => task(`T${i}`, L(MON, '08:00')));
    const p = plan([], many);
    expect(p.tasks).toHaveLength(5);
    expect(p.notes.join(' ')).toMatch(/5 de 8/);
  });
  it('never invents a priority or a deadline: what is shown is what the task already had', () => {
    const due = L(TUE, '10:00');
    const p = plan([], [task('Revisar', due)]);
    expect(p.tasks[0]!.dueAt).toBe(due.toISOString());
    const noDate = plan([], [task('Só urgente', null, 'URGENT')]);
    expect(noDate.tasks[0]!.dueAt).toBeNull();
  });
});

describe('the proposal', () => {
  it('names tomorrow\'s fixed meetings with their times, and says so when there are none', () => {
    expect(plan([meet(TUE, '10:00', '11:00', 'Reunião X')], []).proposal[0]).toBe('Compromissos fixos: 10:00–11:00 Reunião X.');
    expect(plan([], []).proposal[0]).toBe('Sem compromissos marcados para amanhã.');
  });
  it('points the first free block at the most pressing task, and only says "could", never books', () => {
    const p = plan([], [task('Fechar relatório', L(MON, '09:00'))]);
    const line = p.proposal.find((l) => l.startsWith('Bloco livre'))!;
    expect(line).toMatch(/dá para usar com “Fechar relatório” \(atrasada\)/);
    expect(p.notes.join(' ')).toMatch(/Nada é marcado nem aceito/);
  });
  it('reports a conflict tomorrow without changing anything, and a day with no 90-minute block', () => {
    const c = plan([meet(TUE, '10:00', '11:00', 'A'), meet(TUE, '10:30', '11:30', 'B')], []);
    expect(c.proposal.join(' ')).toMatch(/“A” e “B” se sobrepõem por 30 min\. Eu não mudo nada/);
    const full = plan([meet(TUE, '09:00', '11:00', 'a'), meet(TUE, '12:00', '14:00', 'b'), meet(TUE, '15:00', '18:00', 'c')], []);
    expect(full.proposal.join(' ')).toMatch(/Não sobra um bloco livre de 90 min/);
  });
  it('a day off is said to be a day off', () => {
    const FRI = L('2026-10-23', '21:30');
    const p = buildEveningPlan({ now: FRI, timeZone: TZ, todayKey: '2026-10-23', tasks: [], hm, tomorrow: analyzeAgenda({ now: FRI, timeZone: TZ, meetings: [], days: 2 }).days[1]! }); // Saturday
    expect(p.proposal.join(' ')).toMatch(/fora dos dias de trabalho/);
  });
  it('asks the question and does not answer it', () => {
    const p = plan([], []);
    expect(p.question).toBe('Quais são as suas prioridades para amanhã?');
    expect(p.notes.join(' ')).toMatch(/Eu não defino prioridade nem prazo/);
  });
});
