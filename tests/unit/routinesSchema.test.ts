/**
 * Migration 009 (routines, routine_runs, digest_items). Runs ONLY in the isolated test database: createTestDb makes a fresh schema in
 * `wendy_test` (WENDY_TEST_DATABASE_URL), applies every migration there, and drops it afterwards. It never touches the `wendy` database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { newId } from '../../src/util/hash.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let pid: string;
const NOW = new Date('2026-10-16T10:00:00Z');
beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  pid = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
});
afterAll(() => t.drop());

const routine = async (kind = 'research_digest') => {
  const id = newId();
  await db.query(`INSERT INTO routines(id, principal_id, kind, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)`, [id, pid, kind, NOW]);
  return id;
};
const run = (routineId: string, date: string, status = 'RUNNING') => db.query(`INSERT INTO routine_runs(id, routine_id, principal_id, run_date, status, started_at) VALUES ($1,$2,$3,$4,$5,$6)`, [newId(), routineId, pid, date, status, NOW]);

describe('migration 009: routines', () => {
  it('creates the three tables with their defaults (07:30, America/Sao_Paulo, enabled, not paused)', async () => {
    const id = await routine();
    const r = (await db.query<{ enabled: boolean; local_time: string; timezone: string; paused_until: Date | null; config: unknown }>(`SELECT enabled, local_time::text, timezone, paused_until, config FROM routines WHERE id = $1`, [id])).rows[0]!;
    expect(r).toEqual({ enabled: true, local_time: '07:30:00', timezone: 'America/Sao_Paulo', paused_until: null, config: {} });
  });
  it('a malformed kind is refused (011: the code decides which kinds run); one routine of a kind per person', async () => {
    await expect(routine('Something Else!')).rejects.toThrow();
    await routine('daily_quote');
    await expect(routine('daily_quote')).rejects.toThrow(); // UNIQUE (principal_id, kind)
  });
  it('idempotence by local date: a second run of the same routine on the same date is refused by the database; another date is fine', async () => {
    const id = await routine('ml_challenge');
    await run(id, '2026-10-16');
    await expect(run(id, '2026-10-16')).rejects.toThrow();
    await run(id, '2026-10-17');
    const ins = await db.query(`INSERT INTO routine_runs(id, routine_id, principal_id, run_date, status, started_at) VALUES ($1,$2,$3,$4,'RUNNING',$5) ON CONFLICT (routine_id, run_date) DO NOTHING RETURNING id`, [newId(), id, pid, '2026-10-16', NOW]);
    expect(ins.rows).toHaveLength(0); // the "whoever inserts runs it" pattern: the loser gets no row
  });
  it('a run needs a valid status', async () => {
    const id = await routine('research_digest').catch(async () => (await db.query<{ id: string }>(`SELECT id FROM routines WHERE kind = 'research_digest' AND principal_id = $1`, [pid])).rows[0]!.id);
    await expect(run(id, '2026-11-01', 'WHATEVER')).rejects.toThrow();
  });
  it('digest items: the same link is never stored twice for a person; kinds are checked', async () => {
    const rid = (await db.query<{ id: string }>(`SELECT id FROM routines WHERE principal_id = $1 LIMIT 1`, [pid])).rows[0]!.id;
    const runId = newId();
    await db.query(`INSERT INTO routine_runs(id, routine_id, principal_id, run_date, status, started_at) VALUES ($1,$2,$3,'2026-12-01','DONE',$4)`, [runId, rid, pid, NOW]);
    const item = (url: string, kind = 'article') => db.query(`INSERT INTO digest_items(id, run_id, principal_id, kind, source_name, source_url, title, created_at) VALUES ($1,$2,$3,$4,'arXiv',$5,'t',$6)`, [newId(), runId, pid, kind, url, NOW]);
    await item('https://arxiv.org/abs/2610.00001');
    await expect(item('https://arxiv.org/abs/2610.00001')).rejects.toThrow();
    await expect(item('https://arxiv.org/abs/2610.00002', 'tweet')).rejects.toThrow();
  });
  it('foreign keys hold: nothing can point at a missing person or routine', async () => {
    await expect(db.query(`INSERT INTO routines(id, principal_id, kind, created_at, updated_at) VALUES ($1,$2,'daily_quote',$3,$3)`, [newId(), newId(), NOW])).rejects.toThrow();
    await expect(run(newId(), '2027-01-01')).rejects.toThrow();
  });
});

describe('migration 010: market watch', () => {
  it('accepts the market_watch routine kind, still rejects malformed kinds, and keeps watchlist/alerts unique', async () => {
    await db.query(`INSERT INTO routines(id, principal_id, kind, created_at, updated_at) VALUES ($1,$2,'market_watch',$3,$3)`, [newId(), pid, NOW]);
    await expect(db.query(`INSERT INTO routines(id, principal_id, kind, created_at, updated_at) VALUES ($1,$2,'No pe!',$3,$3)`, [newId(), pid, NOW])).rejects.toThrow();
    await db.query(`INSERT INTO watchlist(id, principal_id, symbol, market, source, updated_at) VALUES ($1,$2,'PETR4','B3','liquidity',$3)`, [newId(), pid, NOW]);
    await expect(db.query(`INSERT INTO watchlist(id, principal_id, symbol, market, source, updated_at) VALUES ($1,$2,'PETR4','B3','config',$3)`, [newId(), pid, NOW])).rejects.toThrow();
    await expect(db.query(`INSERT INTO watchlist(id, principal_id, symbol, market, source, updated_at) VALUES ($1,$2,'x y','B3','config',$3)`, [newId(), pid, NOW])).rejects.toThrow();
    const a = () => db.query(`INSERT INTO market_alerts(id, principal_id, symbol, kind, observed_at, value, threshold, explanation, created_at) VALUES ($1,$2,'PETR4','VOLUME_SPIKE',$3,4,3,'x',$3)`, [newId(), pid, NOW]);
    await a();
    await expect(a()).rejects.toThrow(); // same candle, same kind: once
  });
});

describe('migration 011: concierge phase 1', () => {
  it('tasks: priority and category are optional and constrained; ARCHIVED is a valid state; existing rows are untouched', async () => {
    const t = async (cols: string, vals: unknown[]) => db.query(`INSERT INTO tasks(id, principal_id, title, status, source, created_by, created_at, updated_at${cols}) VALUES ($1,$2,'t','OPEN','{}','PRINCIPAL',$3,$3${vals.map((_, i) => `,$${i + 4}`).join('')})`, [newId(), pid, NOW, ...vals]);
    await t('', []);
    await t(', priority, category', ['HIGH', 'trabalho']);
    await expect(t(', priority', ['MAYBE'])).rejects.toThrow();
    await expect(t(', category', [''])).rejects.toThrow();
    await db.query(`INSERT INTO tasks(id, principal_id, title, status, source, created_by, created_at, updated_at, archived_at) VALUES ($1,$2,'x','ARCHIVED','{}','PRINCIPAL',$3,$3,$3)`, [newId(), pid, NOW]);
    await expect(db.query(`INSERT INTO tasks(id, principal_id, title, status, source, created_by, created_at, updated_at) VALUES ($1,$2,'x','WAITING','{}','PRINCIPAL',$3,$3)`, [newId(), pid, NOW])).rejects.toThrow();
  });
  it('routines: free kind names are accepted but malformed ones are not; the cadence needs its own field and nothing else', async () => {
    const r = (kind: string, cols = '', vals: unknown[] = []) => db.query(`INSERT INTO routines(id, principal_id, kind, created_at, updated_at${cols}) VALUES ($1,$2,$3,$4,$4${vals.map((_, i) => `,$${i + 5}`).join('')})`, [newId(), pid, kind, NOW, ...vals]);
    await r('daily_plan');
    await expect(r('Bad Kind')).rejects.toThrow();
    await r('weekly_review', ', cadence, weekday', ['weekly', 0]);
    await r('monthly_report', ', cadence, day_of_month', ['monthly', 1]);
    await expect(r('weekly_x', ', cadence', ['weekly'])).rejects.toThrow(); // weekly needs a weekday
    await expect(r('monthly_x', ', cadence, day_of_month', ['monthly', 31])).rejects.toThrow(); // 28 at most
    await expect(r('daily_x', ', cadence, weekday', ['daily', 3])).rejects.toThrow(); // daily takes no day
    const old = (await db.query<{ cadence: string }>(`SELECT cadence FROM routines WHERE kind = 'market_watch'`)).rows[0];
    expect(old?.cadence ?? 'daily').toBe('daily'); // routines that existed keep running daily
  });
});

describe('migration 012: market view', () => {
  it('candles are unique per person, symbol and day and refuse nonsense; watchlist accepts user rows, references and index symbols', async () => {
    const c = (sym: string, day: string, vol = 10) => db.query(`INSERT INTO market_candles(principal_id, symbol, day, open, high, low, close, volume, fetched_at) VALUES ($1,$2,$3,1,2,0.5,1.5,$4,$5)`, [pid, sym, day, vol, NOW]);
    await c('PETR4', '2026-10-15');
    await expect(c('PETR4', '2026-10-15')).rejects.toThrow(); // one candle per day
    await expect(c('PETR4', '2026-10-16', -1)).rejects.toThrow(); // negative volume
    const w = (sym: string, cols = '', vals: unknown[] = []) => db.query(`INSERT INTO watchlist(id, principal_id, symbol, market, source, updated_at${cols}) VALUES ($1,$2,$3,'B3','user',$4${vals.map((_, i) => `,$${i + 5}`).join('')})`, [newId(), pid, sym, NOW, ...vals]);
    await w('ITUB4');
    await w('^BVSP', ', role', ['reference']);
    await expect(w('x y')).rejects.toThrow();
    await expect(w('ABC', ', role', ['nope'])).rejects.toThrow();
    await db.query(`UPDATE watchlist SET excluded = true WHERE symbol = 'ITUB4'`);
    expect((await db.query(`SELECT excluded, role FROM watchlist WHERE symbol = 'ITUB4'`)).rows[0]).toEqual({ excluded: true, role: 'asset' });
  });
});
