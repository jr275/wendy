import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrapiError, fetchDailyCandles, fetchLiquidB3, isTicker, readBrapiToken } from '../../src/market/brapi.js';
import { atr, detect, logReturns, mad, median, robustZ, shouldAlert, type Candle } from '../../src/market/signals.js';

const day = (n: number) => new Date(Date.UTC(2026, 8, 1 + n));
/** A calm series: close wobbles ±0.5 around 100, range 2, volume ~1,000,000. */
const calm = (n: number): Candle[] => Array.from({ length: n }, (_, i) => { const c = 100 + ((i % 5) - 2) * 0.25; return { at: day(i), open: c, high: c + 1, low: c - 1, close: c, volume: 1_000_000 + (i % 3) * 10_000 }; });

describe('statistics', () => {
  it('median, MAD and robust z behave on a plain example, and a spike does not hide itself', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
    expect(robustZ(10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 1000])).toBeGreaterThan(-1);
    expect(robustZ(5, [5, 5, 5, 5])).toBeNull(); // no spread: nothing to compare with
  });
  it('log returns and ATR are computed from clean data', () => {
    expect(logReturns([100, 110])[0]).toBeCloseTo(Math.log(1.1));
    expect(atr(calm(30), 14)).toBeCloseTo(2, 1);
    expect(atr(calm(10), 14)).toBeNull();
  });
});

describe('detect: observations about the last candle', () => {
  it('says nothing about a calm series, and nothing at all with too little history (with the reason)', () => {
    expect(detect('PETR4', calm(40)).signals).toEqual([]);
    expect(detect('PETR4', calm(10))).toEqual({ signals: [], skipped: 'histórico curto (10 de 30 dias)' });
  });
  it('flags an outlier move, a volume spike and a range expansion, each with its numbers and the "not a recommendation" note', () => {
    const c = calm(40);
    c.push({ at: day(40), open: 100, high: 112, low: 99, close: 110, volume: 5_000_000 });
    const kinds = detect('VALE3', c).signals.map((s) => s.kind).sort();
    expect(kinds).toEqual(['MOVE_OUTLIER', 'RANGE_EXPANSION', 'VOLUME_SPIKE']);
    for (const s of detect('VALE3', c).signals) {
      expect(s.explanation).toContain('VALE3');
      expect(s.explanation).toMatch(/não uma recomendação/);
      expect(s.value).toBeGreaterThanOrEqual(s.threshold);
    }
  });
  it('never outputs advice, targets or probabilities', () => {
    const c = calm(40);
    c.push({ at: day(40), open: 100, high: 112, low: 99, close: 110, volume: 5_000_000 });
    const text = JSON.stringify(detect('VALE3', c)).toLowerCase();
    expect(text).not.toMatch(/\b(compre|comprar|venda|vender|alvo|meta de preço|probabilidade|garant)/);
  });
  it('stays silent about assets too thinly traded for the statistics to mean anything', () => {
    const thin = calm(40).map((c) => ({ ...c, volume: 5_000 })); // 100 × 5,000 = 500k per day
    thin.push({ at: day(40), open: 100, high: 112, low: 99, close: 110, volume: 500_000 });
    expect(detect('THIN3', thin)).toEqual({ signals: [], skipped: 'pouco negociado para a estatística valer' });
  });
  it('drops malformed candles instead of repairing them', () => {
    const c = calm(40);
    c.push({ at: day(40), open: NaN, high: 1, low: 2, close: -5, volume: 1e9 });
    expect(detect('PETR4', c).signals).toEqual([]); // the bad last candle is ignored; the calm one before it is the last
  });
});

