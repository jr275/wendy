/**
 * The watched list, edited by the person. Adding an asset checks that it exists with ONE request to the data provider (and keeps the history that
 * request returns); removing one is permanent (it survives the weekly refresh). Neither places an order or sends anything anywhere.
 */
import { appendAudit } from '../audit/ledger.js';
import { withTx, type Db } from '../db/db.js';
import { newId } from '../util/hash.js';
import { fetchDailyCandles, isB3Ticker, isTicker, readBrapiToken } from './brapi.js';
import { storeCandles } from './candles.js';
import type { Candle } from './signals.js';

/** The most assets (and reference series) one sweep is allowed to ask for: it protects the monthly request budget of the data provider. */
export const MAX_SYMBOLS = 400;
/** Reference series count against the same cap. */
const RESERVED_FOR_REFERENCES = 2;

export class WatchlistError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface WatchDeps {
  token?: () => string | null;
  candles?: (symbol: string, token: string) => Promise<Candle[]>;
}

export type AddResult = { status: 'added' | 'restored' | 'already'; symbol: string; market: 'B3' | 'US'; candles: number };

export async function addAsset(db: Db, principalId: string, raw: string, now: Date, deps: WatchDeps = {}): Promise<AddResult> {
  const symbol = raw.trim().toUpperCase();
  if (!isTicker(symbol) || symbol.startsWith('^')) throw new WatchlistError('código de ativo inválido: use o código da B3 (como PETR4) ou da bolsa americana (como AAPL)');
  const market = isB3Ticker(symbol) ? 'B3' : 'US';
  const existing = (await db.query<{ active: boolean; excluded: boolean; role: string }>(`SELECT active, excluded, role FROM watchlist WHERE principal_id = $1 AND symbol = $2`, [principalId, symbol])).rows[0];
  if (existing?.role === 'reference') throw new WatchlistError('esse código é uma série de referência e já é mostrada');
  if (existing?.active && !existing.excluded) return { status: 'already', symbol, market, candles: 0 };

  const active = Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM watchlist WHERE principal_id = $1 AND active AND NOT excluded`, [principalId])).rows[0]!.n);
  if (active >= MAX_SYMBOLS - RESERVED_FOR_REFERENCES) throw new WatchlistError(`limite de ${MAX_SYMBOLS - RESERVED_FOR_REFERENCES} ativos acompanhados atingido; remova algum antes (cada ativo gasta uma consulta por dia útil da cota do mês)`, 409);

  const token = (deps.token ?? (() => readBrapiToken()))();
  if (!token) throw new WatchlistError('o token da brapi não está configurado neste computador', 503);
  let candles: Candle[];
  try {
    candles = await (deps.candles ?? ((s: string, t: string) => fetchDailyCandles(s, t)))(symbol, token);
  } catch (e) {
    throw new WatchlistError(`não consegui consultar esse ativo (${e instanceof Error ? e.message : 'erro'}); confira o código`, 422);
  }
  if (candles.length < 5) throw new WatchlistError('esse ativo não tem histórico suficiente para acompanhar', 422);

  await withTx(db, async (tx) => {
    await tx.query(
      `INSERT INTO watchlist(id, principal_id, symbol, market, source, active, excluded, updated_at) VALUES ($1,$2,$3,$4,'user',true,false,$5)
       ON CONFLICT (principal_id, symbol) DO UPDATE SET active = true, excluded = false, updated_at = EXCLUDED.updated_at`,
      [newId(), principalId, symbol, market, now],
    );
    await storeCandles(tx, principalId, symbol, candles, now);
    // The ledger records that the list changed, not which asset: what someone follows is their own business.
    await appendAudit(tx, { principalId, eventType: 'WATCHLIST_CHANGED', actor: 'PRINCIPAL', subjectType: 'watchlist', subjectId: principalId, payload: { op: existing ? 'restore' : 'add' } });
  });
  return { status: existing ? 'restored' : 'added', symbol, market, candles: candles.length };
}

export async function removeAsset(db: Db, principalId: string, raw: string, now: Date): Promise<{ status: 'removed'; symbol: string }> {
  const symbol = raw.trim().toUpperCase();
  const row = (await db.query<{ role: string }>(`SELECT role FROM watchlist WHERE principal_id = $1 AND symbol = $2`, [principalId, symbol])).rows[0];
  if (!row) throw new WatchlistError('esse ativo não está na lista', 404);
  if (row.role === 'reference') throw new WatchlistError('as séries de referência não podem ser removidas', 409);
  await withTx(db, async (tx) => {
    await tx.query(`UPDATE watchlist SET active = false, excluded = true, updated_at = $3 WHERE principal_id = $1 AND symbol = $2`, [principalId, symbol, now]);
    await appendAudit(tx, { principalId, eventType: 'WATCHLIST_CHANGED', actor: 'PRINCIPAL', subjectType: 'watchlist', subjectId: principalId, payload: { op: 'remove' } });
  });
  return { status: 'removed', symbol };
}
