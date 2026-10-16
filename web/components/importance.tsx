"use client";
import { useOptimistic, useState, useTransition } from "react";
import { setSiteImportance } from "@/lib/actions";
import { ACTIONS_OFF_NOTE_ID, useActionsOffReason } from "./agent-availability";

const OPTIONS: { value: number | null; label: string; hint: string }[] = [
  { value: null, label: "Não definida", hint: "peso baixo por padrão" },
  { value: 0.3, label: "Baixa", hint: "0,3" },
  { value: 0.6, label: "Média", hint: "0,6" },
  { value: 0.9, label: "Alta", hint: "0,9" },
];

/** Principal-set importance of a site. Wendy never infers it; it only changes what interrupts you. */
export function ImportanceControl({ propertyId, label, value }: { propertyId: string; label: string; value: number | null }) {
  const [optimistic, setOptimistic] = useOptimistic(value);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const off = useActionsOffReason(); // set only when the environment says the agent is off; the page shows the one shared note
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Importância para você</p>
        <p className="num text-xs text-muted">{optimistic === null ? "não definida" : optimistic.toFixed(2)}</p>
      </div>
      <div role="radiogroup" aria-label={`Importância de ${label}`} className="mt-2 grid grid-cols-2 gap-1 rounded-2xl border border-line bg-surface-2 p-1">
        {OPTIONS.map((o) => {
          const active = optimistic === o.value || (o.value !== null && optimistic !== null && Math.abs(optimistic - o.value) < 0.001);
          return (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={pending || !!off}
              aria-describedby={off ? ACTIONS_OFF_NOTE_ID : undefined}
              aria-label={`${o.label} — ${o.hint}`}
              title={o.hint}
              onClick={() => {
                if (off) return; // also covers a stale or programmatic call
                start(async () => {
                  setError(null);
                  setOptimistic(o.value);
                  const r = await setSiteImportance(propertyId, o.value);
                  if (!r.ok) setError(r.error);
                });
              }}
              className={`whitespace-nowrap rounded-xl px-2 py-2 text-xs transition-colors ${active ? "bg-surface font-medium text-ink shadow-sm" : "text-muted hover:text-ink"}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-faint">Define o quanto mudanças neste site podem te interromper. A Wendy nunca deduz isso sozinha.</p>
      {error ? <p className="mt-2 text-xs text-bad" role="alert">{error}</p> : null}
    </div>
  );
}