describe('shouldAlert: cooldown and staleness', () => {
  const now = new Date('2026-10-16T15:00:00Z');
  const sig = { symbol: 'PETR4', kind: 'VOLUME_SPIKE' as const, observedAt: new Date('2026-10-16T00:00:00Z'), value: 4, threshold: 3, explanation: '' };
  it('one alert per symbol and kind per cooldown; other kinds and symbols are independent', () => {
    expect(shouldAlert(sig, [], now)).toBe(true);
    expect(shouldAlert(sig, [{ symbol: 'PETR4', kind: 'VOLUME_SPIKE', at: new Date('2026-10-16T12:00:00Z') }], now)).toBe(false);
    expect(shouldAlert(sig, [{ symbol: 'PETR4', kind: 'VOLUME_SPIKE', at: new Date('2026-10-16T08:00:00Z') }], now)).toBe(true);
    expect(shouldAlert(sig, [{ symbol: 'VALE3', kind: 'VOLUME_SPIKE', at: new Date('2026-10-16T14:00:00Z') }, { symbol: 'PETR4', kind: 'MOVE_OUTLIER', at: new Date('2026-10-16T14:00:00Z') }], now)).toBe(true);
  });
  it('a stale candle is not alerted', () => {
    expect(shouldAlert({ ...sig, observedAt: new Date('2026-10-01T00:00:00Z') }, [], now)).toBe(false);
  });
});

describe('brapi client', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brapi-'));
  const file = path.join(tmp, 'token');
  it('reads the token only from an owner-only file; none when missing or malformed; refuses a readable one', () => {
    expect(readBrapiToken(file)).toBeNull();
    fs.writeFileSync(file, 'abcDEF12_-xyz\n', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    expect(() => readBrapiToken(file)).toThrow(/chmod 600/);
    fs.chmodSync(file, 0o600);
    expect(readBrapiToken(file)).toBe('abcDEF12_-xyz');
    fs.writeFileSync(file, 'curto');
    fs.chmodSync(file, 0o600);
    expect(readBrapiToken(file)).toBeNull();
  });
  it('accepts only B3 tickers', () => {
    for (const ok of ['PETR4', 'VALE3', 'BOVA11', 'AAPL', 'MSFT', 'PETR']) expect(isTicker(ok)).toBe(true);
    for (const bad of ['petr4', 'PETR4/../x', 'AAPLXX', '', 'PETR4?token=1', 'A B']) expect(isTicker(bad)).toBe(false);
  });
  it('sends the token in a header, never in the URL, and parses candles', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const rows = [{ date: 1790000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }, { date: 'x' }];
    const out = await fetchDailyCandles('PETR4', 'tok-123456789', { fetchImpl: async (url, init) => { seen = { url, headers: init.headers }; return { ok: true, status: 200, json: async () => ({ results: [{ historicalDataPrice: rows }] }) }; } });
    expect(seen!.url).not.toContain('tok-123456789');
    expect(seen!.url).not.toMatch(/token=/);
    expect(seen!.headers.Authorization).toBe('Bearer tok-123456789');
    expect(out).toHaveLength(1);
  });
  it('turns failures into short messages that never contain the token', async () => {
    const mk = (status: number) => fetchDailyCandles('PETR4', 'tok-123456789', { fetchImpl: async () => ({ ok: status < 300, status, json: async () => ({}) }) });
    await expect(mk(401)).rejects.toThrow(/recusou o token/);
    await expect(mk(429)).rejects.toThrow(/limitou/);
    await expect(fetchDailyCandles('PETR4', 'tok-123456789', { fetchImpl: async () => { throw new Error('boom tok-123456789'); } })).rejects.toSatisfy((e: Error) => e instanceof BrapiError && !e.message.includes('tok-123456789'));
    await expect(fetchDailyCandles('petr4/..', 'tok-123456789')).rejects.toThrow(/inválido/);
  });
  it('ranks the B3 universe by MARKET CAP (stable), not by today\'s volume, and drops non-B3, empty or cap-less rows', async () => {
    const stocks = [
      { stock: 'PENN3', volume: 90_000_000, close: 0.2, market_cap: 50_000_000 }, // huge volume today, tiny company
      { stock: 'ITUB4', volume: 1, close: 35, market_cap: 700_000_000_000 },
      { stock: 'VALE3', volume: 1, close: 60, market_cap: 600_000_000_000 },
      { stock: '^BVSP', volume: 1, close: 1, market_cap: 9e15 },
      { stock: 'ZERO3', volume: 0, close: 10, market_cap: 9e15 },
      { stock: 'NOCP3', volume: 5, close: 10 },
    ];
    const r = await fetchLiquidB3('tok-123456789', 2, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ stocks }) }) });
    expect(r.map((x) => x.symbol)).toEqual(['ITUB4', 'VALE3']);
  });
});
