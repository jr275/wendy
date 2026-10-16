/**
 * Scheduling logic (pure) and the runner (isolated test database only: createTestDb → fresh schema in wendy_test, dropped afterwards).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { runDueRoutines, type NewDigestItem, type RoutineHandler } from '../../src/routines/runner.js';
import { decide, localParts, periodStart, timeToMinutes, type RoutineRow, type RunRow } from '../../src/routines/schedule.js';
import { newId } from '../../src/util/hash.js';
import { createTestDb } from '../helpers/db.js';

const base: RoutineRow = { id: 'r', principal_id: 'p', kind: 'research_digest', enabled: true, local_time: '07:30:00', timezone: 'America/Sao_Paulo', paused_until: null };
// 10:00Z = 07:00 in São Paulo (UTC-3); 11:00Z = 08:00
const EARLY = new Date('2026-10-16T10:00:00Z');
const LATE = new Date('2026-10-16T11:00:00Z');
const run = (o: Partial<RunRow> = {}): RunRow => ({ status: 'RUNNING', attempts: 1, lease_until: null, started_at: LATE, finished_at: null, ...o });

describe('schedule (pure)', () => {
  it('uses the LOCAL day, not UTC: 23:30 in São Paulo is already tomorrow in UTC', () => {
    expect(localParts(new Date('2026-10-17T02:30:00Z'), 'America/Sao_Paulo')).toEqual({ date: '2026-10-16', minutes: 23 * 60 + 30 });
    expect(localParts(new Date('2026-10-16T02:59:00Z'), 'America/Sao_Paulo').date).toBe('2026-10-15');
  });
  it('parses times and rejects nonsense', () => {
    expect(timeToMinutes('07:30:00')).toBe(450);
    expect(timeToMinutes('7:05')).toBe(425);
    for (const bad of ['24:00', '07:60', 'abc', '']) expect(timeToMinutes(bad)).toBeNull();
  });
  it('is not due before the local time, and is due after it', () => {
    expect(decide(base, EARLY, null)).toEqual({ action: 'skip', reason: 'too_early' });
    expect(decide(base, LATE, null)).toEqual({ action: 'claim' });
  });
  it('respects disabled, paused and a malformed time', () => {
    expect(decide({ ...base, enabled: false }, LATE, null)).toEqual({ action: 'skip', reason: 'disabled' });
    expect(decide({ ...base, paused_until: new Date('2026-10-20T00:00:00Z') }, LATE, null)).toEqual({ action: 'skip', reason: 'paused' });
    expect(decide({ ...base, paused_until: new Date('2026-10-01T00:00:00Z') }, LATE, null)).toEqual({ action: 'claim' });
    expect(decide({ ...base, local_time: '99:99' }, LATE, null)).toEqual({ action: 'skip', reason: 'bad_time' });
  });
  it('never runs twice in a day; recovers expired leases; backs off after failure; gives up after 3 attempts', () => {
    expect(decide(base, LATE, run({ status: 'DONE' }))).toEqual({ action: 'skip', reason: 'done' });
    expect(decide(base, LATE, run({ lease_until: new Date(LATE.getTime() + 60_000) }))).toEqual({ action: 'skip', reason: 'running' });
    expect(decide(base, LATE, run({ lease_until: new Date(LATE.getTime() - 1) }))).toEqual({ action: 'reclaim' });
    expect(decide(base, LATE, run({ status: 'FAILED', finished_at: new Date(LATE.getTime() - 60_000) }))).toEqual({ action: 'skip', reason: 'retry_later' });
    expect(decide(base, LATE, run({ status: 'FAILED', finished_at: new Date(LATE.getTime() - 16 * 60_000) }))).toEqual({ action: 'reclaim' });
    expect(decide(base, LATE, run({ status: 'FAILED', attempts: 3, finished_at: new Date(LATE.getTime() - 3600_000) }))).toEqual({ action: 'skip', reason: 'gave_up' });
  });
});

describe('runner (isolated test database)', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let pid: string;
  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    pid = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
  });
  afterAll(() => t.drop());

  const item = (n: number): NewDigestItem => ({ kind: 'article', sourceName: 'Fonte', sourceUrl: `https://example.test/a${n}`, title: `T${n}`, publishedAt: null, summary: 's', why: 'w', score: n, evidence: {} });
  const mk = async (kind = 'research_digest') => {
    await db.query(`DELETE FROM digest_items; DELETE FROM routine_runs; DELETE FROM routines`);
    const id = newId();
    await db.query(`INSERT INTO routines(id, principal_id, kind, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)`, [id, pid, kind, LATE]);
    return id;
  };
  const counting = (items: NewDigestItem[]) => { const h = { calls: 0 }; const fn: RoutineHandler = async () => { h.calls++; return { items }; }; return { h, fn }; };

  it('runs once per local day: a second tick, or a second worker at the same time, does nothing', async () => {
    await mk();
    const { h, fn } = counting([item(1), item(2)]);
    const [a, b] = await Promise.all([runDueRoutines(db, { handlers: { research_digest: fn } }, LATE), runDueRoutines(db, { handlers: { research_digest: fn } }, LATE)]);
    expect(h.calls).toBe(1);
    expect([...a, ...b].filter((r) => r.outcome === 'done')).toHaveLength(1);
    const again = await runDueRoutines(db, { handlers: { research_digest: fn } }, new Date(LATE.getTime() + 3600_000));
    expect(again[0]).toMatchObject({ outcome: 'skipped', detail: 'done' });
    expect(h.calls).toBe(1);
    expect((await db.query(`SELECT 1 FROM digest_items`)).rowCount).toBe(2);
  });
  it('does nothing before the time, and for kinds without a handler', async () => {
    await mk();
    const { h, fn } = counting([item(1)]);
    expect((await runDueRoutines(db, { handlers: { research_digest: fn } }, EARLY))[0]).toMatchObject({ outcome: 'skipped', detail: 'too_early' });
    expect(await runDueRoutines(db, { handlers: {} }, LATE)).toEqual([]);
    expect(h.calls).toBe(0);
    expect((await db.query(`SELECT 1 FROM routine_runs`)).rowCount).toBe(0);
  });
  it('a failure is recorded with secrets masked, stores nothing, and is retried later the same day (then not before the pause)', async () => {
    const id = await mk();
    let n = 0;
    const fn: RoutineHandler = async () => { n++; if (n === 1) throw new Error('falhou com AIzaSyA1234567890abcdefghijklmnopqrstuvwx'); return { items: [item(7)] }; };
    const r1 = await runDueRoutines(db, { handlers: { research_digest: fn } }, LATE);
    expect(r1[0]).toMatchObject({ outcome: 'failed' });
    const row = (await db.query<{ status: string; error: string; attempts: number }>(`SELECT status, error, attempts FROM routine_runs WHERE routine_id = $1`, [id])).rows[0]!;
    expect(row.status).toBe('FAILED');
    expect(row.error).not.toContain('AIzaSy');
    expect((await db.query(`SELECT 1 FROM digest_items`)).rowCount).toBe(0);
    expect((await runDueRoutines(db, { handlers: { research_digest: fn } }, new Date(LATE.getTime() + 60_000)))[0]).toMatchObject({ outcome: 'skipped', detail: 'retry_later' });
    const r2 = await runDueRoutines(db, { handlers: { research_digest: fn } }, new Date(LATE.getTime() + 16 * 60_000));
    expect(r2[0]).toMatchObject({ outcome: 'done', stored: 1 });
    expect((await db.query<{ attempts: number }>(`SELECT attempts FROM routine_runs WHERE routine_id = $1`, [id])).rows[0]!.attempts).toBe(2);
  });
  it('a run that died is recovered after its lease expires, and an unexpired lease is respected', async () => {
    const id = await mk();
    await db.query(`INSERT INTO routine_runs(id, routine_id, principal_id, run_date, status, attempts, lease_until, started_at) VALUES ($1,$2,$3,'2026-10-16','RUNNING',1,$4,$5)`, [newId(), id, pid, new Date(LATE.getTime() + 5 * 60_000), LATE]);
    const { h, fn } = counting([item(3)]);
    expect((await runDueRoutines(db, { handlers: { research_digest: fn } }, LATE))[0]).toMatchObject({ outcome: 'skipped', detail: 'running' });
    expect((await runDueRoutines(db, { handlers: { research_digest: fn } }, new Date(LATE.getTime() + 11 * 60_000)))[0]).toMatchObject({ outcome: 'done' });
    expect(h.calls).toBe(1);
  });
  it('never stores the same link twice, across days', async () => {
    await mk();
    const { fn } = counting([item(1), item(1)]);
    const r = await runDueRoutines(db, { handlers: { research_digest: fn } }, LATE);
    expect(r[0]).toMatchObject({ outcome: 'done', stored: 1 });
    const next = await runDueRoutines(db, { handlers: { research_digest: fn } }, new Date(LATE.getTime() + 86_400_000));
    expect(next[0]).toMatchObject({ outcome: 'done', stored: 0 });
  });
  it('"force" ignores the time of day but not the one-run-per-day rule; the ledger records counts only', async () => {
    await mk();
    const { h, fn } = counting([item(5)]);
    expect((await runDueRoutines(db, { handlers: { research_digest: fn } }, EARLY, { force: true }))[0]).toMatchObject({ outcome: 'done', stored: 1 });
    expect((await runDueRoutines(db, { handlers: { research_digest: fn } }, EARLY, { force: true }))[0]).toMatchObject({ outcome: 'skipped', detail: 'done' });
    expect(h.calls).toBe(1);
    const ev = (await db.query<{ event_type: string; payload: Record<string, unknown> }>(`SELECT event_type, payload FROM audit_blocks WHERE event_type LIKE 'ROUTINE_RUN_%' ORDER BY seq`)).rows;
    expect(ev.map((e) => e.event_type)).toContain('ROUTINE_RUN_FINISHED');
    expect(JSON.stringify(ev)).not.toContain('example.test');
  });
});

describe('runner: finished_at is when the run ENDED', () => {
  it('uses the injected clock for the end of the run, so the stored duration is real (it used to equal the start)', async () => {
    const t2 = await createTestDb();
    try {
      const p = await createPrincipal(t2.db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
      await t2.db.query(`INSERT INTO routines(id, principal_id, kind, created_at, updated_at) VALUES ($1,$2,'research_digest',$3,$3)`, [newId(), p, LATE]);
      const end = new Date(LATE.getTime() + 95_000);
      await runDueRoutines(t2.db, { handlers: { research_digest: async () => ({ items: [] }) }, clock: () => end }, LATE);
      const r = (await t2.db.query<{ s: number }>(`SELECT extract(epoch from (finished_at - started_at))::int AS s FROM routine_runs`)).rows[0]!;
      expect(r.s).toBe(95);
    } finally {
      await t2.drop();
    }
  });
});

describe('cadence (pure): the period a moment belongs to, in America/Sao_Paulo', () => {
  const weekly = { ...base, cadence: 'weekly' as const, weekday: 0, local_time: '18:00:00' }; // Sundays 18:00
  const monthly = { ...base, cadence: 'monthly' as const, day_of_month: 1, local_time: '09:00:00' };
  it('daily is the local day; weekly is the most recent chosen weekday; monthly the most recent chosen day', () => {
    expect(periodStart(base, new Date('2026-10-16T11:00:00Z'))).toBe('2026-10-16');
    expect(periodStart(weekly, new Date('2026-10-14T15:00:00Z'))).toBe('2026-10-11'); // Wednesday → the Sunday before
    expect(periodStart(weekly, new Date('2026-10-11T22:00:00Z'))).toBe('2026-10-11'); // Sunday itself
    expect(periodStart(monthly, new Date('2026-10-16T11:00:00Z'))).toBe('2026-10-01');
    expect(periodStart({ ...monthly, day_of_month: 15 }, new Date('2026-10-10T11:00:00Z'))).toBe('2026-09-15'); // before the 15th → last month's
    expect(periodStart({ ...monthly, day_of_month: 20 }, new Date('2027-01-05T15:00:00Z'))).toBe('2026-12-20'); // across the year
  });
  it('uses the LOCAL date: 23:30 on Saturday in São Paulo is already Sunday in UTC but still the previous period', () => {
    expect(periodStart(weekly, new Date('2026-10-18T02:30:00Z'))).toBe('2026-10-11'); // Sat 23:30 local
  });
  it('the time of day only gates the first day of the period; later days of it are a recovery (due at once)', () => {
    expect(decide(weekly, new Date('2026-10-11T19:00:00Z'), null)).toEqual({ action: 'skip', reason: 'too_early' }); // Sunday 16:00 local
    expect(decide(weekly, new Date('2026-10-11T22:00:00Z'), null)).toEqual({ action: 'claim' }); // Sunday 19:00 local
    expect(decide(weekly, new Date('2026-10-14T08:00:00Z'), null)).toEqual({ action: 'claim' }); // Wednesday: Sunday's run was missed
    expect(decide(weekly, new Date('2026-10-14T08:00:00Z'), run({ status: 'DONE' }))).toEqual({ action: 'skip', reason: 'done' });
  });
});

describe('cadence (runner, isolated database)', () => {
  let t3: Awaited<ReturnType<typeof createTestDb>>;
  let pid3: string;
  beforeAll(async () => {
    t3 = await createTestDb();
    pid3 = await createPrincipal(t3.db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
    await t3.db.query(`INSERT INTO routines(id, principal_id, kind, local_time, cadence, weekday, created_at, updated_at) VALUES ($1,$2,'weekly_review','18:00','weekly',0,$3,$3)`, [newId(), pid3, LATE]);
  });
  afterAll(() => t3.drop());
  it('a weekly routine runs once per week, recovers a missed Sunday, and runs again the next week', async () => {
    let calls = 0;
    const h = { handlers: { weekly_review: (async () => { calls++; return { items: [] }; }) as RoutineHandler } };
    const wed = new Date('2026-10-14T15:00:00Z'); // Wednesday: the Sunday run (10-11) was missed
    expect((await runDueRoutines(t3.db, h, wed))[0]).toMatchObject({ outcome: 'done', runDate: '2026-10-11' });
    expect((await runDueRoutines(t3.db, h, new Date('2026-10-15T15:00:00Z')))[0]).toMatchObject({ outcome: 'skipped', detail: 'done' });
    expect(calls).toBe(1);
    expect((await runDueRoutines(t3.db, h, new Date('2026-10-18T22:00:00Z')))[0]).toMatchObject({ outcome: 'done', runDate: '2026-10-18' }); // next Sunday 19:00 local
    expect(calls).toBe(2);
  });
});
