/**
 * What the market screen shows, computed from what is stored (candles, alerts, the watched list). Read-only and honest about its limits:
 * every figure carries the day it is about, the information is delayed, and nothing here is advice, a forecast or a target.
 */
import type { Db } from '../db/db.js';
import { readCandles, type StoredCandle } from './candles.js';
import { DATA_NOTE } from './signals.js';
import { MAX_SYMBOLS } from './watchlist.js';

/** The data provider's free plan: requests allowed per rolling 30 days. */
export const MONTHLY_QUOTA = 15_000;
const TRADING_DAYS_PER_MONTH = 22;
const MIN_TRADED_VALUE = 1_000_000;

export interface Quote {
  symbol: string;
  market: 'B3' | 'US';
  lastClose: number;
  prevClose: number | null;
  changePct: number | null;
  /** The trading day the last close belongs to. */
  asOf: string;
  /** The last closes (oldest first) for a small line next to the figure. Only the reference series carry it. */
  spark?: number[];
}
export interface WatchRow {
  symbol: string;
  market: 'B3' | 'US';
  source: 'liquidity' | 'config' | 'user';
  role: 'asset' | 'reference';
  active: boolean;
  excluded: boolean;
  lastClose: number | null;
  changePct: number | null;
  asOf: string | null;
}
export interface AlertRow {
  id: string;
  symbol: string;
  kind: string;
  /** The trading day the observation is about. */
  day: string;
  value: number;
  threshold: number;
  explanation: string;
}
export interface MarketOverview {
  note: string;
  routine: { enabled: boolean; localTime: string; timezone: string } | null;
  lastRun: { date: string; status: string } | null;
  references: Quote[];
  gainers: Quote[];
  losers: Quote[];
  alerts: AlertRow[];
  watchlist: WatchRow[];
  counts: { watchedAssets: number; excluded: number };
  /** Requests one sweep uses and the monthly estimate against the free quota. */
  budget: { perSweep: number; perMonthEstimate: number; monthlyQuota: number; maxAssets: number };
  asOf: string | null;
}

const QUOTE_SQL = `
  SELECT w.symbol, w.market, w.source, w.role, w.active, w.excluded, c1.close AS last_close, c1.volume AS last_volume, to_char(c1.day, 'YYYY-MM-DD') AS as_of, c2.close AS prev_close
    FROM watchlist w
    LEFT JOIN LATERAL (SELECT close, volume, day FROM market_candles WHERE principal_id = w.principal_id AND symbol = w.symbol ORDER BY day DESC LIMIT 1) c1 ON true
    LEFT JOIN LATERAL (SELECT close FROM market_candles WHERE principal_id = w.principal_id AND symbol = w.symbol ORDER BY day DESC OFFSET 1 LIMIT 1) c2 ON true
   WHERE w.principal_id = $1`;

interface Q {
  symbol: string;
  market: 'B3' | 'US';
  source: WatchRow['source'];
  role: WatchRow['role'];
  active: boolean;
  excluded: boolean;
  last_close: number | null;
  last_volume: number | null;
  as_of: string | null;
  prev_close: number | null;
}
const pct = (last: number | null, prev: number | null) => (last !== null && prev !== null && prev > 0 ? Math.round(((last / prev - 1) * 100) * 100) / 100 : null);
const toQuote = (r: Q): Quote => ({ symbol: r.symbol, market: r.market, lastClose: r.last_close!, prevClose: r.prev_close, changePct: pct(r.last_close, r.prev_close), asOf: r.as_of! });

