/**
 * brapi.dev client (B3 quotes, free tier, delayed data). Read-only: it only GETs historical daily candles.
 *
 * The token is read from ~/.wendy/brapi-token (a file only the owner can read), sent in an Authorization header (never in the URL, so it cannot end
 * up in logs), and never stored in the database or printed. If the file is missing, loose or empty, nothing is requested.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Candle } from './signals.js';

export class BrapiError extends Error {}

export const defaultTokenPath = () => path.join(os.homedir(), '.wendy', 'brapi-token');

/** null when there is no usable token; throws only for a token file anyone else could read (the person must fix that first). */
export function readBrapiToken(file = defaultTokenPath()): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if ((st.mode & 0o077) !== 0) throw new BrapiError('o arquivo do token da brapi pode ser lido por outras contas; rode: chmod 600 ~/.wendy/brapi-token');
  const t = fs.readFileSync(file, 'utf8').trim();
  return /^[A-Za-z0-9_-]{8,200}$/.test(t) ? t : null;
}

/** B3 tickers (PETR4, VALE3, BOVA11…). */
export const isB3Ticker = (s: string): boolean => /^[A-Z]{4}\d{1,2}$/.test(s);
/** B3 or US tickers (AAPL, MSFT…): validated before they go into a URL. */
export const isTicker = (s: string): boolean => isB3Ticker(s) || /^[A-Z]{1,5}$/.test(s);

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function fetchDailyCandles(symbol: string, token: string, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<Candle[]> {
  if (!isTicker(symbol)) throw new BrapiError('código de ativo inválido');
  const doFetch = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  let res;
  try {
    res = await doFetch(`https://brapi.dev/api/quote/${symbol}?range=3mo&interval=1d`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
  } catch {
    throw new BrapiError('não consegui falar com a brapi');
  }
  if (res.status === 401 || res.status === 403) throw new BrapiError('a brapi recusou o token');
  if (res.status === 429) throw new BrapiError('a brapi limitou as consultas');
  if (!res.ok) throw new BrapiError(`a brapi respondeu ${res.status}`);
  const body = (await res.json().catch(() => null)) as { results?: { historicalDataPrice?: Array<Record<string, unknown>> }[] } | null;
  const rows = body?.results?.[0]?.historicalDataPrice;
  if (!Array.isArray(rows)) throw new BrapiError('resposta da brapi em formato inesperado');
  return rows.flatMap((r) => {
    const [open, high, low, close, volume, date] = [Number(r.open), Number(r.high), Number(r.low), Number(r.close), Number(r.volume), Number(r.date)];
    return Number.isFinite(date) ? [{ at: new Date(date * 1000), open, high, low, close, volume }] : [];
  });
}

/**
 * The largest B3 stocks by MARKET CAP (one request): [{ symbol, volume }], highest first (`volume` carries the ranking value). Market cap is stable; the list
 * only has today's volume, and ranking by it would pick the assets that happen to be abnormal today (the very thing the sweep looks for).
 */
export async function fetchLiquidB3(token: string, top: number, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<{ symbol: string; volume: number }[]> {
  const doFetch = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  let res;
  try {
    res = await doFetch('https://brapi.dev/api/quote/list?type=stock&limit=2000', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
  } catch {
    throw new BrapiError('não consegui falar com a brapi');
  }
  if (res.status === 401 || res.status === 403) throw new BrapiError('a brapi recusou o token');
  if (!res.ok) throw new BrapiError(`a brapi respondeu ${res.status}`);
  const body = (await res.json().catch(() => null)) as { stocks?: Array<Record<string, unknown>> } | null;
  if (!Array.isArray(body?.stocks)) throw new BrapiError('resposta da brapi em formato inesperado');
  return body.stocks
    .filter((r) => Number(r.volume) > 0) // traded today
    .map((r) => ({ symbol: String(r.stock ?? ''), volume: Number(r.market_cap) }))
    .filter((r) => isB3Ticker(r.symbol) && Number.isFinite(r.volume) && r.volume > 0)
    .sort((a, b) => b.volume - a.volume || a.symbol.localeCompare(b.symbol))
    .slice(0, top);
}
