/** Small area chart of a daily series (server component, pure SVG). */
export function Sparkline({ values, tone = "accent", height = 44, label }: { values: number[]; tone?: "accent" | "bad" | "muted"; height?: number; label: string }) {
  const w = 240;
  if (values.length < 2) return <div className="text-xs text-faint">sem série diária</div>;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, height - 2 - (v / max) * (height - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const color = tone === "bad" ? "var(--bad)" : tone === "muted" ? "var(--faint)" : "var(--brand)";
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full" style={{ height }} role="img" aria-label={label} preserveAspectRatio="none">
      <path d={`${line} L${w} ${height} L0 ${height} Z`} fill={color} opacity={0.1} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
