"use client";
import { useState, useTransition } from "react";
import { confirmMemory, retractMemory } from "@/lib/actions";

/** "statement — "quote" (source)" → parts (how learn-about-me writes memories); anything else stays whole. */
export function splitMemory(content: string): { statement: string; quote: string | null; source: string | null } {
  const m = /^([\s\S]*?) — "([\s\S]*)" \(([^()]*)\)$/.exec(content);
  return m ? { statement: m[1]!, quote: m[2]!, source: readableSource(m[3]!) } : { statement: content, quote: null, source: null };
}

/** "2025-09-19-como-superar-a-ansiedade.md, 2025-09-19" → "como superar a ansiedade · 2025-09-19". */
function readableSource(s: string): string {
  const [name = "", ...rest] = s.split(", ");
  const title = name.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.(md|markdown|txt|pdf)$/i, "").replace(/[-_]+/g, " ").trim();
  return [title, ...rest].filter(Boolean).join(" · ");
}

type State = "PROPOSED" | "ACTIVE" | "confirmed" | "discarded";

/**
 * One memory and what the principal can do with it:
 * a proposal → Confirmar / Descartar; an old one → Ainda vale / Esquecer; an active one → Esquecer.
 * Wendy only uses ACTIVE memories; nothing becomes active without the principal.
 */
export function MemoryRow({ id, content, status, needsReview = false, tag, about }: { id: string | null; content: string; status: "PROPOSED" | "ACTIVE"; needsReview?: boolean; tag?: string; about?: string | null }) {
  const [state, setState] = useState<State>(status);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { statement, quote, source } = splitMemory(content);
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, next: State) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (r.ok) setState(next);
      else setError(r.error ?? "erro");
    });
  const btn = "rounded-full px-3 py-1 text-xs disabled:opacity-50";
  return (
    <li className={`rounded-2xl border p-4 transition-opacity ${state === "discarded" ? "border-line-2 opacity-45" : state === "confirmed" ? "border-accent/40 bg-accent-soft/40" : "border-line bg-surface"}`}>
      {tag || about || needsReview ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {tag ? <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{tag}</span> : null}
          {about ? <span className="rounded-full bg-info-soft px-2 py-0.5 text-[11px] text-info">sobre {about}</span> : null}
          {needsReview && state === "ACTIVE" ? <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">isto ainda vale?</span> : null}
        </div>
      ) : null}
      <p className="mt-1.5 leading-relaxed">{statement}</p>
      {quote ? <p className="mt-1 text-sm italic text-muted">“{quote}”</p> : null}
      {source ? <p className="mt-1 text-xs text-faint">{source}</p> : null}
      {id ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {state === "PROPOSED" ? (
            <>
              <button type="button" disabled={busy} onClick={() => act(() => confirmMemory(id), "confirmed")} className={`${btn} bg-accent font-medium text-bg`}>
                Confirmar
              </button>
              <button type="button" disabled={busy} onClick={() => act(() => retractMemory(id, null), "discarded")} className={`${btn} border border-line text-ink-2`}>
                Descartar
              </button>
            </>
          ) : state === "ACTIVE" ? (
            <>
              {needsReview ? (
                <button type="button" disabled={busy} onClick={() => act(() => confirmMemory(id), "confirmed")} className={`${btn} bg-accent font-medium text-bg`}>
                  Ainda vale
                </button>
              ) : null}
              <button type="button" disabled={busy} onClick={() => act(() => retractMemory(id, null), "discarded")} className={`${btn} border border-line text-ink-2`}>
                Esquecer
              </button>
            </>
          ) : (
            <span className="text-xs text-muted">{state === "confirmed" ? "Confirmado — a Wendy passa a usar isso." : "Descartado — a Wendy não usa mais isso."}</span>
          )}
        </div>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}
