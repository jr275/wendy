/**
 * Geometry of the market charts, kept pure so it is tested without a browser. A candle is drawn from its four prices; a volume bar sits under it;
 * a marker flags a day the monitor raised an observation. Nothing here smooths, forecasts or extrapolates: it only maps stored numbers to pixels.
 */
export interface Candle {
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface Mark {
  day: string;
  kind: string;
}

export interface DrawnCandle {
  x: number;
  /** Wick from the day's high to its low. */
  wickTop: number;
  wickBottom: number;
  bodyTop: number;
  bodyHeight: number;
  bodyWidth: number;
  volTop: number;
  volHeight: number;
  up: boolean;
  day: string;
  candle: Candle;
}
export interface Geometry {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  vol: { top: number; bottom: number };
  candles: DrawnCandle[];
  yTicks: { y: number; value: number }[];
  xTicks: { x: number; day: string }[];
  marks: { x: number; day: string; kinds: string[] }[];
  min: number;
  max: number;
}

/** Round "nice" tick values between lo and hi (about `count` of them). */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

export function chartGeometry(candles: Candle[], marks: Mark[] = [], size: { width?: number; height?: number } = {}): Geometry {
  const width = size.width ?? 720;
  const height = size.height ?? 340;
  const plot = { left: 56, right: width - 12, top: 12, bottom: Math.round(height * 0.72) };
  const vol = { top: plot.bottom + 14, bottom: height - 24 };
  const clean = candles.filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.high >= c.low);
  if (!clean.length) return { width, height, plot, vol, candles: [], yTicks: [], xTicks: [], marks: [], min: 0, max: 0 };
  const lo = Math.min(...clean.map((c) => c.low));
  const hi = Math.max(...clean.map((c) => c.high));
  const pad = hi > lo ? (hi - lo) * 0.04 : Math.max(hi * 0.01, 0.01); // a flat series still gets a visible band
  const min = lo - pad;
  const max = hi + pad;
  const y = (v: number) => plot.top + ((max - v) / (max - min)) * (plot.bottom - plot.top);
  const slot = (plot.right - plot.left) / clean.length;
  const bodyWidth = Math.max(2, Math.min(14, slot * 0.62));
  const maxVol = Math.max(...clean.map((c) => c.volume), 0);
  const volH = (v: number) => (maxVol > 0 ? (v / maxVol) * (vol.bottom - vol.top) : 0);
  const drawn: DrawnCandle[] = clean.map((c, i) => {
    const x = plot.left + slot * (i + 0.5);
    const bodyTop = y(Math.max(c.open, c.close));
    const bodyBottom = y(Math.min(c.open, c.close));
    const vh = volH(c.volume);
    return { x, wickTop: y(c.high), wickBottom: y(c.low), bodyTop, bodyHeight: Math.max(1, bodyBottom - bodyTop), bodyWidth, volTop: vol.bottom - vh, volHeight: vh, up: c.close >= c.open, day: c.day, candle: c };
  });
  const byDay = new Map(drawn.map((d) => [d.day, d]));
  const grouped = new Map<string, string[]>();
  for (const m of marks) if (byDay.has(m.day)) grouped.set(m.day, [...(grouped.get(m.day) ?? []), m.kind]);
  const n = Math.min(5, clean.length);
  const xTicks = Array.from({ length: n }, (_, k) => drawn[n === 1 ? 0 : Math.round((k * (drawn.length - 1)) / (n - 1))]!).map((d) => ({ x: d.x, day: d.day }));
  return {
    width,
    height,
    plot,
    vol,
    candles: drawn,
    yTicks: niceTicks(min, max, 4).filter((v) => v >= min && v <= max).map((v) => ({ y: y(v), value: v })),
    xTicks,
    marks: [...grouped.entries()].map(([day, kinds]) => ({ x: byDay.get(day)!.x, day, kinds })),
    min,
    max,
  };
}

/** Points of a small line (a "sparkline") filling width × height; empty when there is nothing to draw. */
export function sparkPoints(values: number[], width = 120, height = 32, pad = 2): string {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return "";
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const span = hi - lo || 1;
  return v.map((n, i) => `${(pad + (i / (v.length - 1)) * (width - 2 * pad)).toFixed(1)},${(pad + (1 - (n - lo) / span) * (height - 2 * pad)).toFixed(1)}`).join(" ");
}

const NF = (digits: number) => new Intl.NumberFormat("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const fmtNumber = (n: number, digits = 2) => NF(digits).format(n);
/** A price with its currency: B3 in reais, US in dollars, an index in points (no currency). */
export function fmtPrice(n: number, kind: "B3" | "US" | "index"): string {
  if (kind === "index") return fmtNumber(n, 0);
  return `${kind === "B3" ? "R$" : "US$"} ${fmtNumber(n, 2)}`;
}
/** "+1,25%" / "−0,40%" with a real minus sign; "—" when unknown. */
export function fmtChange(p: number | null): string {
  if (p === null) return "—";
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${fmtNumber(Math.abs(p), 2)}%`;
}
export const fmtDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
export const fmtVolume = (n: number) => new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(n);