export async function marketOverview(db: Db, principalId: string, days = 30): Promise<MarketOverview> {
  const rows = (await db.query<Q>(`${QUOTE_SQL} ORDER BY w.symbol`, [principalId])).rows;
  const routine = (await db.query<{ enabled: boolean; local_time: string; timezone: string }>(`SELECT enabled, to_char(local_time, 'HH24:MI') AS local_time, timezone FROM routines WHERE principal_id = $1 AND kind = 'market_watch'`, [principalId])).rows[0];
  const run = (await db.query<{ run_date: string; status: string }>(`SELECT to_char(rr.run_date, 'YYYY-MM-DD') AS run_date, rr.status FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id WHERE r.principal_id = $1 AND r.kind = 'market_watch' ORDER BY rr.run_date DESC, rr.started_at DESC LIMIT 1`, [principalId])).rows[0];
  const alerts = (await db.query<{ id: string; symbol: string; kind: string; day: string; value: number; threshold: number; explanation: string }>(
    `SELECT id, symbol, kind, to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, value, threshold, explanation FROM market_alerts WHERE principal_id = $1 AND created_at > now() - make_interval(days => $2) ORDER BY observed_at DESC, symbol, kind LIMIT 300`,
    [principalId, days],
  )).rows;

  const live = rows.filter((r) => r.active && !r.excluded);
  const assets = live.filter((r) => r.role === 'asset');
  const movers = assets.filter((r) => r.last_close !== null && r.prev_close !== null && r.last_volume !== null && r.last_close * r.last_volume >= MIN_TRADED_VALUE).map(toQuote).filter((q) => q.changePct !== null);
  const perSweep = live.length;
  const days_ = rows.map((r) => r.as_of).filter((d): d is string => !!d).sort();
  return {
    note: DATA_NOTE,
    routine: routine ? { enabled: routine.enabled, localTime: routine.local_time, timezone: routine.timezone } : null,
    lastRun: run ? { date: run.run_date, status: run.status } : null,
    references: await Promise.all(rows.filter((r) => r.role === 'reference' && r.last_close !== null).map(async (r) => ({ ...toQuote(r), spark: (await readCandles(db, principalId, r.symbol, 40)).map((c) => c.close) }))),
    gainers: movers.filter((q) => q.changePct! > 0).sort((a, b) => b.changePct! - a.changePct!).slice(0, 5),
    losers: movers.filter((q) => q.changePct! < 0).sort((a, b) => a.changePct! - b.changePct!).slice(0, 5),
    alerts,
    watchlist: rows.map((r) => ({ symbol: r.symbol, market: r.market, source: r.source, role: r.role, active: r.active, excluded: r.excluded, lastClose: r.last_close, changePct: pct(r.last_close, r.prev_close), asOf: r.as_of })),
    counts: { watchedAssets: assets.length, excluded: rows.filter((r) => r.excluded).length },
    budget: { perSweep, perMonthEstimate: perSweep * TRADING_DAYS_PER_MONTH + 5, monthlyQuota: MONTHLY_QUOTA, maxAssets: MAX_SYMBOLS },
    asOf: days_.at(-1) ?? null,
  };
}

export interface AssetView {
  note: string;
  symbol: string;
  market: 'B3' | 'US';
  role: 'asset' | 'reference';
  source: string;
  active: boolean;
  candles: StoredCandle[];
  alerts: AlertRow[];
  stats: { lastClose: number; changePct: number | null; high: number; low: number; days: number; asOf: string } | null;
}

export async function marketAsset(db: Db, principalId: string, raw: string, days = 90): Promise<AssetView | null> {
  const symbol = raw.trim().toUpperCase();
  const w = (await db.query<{ market: 'B3' | 'US'; role: 'asset' | 'reference'; source: string; active: boolean; excluded: boolean }>(`SELECT market, role, source, active, excluded FROM watchlist WHERE principal_id = $1 AND symbol = $2`, [principalId, symbol])).rows[0];
  if (!w) return null;
  const candles = await readCandles(db, principalId, symbol, days);
  const alerts = (await db.query<{ id: string; symbol: string; kind: string; day: string; value: number; threshold: number; explanation: string }>(
    `SELECT id, symbol, kind, to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, value, threshold, explanation FROM market_alerts WHERE principal_id = $1 AND symbol = $2 AND created_at > now() - interval '60 days' ORDER BY observed_at DESC, kind LIMIT 100`,
    [principalId, symbol],
  )).rows;
  const last = candles.at(-1);
  const prev = candles.at(-2);
  return {
    note: DATA_NOTE,
    symbol,
    market: w.market,
    role: w.role,
    source: w.source,
    active: w.active && !w.excluded,
    candles,
    alerts,
    stats: last ? { lastClose: last.close, changePct: prev ? pct(last.close, prev.close) : null, high: Math.max(...candles.map((c) => c.high)), low: Math.min(...candles.map((c) => c.low)), days: candles.length, asOf: last.day } : null,
  };
}
