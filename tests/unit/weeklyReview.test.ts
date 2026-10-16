/**
 * Weekly review (src/review/weekly.ts). Pure: no database, no clock, no model. Every line of the review comes from a record, and the one
 * "next action" is picked by a rule that is part of the result.
 */
import { describe, expect, it } from 'vitest';
import { BUSY_DAY, buildWeeklyReview, dayKey, NEXT_RULES, WINDOW_DAYS, type ReviewInput } from '../../src/review/weekly.js';

const NOW = new Date('2026-10-15T15:00:00.000Z'); // 12:00 in São Paulo
const TZ = 'America/Sao_Paulo';
const at = (offsetH: number) => new Date(NOW.getTime() + offsetH * 3_600_000);
const input = (over: Partial<ReviewInput> = {}): ReviewInput => ({ now: NOW, timeZone: TZ, tasks: [], commitments: [], meetings: [], awaiting: [], closedLastWeek: { tasks: 0, commitments: 0 }, ...over });
const task = (id: string, due: Date | null, title = `tarefa ${id}`) => ({ id, title, due_at: due });
const commit = (id: string, due: Date | null) => ({ id, description: `compromisso ${id}`, due_at: due });
const meet = (id: string, start: Date) => ({ id, title: `reunião ${id}`, starts_at: start, ends_at: null });

describe('buildWeeklyReview: what goes where', () => {
  it('nothing at all is an honest empty review, with no next action', () => {
    const r = buildWeeklyReview(input());
    expect(r.empty).toBe(true);
    expect(r.next).toBeNull();
    expect(r.overdue).toEqual([]);
    expect(r.upcoming).toEqual([]);
    expect(r.load).toEqual([]);
  });
  it('past due vs upcoming is decided by the instant: before now is overdue, exactly now and after is upcoming', () => {
    const r = buildWeeklyReview(input({ tasks: [task('a', at(-0.001)), task('b', at(0)), task('c', at(1))] }));
    expect(r.overdue.map((i) => i.id)).toEqual(['a']);
    expect(r.upcoming.map((i) => i.id)).toEqual(['b', 'c']);
  });
  it('the window is 7 days, end included; one millisecond later is outside and is not listed at all', () => {
    const end = new Date(NOW.getTime() + WINDOW_DAYS * 86_400_000);
    const r = buildWeeklyReview(input({ tasks: [task('in', end), task('out', new Date(end.getTime() + 1))] }));
    expect(r.upcoming.map((i) => i.id)).toEqual(['in']);
    expect(r.overdue).toEqual([]);
    expect(r.undated).toEqual([]); // beyond the window is neither "undated" nor shown
  });
  it('tasks and commitments with no date are listed apart and never ranked or chosen as next', () => {
    const r = buildWeeklyReview(input({ tasks: [task('x', null)], commitments: [commit('y', null)] }));
    expect(r.undated.map((i) => i.id)).toEqual(['x']); // a commitment with no date has no place here and is not invented one
    expect(r.next).toBeNull();
    expect(r.empty).toBe(false);
  });
  it('meetings are only upcoming ones inside the window; past meetings are not in the review', () => {
    const r = buildWeeklyReview(input({ meetings: [meet('past', at(-2)), meet('soon', at(3)), meet('far', at(24 * 8))] }));
    expect(r.upcoming.map((i) => i.id)).toEqual(['soon']);
    expect(r.overdue).toEqual([]);
  });
  it('overdue is oldest first, upcoming is soonest first, and ties break by title so the order is stable', () => {
    const r = buildWeeklyReview(input({ tasks: [task('o2', at(-5)), task('o1', at(-50)), task('u2', at(30), 'b'), task('u1', at(30), 'a')], commitments: [commit('uc', at(10))] }));
    expect(r.overdue.map((i) => i.id)).toEqual(['o1', 'o2']);
    expect(r.upcoming.map((i) => i.id)).toEqual(['uc', 'u1', 'u2']);
  });
  it('waiting approvals are listed and carry no date', () => {
    const r = buildWeeklyReview(input({ awaiting: [{ id: 'ap', label: 'Criar tarefas' }] }));
    expect(r.waitingOnYou).toEqual([{ kind: 'approval', id: 'ap', title: 'Criar tarefas', at: null }]);
    expect(r.empty).toBe(false);
  });
  it('what was closed last week is passed through as counts and is not invented from anything', () => {
    expect(buildWeeklyReview(input({ closedLastWeek: { tasks: 3, commitments: 1 } })).closedLastWeek).toEqual({ tasks: 3, commitments: 1 });
  });
});

