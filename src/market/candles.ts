/**
 * Daily candles kept in the database so the person can SEE them (market_candles). The sweep already downloads this history to look for unusual
 * movement; storing it costs no extra requests. Read here, written only by the sweep and by adding an asset.
 */
import type { Db, Queryable } from '../db/db.js';
import type { Candle } from './signals.js';

/** How many days of candles are kept per asset. */
export const KEEP_DAYS = 200;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export async function storeCandles(db: Queryable, principalId: string, symbol: string, candles: Candle[], now: Date): Promise<number> {
  const ok = candles.filter((c) => [c.open, c.high, c.low, c.close].every((x) => Number.isFinite(x) && x > 0) && Number.isFinite(c.volume) && c.volume >= 0 && c.high >= c.low);
  if (!ok.length) return 0;
  await db.query(
    `INSERT INTO market_candles(principal_id, symbol, day, open, high, low, close, volume, fetched_at)
     SELECT $1, $2, t.d, t.o, t.h, t.l, t.c, t.v, $9 FROM unnest($3::date[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[]) AS t(d, o, h, l, c, v)
     ON CONFLICT (principal_id, symbol, day) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume, fetched_at = EXCLUDED.fetched_at`,
    [principalId, symbol, ok.map((c) => dayOf(c.at)), ok.map((c) => c.open), ok.map((c) => c.high), ok.map((c) => c.low), ok.map((c) => c.close), ok.map((c) => c.volume), now],
  );
  await db.query(`DELETE FROM market_candles WHERE principal_id = $1 AND symbol = $2 AND day < $3::date`, [principalId, symbol, dayOf(new Date(now.getTime() - KEEP_DAYS * 86_400_000))]);
  return ok.length;
}

export interface StoredCandle {
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function readCandles(db: Queryable, principalId: string, symbol: string, days = 120): Promise<StoredCandle[]> {
  const rows = (await db.query<{ day: string } & Omit<StoredCandle, 'day'>>(`SELECT to_char(day, 'YYYY-MM-DD') AS day, open, high, low, close, volume FROM market_candles WHERE principal_id = $1 AND symbol = $2 ORDER BY day DESC LIMIT $3`, [principalId, symbol, days])).rows;
  return rows.reverse();
}

export type { Db };
