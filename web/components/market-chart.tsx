"use client";
import { useMemo, useState } from "react";
import { chartGeometry, fmtDay, fmtNumber, fmtPrice, fmtVolume, type Candle } from "@/lib/marketChart";

const KIND_LABEL: Record<string, string> = { MOVE_OUTLIER: "variação fora do comum", VOLUME_SPIKE: "volume muito acima do normal", RANGE_EXPANSION: "oscilação maior que a média" };
const RANGES = [
  { id: "1m", label: "1 mês", days: 22 },
  { id: "3m", label: "3 meses", days: 120 },
] as const;

/**
 * Daily candles with volume. Up days are an outlined body in the "good" colour, down days a filled body in the "bad" colour, so the two never
 * depend on colour alone. A triangle marks a day the monitor recorded an observation (hover or focus for what). There is a table of the same
 * numbers below. Nothing is smoothed or projected.
 */
export function MarketChart({ symbol, kind, candles, alerts }: { symbol: string; kind: "B3" | "US" | "index"; candles: Candle[]; alerts: { day: string; kind: string }[] }) {
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("3m");
  const shown = useMemo(() => candles.slice(-(RANGES.find((r) => r.id === range)?.days ?? 120)), [candles, range]);
  const g = useMemo(() => chartGeometry(shown, alerts), [shown, alerts]);
  if (!g.candles.length) return <p className="text-muted">Ainda não há histórico guardado para este ativo. Ele aparece depois da próxima verificação.</p>;
  const first = shown[0]!;
  const last = shown.at(-1)!;
  const label = `Gráfico de candles diários de ${symbol}, de ${fmtDay(first.day)} a ${fmtDay(last.day)}: abertura ${fmtPrice(first.open, kind)}, último fechamento ${fmtPrice(last.close, kind)}. ${g.marks.length ? `${g.marks.length} dia(s) com observação do monitor.` : "Sem observações do monitor no período."}`;
  return (
    <figure>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Período do gráfico" className="flex gap-1">
          {RANGES.map((r) => (
            <button key={r.id} type="button" aria-pressed={range === r.id} onClick={() => setRange(r.id)} className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm lg:min-h-8 ${range === r.id ? "bg-ink text-bg" : "border border-line text-ink-2 hover:bg-surface-2"}`}>
              {r.label}
            </button>
          ))}
        </div>
        <span className="text-sm text-muted">{shown.length} pregões</span>
      </div>
      <svg role="img" aria-label={label} viewBox={`0 0 ${g.width} ${g.height}`} className="h-auto w-full">
        {g.yTicks.map((t) => (
          <g key={t.value}>
            <line x1={g.plot.left} x2={g.plot.right} y1={t.y} y2={t.y} strokeWidth="1" style={{ stroke: "var(--line-2)" }} />
            <text x={g.plot.left - 8} y={t.y + 4} textAnchor="end" fontSize="11" style={{ fill: "var(--muted)" }}>
              {fmtNumber(t.value, t.value >= 1000 ? 0 : 2)}
            </text>
          </g>
        ))}
        {g.xTicks.map((t, i) => (
          <text key={`${t.day}-${i}`} x={t.x} y={g.height - 6} textAnchor={i === 0 ? "start" : i === g.xTicks.length - 1 ? "end" : "middle"} fontSize="11" style={{ fill: "var(--muted)" }}>
            {fmtDay(t.day)}
          </text>
        ))}
        {g.candles.map((d) => {
          const colour = d.up ? "var(--good)" : "var(--bad)";
          return (
            <g key={d.day}>
              <title>{`${fmtDay(d.day)} · abertura ${fmtPrice(d.candle.open, kind)} · máx ${fmtPrice(d.candle.high, kind)} · mín ${fmtPrice(d.candle.low, kind)} · fechamento ${fmtPrice(d.candle.close, kind)} · volume ${fmtVolume(d.candle.volume)}`}</title>
              <line x1={d.x} x2={d.x} y1={d.wickTop} y2={d.wickBottom} strokeWidth="1" style={{ stroke: colour }} />
              <rect x={d.x - d.bodyWidth / 2} y={d.bodyTop} width={d.bodyWidth} height={d.bodyHeight} strokeWidth="1.25" style={{ stroke: colour, fill: d.up ? "var(--surface)" : colour }} />
              <rect x={d.x - d.bodyWidth / 2} y={d.volTop} width={d.bodyWidth} height={d.volHeight} style={{ fill: "var(--line)" }} />
            </g>
          );
        })}
        {g.marks.map((m) => (
          <g key={m.day} tabIndex={0} aria-label={`${fmtDay(m.day)}: ${m.kinds.map((k) => KIND_LABEL[k] ?? k).join("; ")}`}>
            <title>{`${fmtDay(m.day)}: ${m.kinds.map((k) => KIND_LABEL[k] ?? k).join("; ")}`}</title>
            <path d={`M ${m.x - 5} ${g.plot.top - 2} L ${m.x + 5} ${g.plot.top - 2} L ${m.x} ${g.plot.top + 7} Z`} style={{ fill: "var(--warn)" }} />
          </g>
        ))}
        <text x={g.plot.left} y={g.vol.top - 3} fontSize="10" style={{ fill: "var(--faint)" }}>
          volume
        </text>
      </svg>
      <figcaption className="mt-2 text-sm text-muted">Corpo vazio = dia de alta; corpo cheio = dia de queda. {g.marks.length ? "▼ marca um dia em que o monitor registrou uma observação." : ""} Dados com atraso, só para acompanhamento.</figcaption>
      <details className="mt-3">
        <summary className="min-h-11 cursor-pointer text-sm font-medium text-accent-ink lg:min-h-8">Ver como tabela</summary>
        <div className="mt-2 max-h-72 overflow-auto">
          <table className="num w-full text-sm">
            <caption className="sr-only">Candles diários de {symbol}</caption>
            <thead>
              <tr className="text-left text-muted">
                {["Dia", "Abertura", "Máxima", "Mínima", "Fechamento", "Volume"].map((h) => (
                  <th key={h} scope="col" className="px-2 py-1 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...shown].reverse().map((c) => (
                <tr key={c.day} className="border-t border-line-2">
                  <th scope="row" className="px-2 py-1 text-left font-normal">
                    {fmtDay(c.day)}
                  </th>
                  <td className="px-2 py-1">{fmtNumber(c.open)}</td>
                  <td className="px-2 py-1">{fmtNumber(c.high)}</td>
                  <td className="px-2 py-1">{fmtNumber(c.low)}</td>
                  <td className="px-2 py-1">{fmtNumber(c.close)}</td>
                  <td className="px-2 py-1">{fmtVolume(c.volume)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
