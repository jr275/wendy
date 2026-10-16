/**
 * The "market_watch" routine: after the B3 close, look at every watched asset's daily candles and record what is unusual (src/market/signals.ts).
 * Monitoring only: it never places an order and never says what to do. Needs the brapi token in ~/.wendy/brapi-token.
 *
 * Budget: the free brapi plan allows one asset per request and 15,000 requests per 30 days, so the sweep is capped (MAX_SYMBOLS) and goes one
 * request at a time with a pause; a rate-limit answer waits and retries once, then that asset is skipped (reported, not hidden).
 */
import { withTx, type Db } from '../db/db.js';
import { BrapiError, fetchDailyCandles, fetchLiquidB3, readBrapiToken } from '../market/brapi.js';
import { loadMarketConfig, type MarketWatchConfig } from '../market/config.js';
import { detect, shouldAlert, type Candle, type MarketSignal, type PastAlert } from '../market/signals.js';
import { newId } from '../util/hash.js';
import type { RoutineHandler } from './runner.js';

export const MAX_SYMBOLS = 400;
const LIQUIDITY_REFRESH_DAYS = 7;

export interface MarketDeps {
  token?: () => string | null;
  candles?: (symbol: string, token: string) => Promise<Candle[]>;
  liquid?: (token: string, top: number) => Promise<{ symbol: string; volume: number }[]>;
  config?: () => { config: MarketWatchConfig; problem?: string };
  sleep?: (ms: number) => Promise<void>;
  gapMs?: number;
  rateLimitWaitMs?: number;
}
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function refreshWatchlist(db: Db, principalId: string, now: Date, cfg: MarketWatchConfig, token: string, d: MarketDeps) {
  const staleRow = (await db.query<{ n: string }>(`SELECT count(*) AS n FROM watchlist WHERE principal_id = $1 AND source = 'liquidity' AND active AND updated_at > $2`, [principalId, new Date(now.getTime() - LIQUIDITY_REFRESH_DAYS * 86_400_000)])).rows[0]!;
  const stale = Number(staleRow.n) === 0;
  const liquid = stale ? await (d.liquid ?? fetchLiquidB3)(token, cfg.b3Top) : null;
  await withTx(db, async (tx) => {
    if (liquid) {
      await tx.query(`UPDATE watchlist SET active = false, updated_at = $2 WHERE principal_id = $1 AND source = 'liquidity'`, [principalId, now]);
      for (const l of liquid) await tx.query(`INSERT INTO watchlist(id, principal_id, symbol, market, source, active, last_volume, updated_at) VALUES ($1,$2,$3,'B3','liquidity',true,$4,$5) ON CONFLICT (principal_id, symbol) DO UPDATE SET active = true, source = 'liquidity', last_volume = EXCLUDED.last_volume, updated_at = EXCLUDED.updated_at`, [newId(), principalId, l.symbol, l.volume, now]);
    }
    await tx.query(`UPDATE watchlist SET active = false, updated_at = $2 WHERE principal_id = $1 AND source = 'config' AND NOT (symbol = ANY($3))`, [principalId, now, cfg.us]);
    for (const s of cfg.us) await tx.query(`INSERT INTO watchlist(id, principal_id, symbol, market, source, active, updated_at) VALUES ($1,$2,$3,'US','config',true,$4) ON CONFLICT (principal_id, symbol) DO UPDATE SET active = true, market = 'US', source = 'config', updated_at = EXCLUDED.updated_at`, [newId(), principalId, s, now]);
  });
}

export function marketWatchHandler(deps: MarketDeps = {}): RoutineHandler {
  return async ({ db, principalId, now, runDate }) => {
    const dow = new Date(`${runDate}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) return { items: [], note: 'Fim de semana: sem pregão.' };
    const token = (deps.token ?? (() => readBrapiToken()))();
    if (!token) throw new Error('sem token da brapi em ~/.wendy/brapi-token');
    const { config, problem } = (deps.config ?? (() => loadMarketConfig()))();
    await refreshWatchlist(db, principalId, now, config, token, deps);
    const symbols = (await db.query<{ symbol: string }>(`SELECT symbol FROM watchlist WHERE principal_id = $1 AND active ORDER BY market DESC, last_volume DESC NULLS LAST, symbol LIMIT $2`, [principalId, MAX_SYMBOLS])).rows.map((r) => r.symbol);
    const past: PastAlert[] = (await db.query<{ symbol: string; kind: PastAlert['kind']; created_at: Date }>(`SELECT symbol, kind, created_at FROM market_alerts WHERE principal_id = $1 AND created_at > $2`, [principalId, new Date(now.getTime() - 86_400_000)])).rows.map((r) => ({ symbol: r.symbol, kind: r.kind, at: r.created_at }));
    const sleep = deps.sleep ?? defaultSleep;
    const getCandles = deps.candles ?? ((s: string, t: string) => fetchDailyCandles(s, t));
    let checked = 0, raised = 0;
    const failed: string[] = [];
    for (const [i, symbol] of symbols.entries()) {
      if (i > 0) await sleep(deps.gapMs ?? 500);
      let candles: Candle[] | null = null;
      for (let attempt = 0; attempt < 2 && !candles; attempt++) {
        try {
          candles = await getCandles(symbol, token);
        } catch (e) {
          if (e instanceof BrapiError && /limitou/.test(e.message) && attempt === 0) await sleep(deps.rateLimitWaitMs ?? 65_000);
          else if (e instanceof BrapiError && /recusou o token/.test(e.message)) throw e; // no point asking 400 more times
          else break;
        }
      }
      if (!candles) { failed.push(symbol); continue; }
      checked++;
      const sigs: MarketSignal[] = detect(symbol, candles).signals.filter((s) => shouldAlert(s, past, now));
      for (const s of sigs) {
        const r = await db.query(`INSERT INTO market_alerts(id, principal_id, symbol, kind, observed_at, value, threshold, explanation, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (principal_id, symbol, kind, observed_at) DO NOTHING`, [newId(), principalId, s.symbol, s.kind, s.observedAt, s.value, s.threshold, s.explanation, now]);
        raised += r.rowCount ?? 0;
        past.push({ symbol: s.symbol, kind: s.kind, at: now });
      }
    }
    if (!checked) throw new Error('nenhum ativo pôde ser consultado');
    return { items: [], note: `${checked} ativos verificados, ${raised} observações novas${failed.length ? `, ${failed.length} sem resposta` : ''}${problem ? `; ${problem}` : ''}` };
  };
}
