/** The market_watch routine with a fake brapi, in the isolated test database. No network, no token, no model. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { BrapiError } from '../../src/market/brapi.js';
import { DEFAULT_CONFIG, loadMarketConfig } from '../../src/market/config.js';
import type { Candle } from '../../src/market/signals.js';
import { marketAlertsFor } from '../../src/routines/digestService.js';
import { marketWatchHandler, MAX_SYMBOLS, type MarketDeps } from '../../src/routines/marketWatch.js';
import { runDueRoutines } from '../../src/routines/runner.js';
import { newId } from '../../src/util/hash.js';
import { createTestDb } from '../helpers/db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let pid: string;
// A Friday 18:40 in São Paulo (21:40Z); the candles end that day.
const FRI = new Date('2026-10-16T21:40:00Z');
const SAT = new Date('2026-10-17T21:40:00Z');
beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  pid = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
});
afterAll(() => t.drop());

const day = (n: number) => new Date(Date.UTC(2026, 7, 20 + n));
const calm = (n: number): Candle[] => Array.from({ length: n }, (_, i) => { const c = 100 + ((i % 5) - 2) * 0.25; return { at: day(i), open: c, high: c + 1, low: c - 1, close: c, volume: 1_000_000 + (i % 3) * 10_000 }; });
const spiky = (): Candle[] => [...calm(40), { at: new Date('2026-10-16T00:00:00Z'), open: 100, high: 112, low: 99, close: 110, volume: 5_000_000 }];
const base = (o: Partial<MarketDeps> = {}): MarketDeps => ({ token: () => 'tok-123456789', sleep: async () => {}, config: () => ({ config: { b3Top: 10, us: ['AAPL', 'MSFT'] } }), liquid: async () => [{ symbol: 'PETR4', volume: 9 }, { symbol: 'VALE3', volume: 8 }], candles: async (s) => (s === 'PETR4' ? spiky() : calm(40)), ...o });
const reset = async () => {
  await db.query(`DELETE FROM market_alerts; DELETE FROM watchlist; DELETE FROM digest_items; DELETE FROM routine_runs; DELETE FROM routines`);
  await db.query(`INSERT INTO routines(id, principal_id, kind, local_time, created_at, updated_at) VALUES ($1,$2,'market_watch','18:30',$3,$3)`, [newId(), pid, FRI]);
};
const run = (d: MarketDeps, now = FRI) => runDueRoutines(db, { handlers: { market_watch: marketWatchHandler(d) } }, now);

describe('market_watch routine', () => {
  it('builds the watchlist (liquid B3 + configured US), checks each asset, and records only the unusual one with its numbers', async () => {
    await reset();
    const r = await run(base());
    expect(r[0]).toMatchObject({ outcome: 'done' });
    expect(r[0]!.detail).toBe('4 ativos verificados, 3 observações novas');
    const w = (await db.query<{ symbol: string; market: string }>(`SELECT symbol, market FROM watchlist WHERE active AND role = 'asset' ORDER BY symbol`)).rows;
    expect((await db.query<{ symbol: string }>(`SELECT symbol FROM watchlist WHERE role = 'reference'`)).rows.map((r) => r.symbol).sort()).toEqual(['QQQ', '^BVSP']);
    // the history is kept for every asset and every reference, so the person can see it
    expect((await db.query<{ symbol: string }>(`SELECT DISTINCT symbol FROM market_candles`)).rows.map((r) => r.symbol).sort()).toEqual(['AAPL', 'MSFT', 'PETR4', 'QQQ', 'VALE3', '^BVSP']);
    expect(w).toEqual([{ symbol: 'AAPL', market: 'US' }, { symbol: 'MSFT', market: 'US' }, { symbol: 'PETR4', market: 'B3' }, { symbol: 'VALE3', market: 'B3' }]);
    const a = (await db.query<{ symbol: string; kind: string; explanation: string }>(`SELECT symbol, kind, explanation FROM market_alerts ORDER BY kind`)).rows;
    expect(a.every((x) => x.symbol === 'PETR4')).toBe(true); // the reference series never raise alerts
    expect(a.map((x) => x.kind)).toEqual(['MOVE_OUTLIER', 'RANGE_EXPANSION', 'VOLUME_SPIKE']);
    expect(a[0]!.explanation).toMatch(/não uma recomendação/);
  });
  it('does nothing on a weekend, and says so', async () => {
    await reset();
    let called = 0;
    const r = await run(base({ candles: async () => { called++; return calm(40); } }), SAT);
    expect(r[0]).toMatchObject({ outcome: 'done', detail: 'Fim de semana: sem pregão.' });
    expect(called).toBe(0);
  });
  it('without a token it fails clearly and calls nothing', async () => {
    await reset();
    let called = 0;
    const r = await run(base({ token: () => null, candles: async () => { called++; return calm(40); }, liquid: async () => { called++; return []; } }));
    expect(r[0]).toMatchObject({ outcome: 'failed' });
    expect(r[0]!.detail).toMatch(/sem token/);
    expect(called).toBe(0);
  });
  it('a refused token stops the sweep at once (no point asking again); one failing asset does not stop the others', async () => {
    await reset();
    let calls = 0;
    const refused = await run(base({ candles: async () => { calls++; throw new BrapiError('a brapi recusou o token'); } }));
    expect(refused[0]).toMatchObject({ outcome: 'failed' });
    expect(calls).toBe(1);
    await reset();
    const partial = await run(base({ candles: async (s) => { if (s === 'VALE3') throw new BrapiError('a brapi respondeu 500'); return calm(40); } }));
    expect(partial[0]).toMatchObject({ outcome: 'done', detail: '3 ativos verificados, 0 observações novas, 1 sem resposta' });
  });
  it('a rate-limit answer waits and retries once, then continues', async () => {
    await reset();
    const waits: number[] = [];
    let first = true;
    const r = await run(base({ rateLimitWaitMs: 123, sleep: async (ms) => { if (ms === 123) waits.push(ms); }, candles: async (s) => { if (s === 'PETR4' && first) { first = false; throw new BrapiError('a brapi limitou as consultas'); } return calm(40); } }));
    expect(waits).toEqual([123]);
    expect(r[0]!.detail).toBe('4 ativos verificados, 0 observações novas');
  });
  it('the same candle never alerts twice, and the weekly liquidity refresh is skipped while the list is fresh', async () => {
    await reset();
    await run(base());
    let listed = 0;
    const next = new Date(FRI.getTime() + 86_400_000 * 3); // Monday 18:40 local: a new run day, the same candles
    const r = await run(base({ liquid: async () => { listed++; return []; } }), next);
    expect(r[0]).toMatchObject({ outcome: 'done' });
    expect(listed).toBe(0);
    expect((await db.query(`SELECT 1 FROM market_alerts`)).rowCount).toBe(3);
  });
  it('is capped so it cannot burn the monthly request budget', async () => {
    await reset();
    const many = Array.from({ length: MAX_SYMBOLS + 50 }, (_, i) => ({ symbol: `AB${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}${(i % 9) + 1}`, volume: 1000 - i }));
    let calls = 0;
    const uniq = [...new Map(many.map((m) => [m.symbol, m])).values()];
    await run(base({ liquid: async () => uniq, config: () => ({ config: { b3Top: 500, us: [] } }), candles: async () => { calls++; return calm(40); } }));
    expect(calls).toBeLessThanOrEqual(MAX_SYMBOLS);
  });
});

describe('what the person sees', () => {
  it('shows the strongest cases first (more kinds at once, then intensity), capped, and says how many there were', async () => {
    await reset();
    const ins = (sym: string, kind: string, value: number) => db.query(`INSERT INTO market_alerts(id, principal_id, symbol, kind, observed_at, value, threshold, explanation, created_at) VALUES ($1,$2,$3,$4,$5,$6,3,'x',now())`, [newId(), pid, sym, kind, new Date('2026-10-15T00:00:00Z'), value]);
    await ins('AAAA3', 'VOLUME_SPIKE', 9); // one kind, very strong
    await ins('BBBB3', 'VOLUME_SPIKE', 4);
    await ins('BBBB3', 'MOVE_OUTLIER', 4); // two kinds: first
    await ins('CCCC3', 'VOLUME_SPIKE', 3.1);
    const v = await marketAlertsFor(db, pid, 7, 2);
    expect(v.symbolsWithAlerts).toBe(3);
    expect([...new Set(v.alerts.map((a) => a.symbol))]).toEqual(['BBBB3', 'AAAA3']);
    expect(v.routine).toMatchObject({ localTime: '18:30' });
  });
});

describe('market config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
  const f = path.join(dir, 'c.json');
  it('reads a valid file, falls back (with a note) on a bad one, and uses defaults when absent', () => {
    expect(loadMarketConfig(path.join(dir, 'missing.json')).config).toEqual(DEFAULT_CONFIG);
    fs.writeFileSync(f, JSON.stringify({ b3Top: 50, us: ['AAPL', 'AAPL', 'MSFT'] }));
    expect(loadMarketConfig(f).config).toEqual({ b3Top: 50, us: ['AAPL', 'MSFT'] });
    for (const bad of ['{nope', JSON.stringify({ b3Top: 5000, us: [] }), JSON.stringify({ b3Top: 50, us: ['../x'] })]) {
      fs.writeFileSync(f, bad);
      const r = loadMarketConfig(f);
      expect(r.config).toEqual(DEFAULT_CONFIG);
      expect(r.problem).toMatch(/inválido/);
    }
  });
});
