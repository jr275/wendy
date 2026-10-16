import { sparkPoints } from "@/lib/marketChart";

/** A small line of recent closes. Decorative: the figure beside it carries the meaning, so it is hidden from assistive technology. */
export function Sparkline({ values, up }: { values: number[]; up: boolean | null }) {
  const pts = sparkPoints(values, 120, 32);
  if (!pts) return null;
  return (
    <svg aria-hidden="true" viewBox="0 0 120 32" className="h-8 w-28 shrink-0 overflow-visible">
      <polyline points={pts} fill="none" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" style={{ stroke: up === null ? "var(--muted)" : up ? "var(--good)" : "var(--bad)" }} />
    </svg>
  );
}
