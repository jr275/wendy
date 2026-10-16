"use client";
import { useState, useSyncExternalStore } from "react";
import { HIDDEN_TEXT, openCount, resumeEntries, waitingCount } from "@/lib/resume";
import type { ExecutionView, PastQuestion } from "@/lib/wendy";
import { TaskStatus } from "../task-status";
import { useWorkspace } from "../workspace-context";

/**
 * "Retomar": the principal's recent questions from the one continuous conversation, grouped by day.
 * Picking one opens the conversation scrolled to that very message (the same messages the
 * conversation restores — nothing is copied or stored here). It is a way back, not a second history.
 */
const SHORT = 5;

function dayLabel(d: Date, now: Date, tz: string): string {
  const key = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: tz });
  if (key(d) === key(now)) return "Hoje";
  if (key(d) === key(new Date(now.getTime() - 86_400_000))) return "Ontem";
  return d.toLocaleDateString("pt-BR", { timeZone: tz, day: "numeric", month: "long" });
}

/** "Ocultar textos": a per-device choice (kept in this browser only). Off by default; on, the list shows time and task state but not what was written. */
const KEY = "wendy.resume.hidden";
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const readHidden = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const setHidden = (v: boolean) => {
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {}
  listeners.forEach((l) => l());
};

/** Opens the conversation, waits for the message to be on screen, scrolls to it and moves focus there. */
function reveal(id: string) {
  let tries = 0;
  const find = () => {
    const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    if (el && el.getClientRects().length) {
      el.scrollIntoView({ block: "center" });
      el.focus({ preventScroll: true });
      el.classList.add("wendy-flash");
      setTimeout(() => el.classList.remove("wendy-flash"), 1800);
    } else if (tries++ < 20) setTimeout(find, 100);
  };
  requestAnimationFrame(find);
}

export function History({ questions, runs = [], timeZone, now }: { questions: PastQuestion[]; runs?: ExecutionView[]; timeZone: string; now: string }) {
  const { setMode } = useWorkspace();
  const [all, setAll] = useState(false);
  const hidden = useSyncExternalStore(subscribe, readHidden, () => false);
  if (!questions.length) return null;
  const entries = resumeEntries(questions, runs);
  const open = openCount(entries);
  const waiting = waitingCount(entries);
  const shown = all ? entries : entries.slice(0, SHORT);
  const today = new Date(now);
  const labels = shown.map((e) => dayLabel(new Date(e.question.at), today, timeZone));
  return (
    <section aria-label="Retomar uma conversa" className="mx-auto mt-10 w-full max-w-3xl px-4 sm:px-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="eyebrow">Continuar de onde parou</h2>
        <button type="button" aria-pressed={hidden} onClick={() => setHidden(!hidden)} className="inline-flex min-h-11 items-center rounded px-1 text-sm text-muted hover:text-ink lg:min-h-8">
          {hidden ? "Mostrar textos" : "Ocultar textos"}
        </button>
      </div>
      {open ? (
        <p className="mb-3 text-sm text-ink-2" role="status">
          {open === 1 ? "1 tarefa ainda aberta" : `${open} tarefas ainda abertas`}
          {waiting ? ` · ${waiting === 1 ? "1 espera" : `${waiting} esperam`} você` : ""}.
        </p>
      ) : null}
      <ul className="card divide-y divide-line-2 overflow-hidden">
        {shown.map(({ question: q, phase, runId }, i) => {
          const at = new Date(q.at);
          const label = labels[i]!;
          const head = label !== labels[i - 1];
          return (
            <li key={q.id}>
              {head ? <p className="bg-surface-2/60 px-5 py-1.5 text-micro uppercase tracking-wide text-muted">{label}</p> : null}
              <button
                type="button"
                data-question-id={q.id}
                data-run-id={runId ?? undefined}
                onClick={() => {
                  setMode("conversa");
                  reveal(q.id);
                }}
                className="grid min-h-11 w-full grid-cols-[2.75rem_minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1.5 px-5 py-3 text-left transition-colors duration-[var(--dur-1)] hover:bg-surface-2 sm:flex"
              >
                <span className="num w-11 shrink-0 text-xs text-muted">{at.toLocaleTimeString("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" })}</span>
                <span className="min-w-0 flex-1 truncate">{hidden ? <span className="text-muted">{HIDDEN_TEXT}</span> : q.text}</span>
                {phase ? (
                  <span className="col-start-2 row-start-2 justify-self-start sm:contents">
                    <TaskStatus phase={phase} />
                  </span>
                ) : null}
                <span aria-hidden className="col-start-3 row-span-2 row-start-1 self-center text-faint sm:col-auto sm:row-auto sm:self-auto">
                  →
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {questions.length > SHORT ? (
        <button type="button" onClick={() => setAll((x) => !x)} aria-expanded={all} className="mt-1 inline-flex min-h-11 items-center gap-1.5 rounded px-1 text-sm font-medium text-accent-ink hover:underline">
          <span aria-hidden className={`transition-transform duration-[var(--dur-1)] ${all ? "-rotate-90" : "rotate-90"}`}>
            ›
          </span>
          {all ? "Mostrar menos" : `Mostrar mais ${questions.length - SHORT}`}
        </button>
      ) : null}
    </section>
  );
}
