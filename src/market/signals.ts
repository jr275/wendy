/**
 * Market MONITORING, never advice. Pure functions over daily candles: they flag what is statistically unusual and say why.
 *
 * What this does NOT do, by design: no buy/sell/hold, no target price, no probability of going up or down, no order of any kind. A signal says
 * "this is unusual compared with the last N days", with the numbers, and that the data is delayed. What to do about it is the person's decision.
 */
export interface Candle {
  at: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type SignalKind = 'MOVE_OUTLIER' | 'VOLUME_SPIKE' | 'RANGE_EXPANSION';
export interface MarketSignal {
  symbol: string;
  kind: SignalKind;
  /** The candle the signal is about. */
  observedAt: Date;
  value: number;
  threshold: number;
  /** pt-BR, with the numbers; always states that it is an observation, not a recommendation. */
  explanation: string;
}

export interface DetectOptions {
  /** Candles needed before anything is said (fewer: nothing, and the reason). */
  minHistory?: number;
  moveZ?: number;
  volumeRatio?: number;
  rangeRatio?: number;
  atrPeriod?: number;
  /** Median traded value (price × volume, last 20 days) below which an asset is too thin for these statistics to mean anything. */
  minMedianValue?: number;
}
const DEFAULTS = { minHistory: 30, moveZ: 3.5, volumeRatio: 3, rangeRatio: 2.5, atrPeriod: 14, minMedianValue: 1_000_000 };

export const DATA_NOTE = 'Informações com atraso (cerca de 30 min) e só para acompanhamento: não é recomendação de compra ou venda.';

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median absolute deviation. */
export function mad(xs: number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Robust z-score (0.6745·(x−median)/MAD): a few extreme days do not hide the next one. null when there is no spread to compare with. */
export function robustZ(x: number, history: number[]): number | null {
  const d = mad(history);
  return d > 0 ? (0.6745 * (x - median(history))) / d : null;
}

export const logReturns = (closes: number[]): number[] => closes.slice(1).map((c, i) => Math.log(c / closes[i]!));

const trueRange = (c: Candle, prevClose: number) => Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));

/** Wilder's average true range over `period` candles ending at the second-to-last one (the last candle is what gets compared). */
export function atr(candles: Candle[], period: number): number | null {
  if (candles.length < period + 2) return null;
  const trs = candles.slice(1).map((c, i) => trueRange(c, candles[i]!.close));
  const hist = trs.slice(0, -1);
  let a = hist.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (const tr of hist.slice(period)) a = (a * (period - 1) + tr) / period;
  return a;
}

const valid = (c: Candle) => [c.open, c.high, c.low, c.close].every((x) => Number.isFinite(x) && x > 0) && Number.isFinite(c.volume) && c.volume >= 0 && c.high >= c.low;

/** Signals about the LAST candle only, compared with the candles before it. Bad candles are dropped, never repaired. */
export function detect(symbol: string, raw: Candle[], opts: DetectOptions = {}): { signals: MarketSignal[]; skipped?: string } {
  const o = { ...DEFAULTS, ...opts };
  const candles = raw.filter(valid).sort((a, b) => a.at.getTime() - b.at.getTime());
  if (candles.length < o.minHistory) return { signals: [], skipped: `histórico curto (${candles.length} de ${o.minHistory} dias)` };
  const last = candles[candles.length - 1]!;
  const prior = candles.slice(0, -1);
  const medValue = median(prior.slice(-20).map((c) => c.close * c.volume));
  if (!(medValue >= o.minMedianValue)) return { signals: [], skipped: 'pouco negociado para a estatística valer' };
  const out: MarketSignal[] = [];
  const base = { symbol, observedAt: last.at };
  const tail = ' É uma observação sobre informações atrasadas, não uma recomendação.';

  const z = robustZ(Math.log(last.close / prior[prior.length - 1]!.close), logReturns(prior.map((c) => c.close)));
  if (z !== null && Math.abs(z) >= o.moveZ) {
    const pct = ((last.close / prior[prior.length - 1]!.close - 1) * 100).toFixed(2).replace('.', ',');
    out.push({ ...base, kind: 'MOVE_OUTLIER', value: z, threshold: o.moveZ, explanation: `${symbol}: variação de ${pct}% no último pregão, fora do comum para os últimos ${prior.length - 1} dias (desvio robusto ${z.toFixed(1)}).${tail}` });
  }
  const medVol = median(prior.slice(-20).map((c) => c.volume));
  if (medVol > 0 && last.volume / medVol >= o.volumeRatio) {
    const r = last.volume / medVol;
    out.push({ ...base, kind: 'VOLUME_SPIKE', value: r, threshold: o.volumeRatio, explanation: `${symbol}: volume ${r.toFixed(1).replace('.', ',')}× a mediana dos últimos 20 pregões.${tail}` });
  }
  const a = atr(candles, o.atrPeriod);
  if (a && a > 0) {
    const r = trueRange(last, prior[prior.length - 1]!.close) / a;
    if (r >= o.rangeRatio) out.push({ ...base, kind: 'RANGE_EXPANSION', value: r, threshold: o.rangeRatio, explanation: `${symbol}: amplitude do pregão ${r.toFixed(1).replace('.', ',')}× a média recente (ATR de ${o.atrPeriod} dias).${tail}` });
  }
  return { signals: out };
}

export interface PastAlert {
  symbol: string;
  kind: SignalKind;
  at: Date;
}
/** One alert per symbol and kind per cooldown; and never about a candle older than `maxAgeMs` (a stale signal is noise). */
export function shouldAlert(sig: MarketSignal, past: PastAlert[], now: Date, cooldownMs = 6 * 3_600_000, maxAgeMs = 3 * 86_400_000): boolean {
  if (now.getTime() - sig.observedAt.getTime() > maxAgeMs) return false;
  return !past.some((p) => p.symbol === sig.symbol && p.kind === sig.kind && now.getTime() - p.at.getTime() < cooldownMs);
}
