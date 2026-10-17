/**
 * Smart agenda analysis (src/agenda/analysis.ts). Pure: no database, no clock. Times are written as local wall-clock in America/Sao_Paulo (UTC-3).
 * What is proven: conflicts and their overlap, runs with no break, overloaded days (overlap not counted twice), focus windows that avoid meetings and the
 * past, no focus on a day off, meetings kept on their LOCAL day, layered reminders only in the future, and that nothing here decides anything.
 */
import { describe, expect, it } from 'vitest';
import { analyzeAgenda, localInstant, type AgendaMeeting } from '../../src/agenda/analysis.js';

const TZ = 'America/Sao_Paulo';
const L = (day: string, hhmm: string) => localInstant(day, hhmm, TZ);
const MON = '2026-10-19'; // a Monday
const NOW = L(MON, '08:00');
let n = 0;
const mt = (day: string, a: string, b: string, title = `Reunião ${++n}`): AgendaMeeting => ({ id: `m${n}-${day}-${a}`, title, starts_at: L(day, a), ends_at: L(day, b) });
const run = (meetings: AgendaMeeting[], extra: Partial<Parameters<typeof analyzeAgenda>[0]> = {}) => analyzeAgenda({ now: NOW, meetings, days: 1, ...extra });
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

describe('localInstant', () => {
  it('turns a local wall-clock time into the real instant', () => {
    expect(L('2026-10-19', '09:00').toISOString()).toBe('2026-10-19T12:00:00.000Z');
    expect(localInstant('2026-07-01', '09:00', 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z'); // summer time
    expect(localInstant('2026-12-01', '09:00', 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z'); // winter time
  });
});

describe('analyzeAgenda: conflicts, breaks, load', () => {
  it('finds a conflict with its overlap, and counts the overlap once in the day\'s meeting time', () => {
    const d = run([mt(MON, '10:00', '11:00', 'A'), mt(MON, '10:30', '11:30', 'B')]).days[0]!;
    expect(d.conflicts).toHaveLength(1);
    expect(d.conflicts[0]).toMatchObject({ a: { title: 'A' }, b: { title: 'B' }, overlapMinutes: 30 });
    expect(d.meetingMinutes).toBe(90);
  });
  it('flags a run of back-to-back meetings that adds up to 3 h or more, and not a shorter run or one with a real break', () => {
    const long = run([mt(MON, '09:00', '10:00'), mt(MON, '10:00', '11:00'), mt(MON, '11:05', '12:30')]).days[0]!;
    expect(long.noBreak).toHaveLength(1);
    expect(long.noBreak[0]).toMatchObject({ count: 3, totalMinutes: 210 });
    expect(run([mt(MON, '09:00', '10:00'), mt(MON, '10:00', '11:00')]).days[0]!.noBreak).toEqual([]); // 2 h: under the limit
    expect(run([mt(MON, '09:00', '10:30'), mt(MON, '11:00', '13:00')]).days[0]!.noBreak).toEqual([]); // 30 min between them
  });
  it('flags an overloaded day (more than 6 h of meetings) and not a full but allowed one', () => {
    const five = ['09:00', '10:30', '12:00', '13:30', '15:00'].map((s, i) => mt(MON, s, ['10:30', '12:00', '13:30', '15:00', '16:30'][i]!));
    expect(run(five).days[0]!.overloaded).toEqual({ minutes: 450, limit: 360 });
    expect(run(five.slice(0, 4)).days[0]!.overloaded).toBeNull(); // 360 is the limit, not over it
  });
  it('boundaries: meetings that only touch are not a conflict; a gap of exactly 10 min is a break; a run of exactly 3 h is flagged', () => {
    expect(run([mt(MON, '10:00', '11:00'), mt(MON, '11:00', '12:00')]).days[0]!.conflicts).toEqual([]); // 11:00 ends, 11:00 starts
    expect(run([mt(MON, '10:00', '11:00'), mt(MON, '10:59', '12:00')]).days[0]!.conflicts[0]!.overlapMinutes).toBe(1);
    // gaps of exactly 10 min: not back to back, so one long day of meetings is not "no break"
    expect(run([mt(MON, '09:00', '10:00'), mt(MON, '10:10', '11:10'), mt(MON, '11:20', '12:20')]).days[0]!.noBreak).toEqual([]);
    // a gap of 9 min is back to back
    expect(run([mt(MON, '09:00', '10:00'), mt(MON, '10:09', '11:09'), mt(MON, '11:18', '12:18')]).days[0]!.noBreak).toHaveLength(1);
    // exactly 180 min is the limit and counts
    expect(run([mt(MON, '09:00', '10:30'), mt(MON, '10:30', '12:00')]).days[0]!.noBreak[0]!.totalMinutes).toBe(180);
    expect(run([mt(MON, '09:00', '10:30'), mt(MON, '10:30', '11:59')]).days[0]!.noBreak).toEqual([]); // 179
  });
  it('ignores a meeting that ends before it starts', () => {
    expect(run([{ id: 'x', title: 'Quebrada', starts_at: L(MON, '11:00'), ends_at: L(MON, '10:00') }]).days[0]!.meetings).toEqual([]);
  });
  it('keeps a late-evening meeting on its LOCAL day even though it is the next day in UTC', () => {
    const late = mt(MON, '23:30', '23:59', 'Tarde da noite'); // 02:30Z of the 20th
    expect(late.starts_at.toISOString()).toBe('2026-10-20T02:30:00.000Z');
    const r = analyzeAgenda({ now: NOW, meetings: [late], days: 2 });
    expect(r.days[0]!.meetings.map((m) => m.title)).toEqual(['Tarde da noite']);
    expect(r.days[1]!.meetings).toEqual([]);
  });
});

describe('analyzeAgenda: focus blocks', () => {
  it('offers the start of a free working day as one block, capped at 3 h', () => {
    const f = run([]).days[0]!.focus;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ minutes: 180 });
    expect([hhmm(f[0]!.start), hhmm(f[0]!.end)]).toEqual(['09:00', '12:00']);
  });
  it('does not offer the past: today the block starts at the next quarter hour', () => {
    const f = run([], { now: L(MON, '10:20') }).days[0]!.focus;
    expect(hhmm(f[0]!.start)).toBe('10:30');
  });
  it('avoids meetings and offers the window that is left', () => {
    const f = run([mt(MON, '09:00', '12:00')]).days[0]!.focus;
    expect([hhmm(f[0]!.start), hhmm(f[0]!.end)]).toEqual(['12:00', '15:00']);
  });
  it('offers nothing when every gap is shorter than 90 min', () => {
    expect(run([mt(MON, '09:00', '11:00'), mt(MON, '12:00', '14:00'), mt(MON, '15:00', '18:00')]).days[0]!.focus).toEqual([]);
  });
  it('offers at most two blocks, in time order', () => {
    const f = run([mt(MON, '10:00', '10:30'), mt(MON, '13:00', '13:30'), mt(MON, '16:00', '16:30')]).days[0]!.focus;
    expect(f.length).toBeLessThanOrEqual(2);
    expect(f.map((x) => x.start)).toEqual([...f.map((x) => x.start)].sort());
  });
  it('offers nothing on a day off, but still reports conflicts there', () => {
    const SAT = '2026-10-24';
    const r = analyzeAgenda({ now: NOW, days: 6, meetings: [mt(SAT, '10:00', '11:00'), mt(SAT, '10:30', '11:30')] });
    const sat = r.days.find((d) => d.day === SAT)!;
    expect(sat.workingDay).toBe(false);
    expect(sat.focus).toEqual([]);
    expect(sat.conflicts).toHaveLength(1);
  });
});

describe('analyzeAgenda: reminders and honesty', () => {
  it('layers reminders only into the future: a meeting in 3 days gets both, one in 30 minutes gets none', () => {
    const far = mt('2026-10-22', '15:00', '16:00', 'Distante');
    const near = { id: 'near', title: 'Já', starts_at: new Date(NOW.getTime() + 30 * 60_000), ends_at: new Date(NOW.getTime() + 90 * 60_000) };
    const r = analyzeAgenda({ now: NOW, days: 5, meetings: [far, near] });
    expect(r.reminders.filter((x) => x.meetingId === far.id).map((x) => x.label)).toEqual(['1 dia antes', '1 hora antes']);
    expect(r.reminders.filter((x) => x.meetingId === 'near')).toEqual([]);
    expect(r.reminders.map((x) => x.at)).toEqual([...r.reminders.map((x) => x.at)].sort());
  });
  it('says plainly that the departure time is not estimated, and that nothing is decided or written', () => {
    const r = run([]);
    expect(r.departure).toMatch(/não é estimado/);
    expect(r.rules.join(' ')).toMatch(/Nada é aceito, recusado, remarcado ou cancelado/);
    expect(r.rules.join(' ')).toMatch(/nada é gravado na agenda do Google/);
  });
  it('is deterministic: the same input gives the same answer', () => {
    const ms = [mt(MON, '09:00', '10:00'), mt(MON, '09:30', '10:30'), mt(MON, '14:00', '15:00')];
    expect(JSON.stringify(run(ms))).toBe(JSON.stringify(run([...ms].reverse())));
  });
  it('the summary adds up what the days say', () => {
    const r = run([mt(MON, '10:00', '11:00'), mt(MON, '10:30', '11:30')]);
    expect(r.summary).toMatchObject({ meetings: 2, conflicts: 1, overloadedDays: 0, noBreakRuns: 0 });
  });
});
