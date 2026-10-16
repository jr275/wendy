"use client";
import { useId, useState } from "react";

/**
 * Chart primitives (menlo-2035 / CopilotKit Beautiful Chat style), drawn in SVG/HTML.
 * They only DISPLAY numbers Wendy's code computed from records; nothing here is generated.
 * Colors: categorical slots validated for color-vision deficiency on both surfaces (dataviz
 * validator); identity is never color-alone — every part also has its label and value.
 */
export const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];
export const OTHER = "var(--series-other)";

const pctFmt = (x: number) => `${Math.round(x * 100)}%`;

/** Hero number with its change (the Menlo "R$4.82M, +R$610K vs. semana anterior" pattern). */
export function Kpi({ label, value, change, changeLabel, alarm = false, note }: { label: string; value: string; change: string | null; changeLabel: string; alarm?: boolean; note?: string }) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <p className="num mt-1 text-5xl font-semibold tracking-tight sm:text-6xl">{value}</p>
      <p className="mt-2 text-sm">
        {change ? <span className={`num font-medium ${alarm ? "text-bad" : "text-ink-2"}`}>{change}</span> : null} <span className="text-muted">{changeLabel}</span>
      </p>
      {note ? <p className="mt-1 text-xs text-faint">{note}</p> : null}
    </div>
  );
}

export interface BreakdownItem {
  label: string;
  /** 0..1, width of the bar. */
  share: number;
  value: string;
  note?: string;
  tag?: string;
}

/** Horizontal composition bars: label, share and value on one line, the bar, then a note. */
export function Breakdown({ items, tone = "neutral", ariaLabel }: { items: BreakdownItem[]; tone?: "bad" | "good" | "neutral"; ariaLabel: string }) {
  const fill = tone === "bad" ? "var(--bad)" : tone === "good" ? "var(--good)" : "var(--brand)";
  return (
    <ul className="grid gap-4" aria-label={ariaLabel}>
      {items.map((it, i) => (
        <li key={i} className="min-w-0" title={`${it.label}: ${it.value} (${pctFmt(it.share)})`}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate font-medium">
              {it.tag ? <span className="mr-2 rounded bg-surface-2 px-1.5 py-0.5 text-micro font-normal text-muted">{it.tag}</span> : null}
              {it.label}
            </span>
            <span className="shrink-0 text-sm">
              <span className="num font-semibold">{pctFmt(it.share)}</span> <span className="num text-muted">{it.value}</span>
            </span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full" style={{ width: `${Math.max(2, it.share * 100)}%`, background: fill }} />
          </div>
          {it.note ? <p className="mt-1 text-xs text-muted">{it.note}</p> : null}
        </li>
      ))}
    </ul>
  );
}

export interface DonutItem {
  label: string;
  value: number;
  valueLabel: string;
  /** Leftover bucket ("outras") is drawn in neutral gray. */
  other?: boolean;
}

/** Part-to-whole donut with a legend that always shows label, share and value (Beautiful Chat style). */
export function Donut({ items, centerValue, centerLabel, ariaLabel }: { items: DonutItem[]; centerValue: string; centerLabel: string; ariaLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const size = 180;
  const stroke = 26;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = items.reduce((a, b) => a + b.value, 0);
  const gap = items.length > 1 ? 2 : 0; // 2px surface gap between segments
  // Each segment starts where the previous ones end; colors follow the item's place among non-"other" items.
  const lens = items.map((it) => (total ? (it.value / total) * c : 0));
  const segs = items.map((it, i) => ({
    ...it,
    len: lens[i]!,
    start: lens.slice(0, i).reduce((a, b) => a + b, 0),
    color: it.other ? OTHER : SERIES[items.slice(0, i).filter((x) => !x.other).length % SERIES.length]!,
  }));
  return (
    <div className="grid items-center gap-6 sm:grid-cols-[180px_1fr]">
      <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto w-40 sm:w-full" role="img" aria-labelledby={`${id}-t`}>
        <title id={`${id}-t`}>{ariaLabel}</title>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
        {segs.map((s, i) => (
          <circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={hover === i ? stroke + 4 : stroke}
            strokeDasharray={`${Math.max(0, s.len - gap)} ${c}`}
            strokeDashoffset={-s.start}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            opacity={hover === null || hover === i ? 1 : 0.35}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            style={{ transition: "opacity .15s, stroke-width .15s", cursor: "default" }}
          />
        ))}
        <text x="50%" y="47%" textAnchor="middle" className="num" style={{ fontSize: 26, fontWeight: 600, fill: "var(--ink)" }}>
          {hover === null ? centerValue : segs[hover]!.valueLabel}
        </text>
        <text x="50%" y="60%" textAnchor="middle" style={{ fontSize: 11, fill: "var(--subtle)" }}>
          {hover === null ? centerLabel : pctFmt(total ? segs[hover]!.value / total : 0)}
        </text>
      </svg>
      <ul className="grid min-w-0 gap-2">
        {segs.map((s, i) => (
          <li
            key={i}
            className={`flex min-w-0 items-center gap-3 rounded-lg px-2 py-1 text-sm transition-colors ${hover === i ? "bg-surface-2" : ""}`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate" title={s.label}>
              {s.label}
            </span>
            <span className="num shrink-0 font-semibold">{pctFmt(total ? s.value / total : 0)}</span>
            <span className="num w-14 shrink-0 text-right text-muted">{s.valueLabel}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