describe('the next action and its stated rule', () => {
  it('an approval waiting on the principal comes first, even over an older overdue item', () => {
    const r = buildWeeklyReview(input({ awaiting: [{ id: 'ap', label: 'x' }], tasks: [task('late', at(-100))] }));
    expect(r.next).toMatchObject({ item: { id: 'ap' }, rule: NEXT_RULES.approval });
  });
  it('without approvals, the item overdue the longest', () => {
    const r = buildWeeklyReview(input({ tasks: [task('a', at(-10)), task('b', at(-90))], meetings: [meet('m', at(1))] }));
    expect(r.next).toMatchObject({ item: { id: 'b' }, rule: NEXT_RULES.overdue });
  });
  it('with nothing overdue, whatever comes first (a meeting can be it)', () => {
    const r = buildWeeklyReview(input({ tasks: [task('t', at(40))], meetings: [meet('m', at(2))] }));
    expect(r.next).toMatchObject({ item: { id: 'm', kind: 'meeting' }, rule: NEXT_RULES.upcoming });
  });
  it('the rule text is part of the result, so what picked it is never hidden', () => {
    const r = buildWeeklyReview(input({ tasks: [task('a', at(-1))] }));
    expect(r.next!.rule).toMatch(/vencido/);
  });
});

describe('day load: a transparent threshold, in the principal timezone', () => {
  it('a day is "busy" at BUSY_DAY dated items and not before; undated and overdue items do not count', () => {
    const tasks = Array.from({ length: BUSY_DAY }, (_, i) => task(`t${i}`, at(24 + i)));
    const full = buildWeeklyReview(input({ tasks, meetings: [] }));
    expect(full.load).toEqual([{ day: dayKey(at(24), TZ), count: BUSY_DAY, busy: true }]);
    const almost = buildWeeklyReview(input({ tasks: tasks.slice(0, BUSY_DAY - 1) }));
    expect(almost.load[0]).toMatchObject({ count: BUSY_DAY - 1, busy: false });
    const noisy = buildWeeklyReview(input({ tasks: [...tasks.slice(0, 2), task('late', at(-30)), task('none', null)] }));
    expect(noisy.load[0]!.count).toBe(2);
  });
  it('days are the principal\'s, not UTC: 23:30 in São Paulo (02:30Z next day) is still the same local day', () => {
    const lateSp = new Date('2026-10-16T02:30:00.000Z'); // 23:30 on the 15th in São Paulo
    const earlySp = new Date('2026-10-16T12:00:00.000Z'); // 09:00 on the 16th in São Paulo
    const r = buildWeeklyReview(input({ tasks: [task('a', lateSp), task('b', earlySp)] }));
    expect(r.load.map((d) => [d.day, d.count])).toEqual([['2026-10-15', 1], ['2026-10-16', 1]]);
    expect(dayKey(lateSp, 'UTC')).toBe('2026-10-16');
  });
  it('days come out in calendar order', () => {
    const r = buildWeeklyReview(input({ tasks: [task('a', at(100)), task('b', at(30)), task('c', at(60))] }));
    expect(r.load.map((d) => d.day)).toEqual([...r.load.map((d) => d.day)].sort());
  });
});
