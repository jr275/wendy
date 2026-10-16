/** The market screen's data: the editable list and the read views. Isolated database; candles are synthetic; no network, no token. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { BrapiError } from '../../src/market/brapi.js';
import { readCandles, storeCandles } from '../../src/market/candles.js';
import type { Candle } from '../../src/market/signals.js';
import { marketAsset, marketOverview } from '../../src/market/views.js';
import { addAsset, MAX_SYMBOLS, removeAsset, WatchlistError } from '../../src/market/watchlist.js';
import { marketWatchHandler } from '../../src/routines/marketWatch.js';
import { runDueRoutines } from '../../src/routines/runner.js';
import { newId } from '../../src/util/hash.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let pid: string;
const NOW = new Date('2026-10-16T21:40:00Z'); // Friday evening in São Paulo
beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  pid = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
});
afterAll(() => t.drop());
beforeEach(async () => {
  await db.query(`DELETE FROM market_alerts; DELETE FROM market_candles; DELETE FROM watchlist; DELETE FROM digest_items; DELETE FROM routine_runs; DELETE FROM routines`);
});

const day = (n: number) => new Date(Date.UTC(2026, 8, 1 + n));
const series = (n: number, from = 100, step = 0.1, volume = 1_000_000): Candle[] => Array.from({ length: n }, (_, i) => { const c = from + i * step; return { at: day(i), open: c, high: c + 1, low: c - 1, close: c, volume }; });
const deps = (over: Record<string, unknown> = {}) => ({ token: () => 'tok-123456789', candles: async () => series(30), ...over });
const watch = (symbol: string, o: { market?: string; source?: string; role?: string; active?: boolean; excluded?: boolean } = {}) => db.query(`INSERT INTO watchlist(id, principal_id, symbol, market, source, role, active, excluded, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [newId(), pid, symbol, o.market ?? 'B3', o.source ?? 'liquidity', o.role ?? 'asset', o.active ?? true, o.excluded ?? false, NOW]);

describe('adding and removing assets', () => {
  it('rejects codes that are not tickers, in any letter case it normalizes, and never touches the network for them', async () => {
    let calls = 0;
    const d = deps({ candles: async () => { calls++; return series(30); } });
    for (const bad of ['', 'PETR4/..', '^BVSP', 'A B', 'TOOLONGCODE', 'petr4?x']) await expect(addAsset(db, pid, bad, NOW, d), bad).rejects.toBeInstanceOf(WatchlistError);
    expect(calls).toBe(0);
    expect(await addAsset(db, pid, ' petr4 ', NOW, d)).toMatchObject({ status: 'added', symbol: 'PETR4', market: 'B3', candles: 30 });
    expect(await addAsset(db, pid, 'aapl', NOW, d)).toMatchObject({ status: 'added', symbol: 'AAPL', market: 'US' });
    expect(calls).toBe(2);
  });
  it('adding checks the asset with ONE request, keeps the history it returned, and a second add changes nothing', async () => {
    let calls = 0;
    const d = deps({ candles: async () => { calls++; return series(40); } });
    await addAsset(db, pid, 'VALE3', NOW, d);
    expect((await readCandles(db, pid, 'VALE3', 100)).length).toBe(40);
    expect(await addAsset(db, pid, 'VALE3', NOW, d)).toMatchObject({ status: 'already' });
    expect(calls).toBe(1);
    expect((await db.query(`SELECT source, active, excluded FROM watchlist WHERE symbol = 'VALE3'`)).rows[0]).toEqual({ source: 'user', active: true, excluded: false });
  });
  it('a code the provider does not know, a failing provider, a missing token or too little history store NOTHING', async () => {
    await expect(addAsset(db, pid, 'ZZZZ9', NOW, deps({ candles: async () => { throw new BrapiError('a brapi respondeu 404'); } }))).rejects.toMatchObject({ status: 422 });
    await expect(addAsset(db, pid, 'ABCD3', NOW, deps({ token: () => null }))).rejects.toMatchObject({ status: 503 });
    await expect(addAsset(db, pid, 'NEWC3', NOW, deps({ candles: async () => series(3) }))).rejects.toMatchObject({ status: 422 });
    expect((await db.query('SELECT count(*)::int n FROM watchlist')).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int n FROM market_candles')).rows[0].n).toBe(0);
  });
  it('the list has a ceiling that protects the monthly request budget', async () => {
    await db.query(`INSERT INTO watchlist(id, principal_id, symbol, market, source, updated_at) SELECT gen_random_uuid(), $1, 'AA' || lpad(g::text, 3, '0'), 'B3', 'liquidity', now() FROM generate_series(1, $2) g`, [pid, MAX_SYMBOLS - 2]);
    await expect(addAsset(db, pid, 'ITUB4', NOW, deps())).rejects.toMatchObject({ status: 409 });
  });
  it('removing is permanent: it survives the weekly refresh, and adding it again restores it', async () => {
    await watch('PETR4');
    await watch('MGLU3');
    expect(await removeAsset(db, pid, 'petr4', NOW)).toEqual({ status: 'removed', symbol: 'PETR4' });
    await db.query(`INSERT INTO routines(id, principal_id, kind, local_time, created_at, updated_at) VALUES ($1,$2,'market_watch','18:30',$3,$3)`, [newId(), pid, NOW]);
    // a refresh that lists PETR4 again among the most relevant: it must stay off
    await runDueRoutines(db, { handlers: { market_watch: marketWatchHandler({ token: () => 'tok-123456789', sleep: async () => {}, config: () => ({ config: { b3Top: 10, us: [] } }), liquid: async () => [{ symbol: 'PETR4', volume: 9 }, { symbol: 'MGLU3', volume: 8 }], candles: async () => series(40) }) } }, NOW);
    expect((await db.query(`SELECT active, excluded FROM watchlist WHERE symbol = 'PETR4'`)).rows[0]).toEqual({ active: false, excluded: true });
    expect((await db.query(`SELECT active FROM watchlist WHERE symbol = 'MGLU3'`)).rows[0].active).toBe(true);
    expect(await addAsset(db, pid, 'PETR4', NOW, deps())).toMatchObject({ status: 'restored' });
    expect((await db.query(`SELECT active, excluded FROM watchlist WHERE symbol = 'PETR4'`)).rows[0]).toEqual({ active: true, excluded: false });
  });
  it('an asset the person added is never switched off by the refresh; unknown and reference symbols cannot be removed', async () => {
    await addAsset(db, pid, 'NVDA', NOW, deps());
    await watch('^BVSP', { source: 'config', role: 'reference' });
    await expect(removeAsset(db, pid, 'NOPE3', NOW)).rejects.toMatchObject({ status: 404 });
    await expect(removeAsset(db, pid, '^BVSP', NOW)).rejects.toMatchObject({ status: 409 });
    await db.query(`INSERT INTO routines(id, principal_id, kind, local_time, created_at, updated_at) VALUES ($1,$2,'market_watch','18:30',$3,$3)`, [newId(), pid, NOW]);
    await runDueRoutines(db, { handlers: { market_watch: marketWatchHandler({ token: () => 'tok-123456789', sleep: async () => {}, config: () => ({ config: { b3Top: 10, us: [] } }), liquid: async () => [], candles: async () => series(40) }) } }, NOW);
    expect((await db.query(`SELECT active FROM watchlist WHERE symbol = 'NVDA'`)).rows[0].active).toBe(true);
  });
  it('the ledger records that the list changed, never which asset', async () => {
    await addAsset(db, pid, 'AMD', NOW, deps());
    await removeAsset(db, pid, 'AMD', NOW);
    const text = JSON.stringify((await db.query(`SELECT payload FROM audit_blocks WHERE event_type = 'WATCHLIST_CHANGED'`)).rows);
    expect(text).toContain('"op"');
    expect(text).not.toContain('AMD');
  });
});

describe('the overview', () => {
  it('shows references, the day\'s biggest movers (liquid assets only), the quota budget and the alerts, all dated', async () => {
    await watch('^BVSP', { market: 'B3', source: 'config', role: 'reference' });
    for (const s of ['UPUP3', 'DOWN3', 'FLAT3', 'THIN3']) await watch(s);
    await watch('GONE3', { active: false, excluded: true });
    const mk = (last: number, prev: number, vol = 1_000_000): Candle[] => [{ at: day(0), open: prev, high: prev + 1, low: prev - 1, close: prev, volume: vol }, { at: day(1), open: prev, high: last + 1, low: last - 1, close: last, volume: vol }];
    await storeCandles(db, pid, '^BVSP', mk(205, 200), NOW);
    await storeCandles(db, pid, 'UPUP3', mk(110, 100), NOW); // +10%
    await storeCandles(db, pid, 'DOWN3', mk(90, 100), NOW); // −10%
    await storeCandles(db, pid, 'FLAT3', mk(100.5, 100), NOW);
    await storeCandles(db, pid, 'THIN3', mk(150, 100, 100), NOW); // +50% but a few hundred in traded value: ignored as noise
    await db.query(`INSERT INTO market_alerts(id, principal_id, symbol, kind, observed_at, value, threshold, explanation, created_at) VALUES ($1,$2,'UPUP3','VOLUME_SPIKE','2026-10-02T00:00:00Z',4,3,'UPUP3: volume 4×',now())`, [newId(), pid]);
    const o = await marketOverview(db, pid);
    expect(o.references).toMatchObject([{ symbol: '^BVSP', lastClose: 205, changePct: 2.5, asOf: '2026-09-02' }]);
    expect(o.gainers.map((q) => q.symbol)).toEqual(['UPUP3', 'FLAT3']); // only real rises
    expect(o.losers.map((q) => q.symbol)).toEqual(['DOWN3']); // only real falls: a rise never shows up as a "loser" just because few assets have data
    expect(o.gainers.map((q) => q.symbol)).not.toContain('THIN3');
    expect(o.counts).toEqual({ watchedAssets: 4, excluded: 1 });
    expect(o.budget).toMatchObject({ perSweep: 5, perMonthEstimate: 5 * 22 + 5, monthlyQuota: 15000 });
    expect(o.alerts).toEqual([expect.objectContaining({ symbol: 'UPUP3', kind: 'VOLUME_SPIKE', day: '2026-10-02', value: 4, threshold: 3 })]);
    expect(o.asOf).toBe('2026-09-02');
    expect(o.note).toMatch(/atraso/);
    expect(o.watchlist.find((w) => w.symbol === 'GONE3')).toMatchObject({ active: false, excluded: true });
  });
  it('an empty market says so with nothing invented, and another person sees nothing', async () => {
    const o = await marketOverview(db, pid);
    expect(o).toMatchObject({ references: [], gainers: [], losers: [], alerts: [], asOf: null, routine: null, lastRun: null });
    const other = await createPrincipal(db, { displayName: 'Q', primaryEmail: 'q@example.test', timezone: 'UTC', locale: 'pt-BR' });
    await watch('MINE3');
    expect((await marketOverview(db, other)).watchlist).toEqual([]);
  });
});

describe('one asset', () => {
  it('returns the candles oldest first with the figures computed from them, and nothing for an unknown symbol', async () => {
    await watch('PETR4');
    await storeCandles(db, pid, 'PETR4', series(5, 100, 1), NOW);
    const a = (await marketAsset(db, pid, 'petr4'))!;
    expect(a.candles.map((c) => c.close)).toEqual([100, 101, 102, 103, 104]);
    expect(a.stats).toEqual({ lastClose: 104, changePct: 0.97, high: 105, low: 99, days: 5, asOf: '2026-09-05' });
    expect(a).toMatchObject({ symbol: 'PETR4', market: 'B3', role: 'asset', active: true });
    expect(await marketAsset(db, pid, 'NOPE3')).toBeNull();
  });
  it('storing the same days again updates them instead of duplicating, and old days are dropped', async () => {
    await storeCandles(db, pid, 'X', series(3, 10, 1), NOW);
    await storeCandles(db, pid, 'X', series(3, 20, 1), NOW);
    expect((await readCandles(db, pid, 'X')).map((c) => c.close)).toEqual([20, 21, 22]);
    await storeCandles(db, pid, 'X', [{ at: new Date('2025-01-01T00:00:00Z'), open: 1, high: 2, low: 1, close: 1, volume: 1 }], NOW);
    expect((await readCandles(db, pid, 'X', 500)).some((c) => c.day === '2025-01-01')).toBe(false); // older than the retention window
  });
});
