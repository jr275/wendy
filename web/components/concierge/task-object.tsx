"use client";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { approveAction, cancelExecution, rejectAction } from "@/lib/actions";
import { toTaskPresentation, type TaskPresentation, type TimelineStep } from "@/lib/concierge";
import { fetchExecution } from "@/lib/live";
import type { ExecutionView } from "@/lib/wendy";
import { WendyPresence } from "./presence";

/**
 * A delegated task as an object: what Wendy is doing for you, where it stands, what she needs, what
 * came out. It renders Wendy's own state (ExecutionView → toTaskPresentation); it holds none. While
 * the task can still move it re-reads the run (faster during a call, paused when the tab is hidden,
 * stopped for good once the task is over).
 */
const POLL_MS = { call: 1500, open: 3000 } as const;

function useLiveExecution(initial: ExecutionView, enabled: boolean) {
  const [v, setV] = useState(initial);
  const [now, setNow] = useState(() => new Date());
  const p = toTaskPresentation(v, now);
  const terminal = p.terminal;
  const inCall = p.inCall;
  useEffect(() => {
    if (!enabled || terminal) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stop) return;
      if (!document.hidden) {
        const next = await fetchExecution(initial.id).catch(() => null);
        if (!stop && next) {
          setV(next);
          setNow(new Date());
        }
      }
      if (!stop) timer = setTimeout(tick, inCall ? POLL_MS.call : POLL_MS.open);
    };
    timer = setTimeout(tick, inCall ? POLL_MS.call : POLL_MS.open);
    const onVisible = () => !document.hidden && void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, terminal, inCall, initial.id]);
  const reload = async () => {
    const next = await fetchExecution(initial.id).catch(() => null);
    if (next) {
      setV(next);
      setNow(new Date());
    }
  };
  return { p, reload };
}

/** Ticks once a second, only while mounted and live (a snapshot shows the time at its last event). */
function Elapsed({ since, label, until }: { since: string; label: string; until?: string | null }) {
  const [now, setNow] = useState(() => (until ? new Date(until).getTime() : Date.now()));
  useEffect(() => {
    if (until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const text = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return (
    <span className="num text-4xl font-light tracking-tight sm:text-5xl" aria-label={`${label}: ${Math.floor(s / 60)} min ${s % 60} s`} role="timer">
      {text}
    </span>
  );
}

function SimulationTag({ onStage = false }: { onStage?: boolean }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] ${onStage ? "bg-white/10 text-white/80" : "bg-info-soft text-info"}`}>Simulação</span>;
}

// ── panels ──────────────────────────────────────────────────────────────────────────────

function ApprovalPanel({ a, onDecided, interactive }: { a: NonNullable<TaskPresentation["approval"]>; onDecided: () => void; interactive: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const approveRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  // Bring the decision to the keyboard — only when the principal is not typing somewhere else.
  useEffect(() => {
    if (interactive && (document.activeElement === document.body || document.activeElement === null)) approveRef.current?.focus({ preventScroll: true });
  }, [interactive]);
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Não foi possível concluir.");
      onDecided();
    });
  return (
    <section aria-labelledby={headingId} className="mt-5 overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="px-5 pt-5">
        <p id={headingId} className="eyebrow">
          A Wendy quer ligar
        </p>
        <p className="mt-2 text-2xl font-semibold tracking-tight">{a.target}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted">
          <span className="num text-ink-2">{a.phone}</span>
          <span aria-hidden>·</span>
          <span>{a.source}</span>
        </p>
      </div>
      {a.terms.length ? (
        <div className="mt-4 border-t border-line-2 px-5 py-4">
          <p className="eyebrow">Combinado</p>
          <ul className="mt-2 grid gap-1.5 text-[15px] leading-snug">
            {a.terms.map((t, i) => (
              <li key={i} className="flex gap-2.5">
                <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-faint" />
                {t}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <dl className="grid grid-cols-2 gap-px border-t border-line-2 bg-line-2 text-sm">
        <div className="bg-surface px-5 py-3">
          <dt className="text-muted">Duração</dt>
          <dd className="num mt-0.5 text-ink">até {a.maxMinutes} min</dd>
        </div>
        <div className="bg-surface px-5 py-3">
          <dt className="text-muted">Custo estimado</dt>
          <dd className="num mt-0.5 text-ink">até {a.cost}</dd>
        </div>
      </dl>
      {a.simulated ? <p className="border-t border-line-2 bg-info-soft/50 px-5 py-2.5 text-xs text-info">Simulação — nenhuma ligação real será feita e nada será cobrado.</p> : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-line-2 px-5 py-4">
        <button
          ref={approveRef}
          type="button"
          disabled={pending || !interactive}
          onClick={() => act(() => approveAction(a.actionId))}
          className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Um instante…" : "Aprovar e ligar"}
        </button>
        <button
          type="button"
          disabled={pending || !interactive}
          onClick={() => act(() => rejectAction(a.actionId, "Agora não"))}
          className="rounded-full px-4 py-2.5 text-sm text-ink-2 hover:bg-surface-2 disabled:opacity-50"
        >
          Agora não
        </button>
      </div>
      {error ? (
        <p className="px-5 pb-4 text-sm text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

const CALL_PHASES = [
  { key: "DIALING", label: "Ligando" },
  { key: "CONNECTED", label: "Atenderam" },
  { key: "ACTIVE", label: "Conversando" },
  { key: "ENDING", label: "Encerrando" },
] as const;

function LiveCall({ p, live }: { p: TaskPresentation; live: boolean }) {
  const c = p.call;
  const order = CALL_PHASES.map((x) => x.key as string);
  const at = p.state === "ACTION_REQUIRED" ? order.indexOf("ACTIVE") : order.indexOf(p.state);
  return (
    <section aria-label="Ligação em andamento" className="stage mt-5 p-5 sm:p-7">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <WendyPresence state={p.presence} size="md" />
          <div>
            <p className="text-sm stage-muted">{p.state === "DIALING" ? "Ligando para" : "Em ligação com"}</p>
            <p className="text-lg font-medium">{p.target ?? "—"}</p>
          </div>
        </div>
        {c?.simulated ? <SimulationTag onStage /> : null}
      </div>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        {c?.connectedAt ? <Elapsed since={c.connectedAt} until={live ? null : c.lastEventAt} label="Tempo de ligação" /> : <span className="num text-4xl font-light tracking-tight stage-muted sm:text-5xl">--:--</span>}
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Andamento da ligação">
          {CALL_PHASES.map((ph, i) => (
            <li key={ph.key} className={`flex items-center gap-1.5 ${i <= at ? "" : "stage-muted"}`} aria-current={i === at ? "step" : undefined}>
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${i < at ? "bg-[var(--presence-mid)]" : i === at ? "stage-dot bg-[var(--presence-hi)]" : "bg-white/20"}`} />
              {ph.label}
            </li>
          ))}
        </ol>
      </div>
      {p.state === "ACTION_REQUIRED" ? (
        <p className="mt-5 rounded-xl bg-white/[0.06] px-4 py-3 text-sm">Assim que a ligação terminar, te conto exatamente o que pediram.</p>
      ) : null}
      {c && c.transcript.length ? (
        <details className="group mt-5 border-t stage-line pt-4">
          <summary className="cursor-pointer list-none text-sm stage-muted hover:text-white">
            <span className="group-open:hidden">Ver a conversa</span>
            <span className="hidden group-open:inline">Esconder a conversa</span>
          </summary>
          <ol className="mt-3 grid gap-2 text-sm">
            {c.transcript.slice(-6).map((t, i) => (
              <li key={i} className="grid grid-cols-[3.5rem_1fr] gap-2">
                <span className="stage-muted">{t.speaker}</span>
                <span>{t.text}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      <p className="mt-5 text-xs stage-muted">A ligação termina sozinha no tempo máximo combinado. Nada é aceito sem você.</p>
    </section>
  );
}

function BlockedPanel({ b }: { b: NonNullable<TaskPresentation["blocked"]> }) {
  return (
    <section aria-label="Ligação não permitida agora" className="mt-5 rounded-2xl border border-line bg-surface p-5">
      <p className="text-lg font-semibold tracking-tight">{b.title}</p>
      <p className="mt-1 text-[15px] text-ink-2">{b.body}</p>
      {b.usage ? (
        <div className="mt-4">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-muted">{b.usage.label}</span>
            <span className="num">{b.usage.value}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(b.usage.ratio * 100)} aria-label={b.usage.label}>
            <div className="h-full rounded-full bg-warn" style={{ width: `${Math.max(2, b.usage.ratio * 100)}%` }} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Questions({ qs }: { qs: string[] }) {
  return (
    <section aria-label="O que falta" className="mt-5 rounded-2xl border border-line bg-surface p-5">
      <ul className="grid gap-2 text-[15px]">
        {qs.map((q, i) => (
          <li key={i} className="flex gap-2.5">
            <span aria-hidden className="text-faint">
              ?
            </span>
            {q}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-muted">Responda com o pedido completo e eu sigo daí.</p>
    </section>
  );
}

const TONE = {
  success: { mark: "✓", ring: "bg-accent-soft text-accent-ink" },
  partial: { mark: "↺", ring: "bg-warn-soft text-warn" },
  needs_you: { mark: "!", ring: "bg-warn-soft text-warn" },
  failure: { mark: "·", ring: "bg-surface-2 text-ink-2" },
  neutral: { mark: "–", ring: "bg-surface-2 text-muted" },
} as const;

function ResultPanel({ p }: { p: TaskPresentation }) {
  const r = p.result!;
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <section aria-label="Resultado" className="mt-5 rounded-2xl border border-line bg-surface">
      <div className="flex items-start gap-4 p-5">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-lg font-semibold ${TONE[r.tone].ring}`} aria-hidden>
          {TONE[r.tone].mark}
        </span>
        <div className="min-w-0">
          <p className="text-xl font-semibold tracking-tight">{r.headline}</p>
          {r.channel || r.simulated ? (
            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted">
              {r.tone === "success" && r.channel ? <span>Confirmado {r.channel}</span> : null}
              {r.simulated ? <SimulationTag /> : null}
            </p>
          ) : null}
        </div>
      </div>
      {r.facts.length ? (
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-px border-t border-line-2 bg-line-2">
          {r.facts.map((f) => (
            <div key={f.label} className="bg-surface px-5 py-3">
              <dt className="text-xs text-muted">{f.label}</dt>
              <dd className="num mt-0.5 text-[15px]">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {r.whatHappened || r.next ? (
        <div className="grid gap-3 border-t border-line-2 px-5 py-4 text-[15px]">
          {r.whatHappened ? (
            <div>
              <p className="eyebrow">O que aconteceu</p>
              <p className="mt-1 text-ink-2">{r.whatHappened}</p>
            </div>
          ) : null}
          {r.next ? (
            <div>
              <p className="eyebrow">Próximo passo</p>
              <p className="mt-1 text-ink-2">{r.next}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {p.call?.transcript.length || r.cost ? (
      <div className="flex flex-wrap items-center gap-3 border-t border-line-2 px-5 py-3 text-sm">
        {p.call?.transcript.length ? (
          <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((x) => !x)} className="font-medium text-accent-ink hover:underline">
            {open ? "Esconder detalhes" : "Ver detalhes"}
          </button>
        ) : null}
        {r.cost ? (
          <span className="ml-auto num text-xs text-muted">
            custo estimado {r.cost}
            {r.simulated ? " · simulação, nada cobrado" : ""}
          </span>
        ) : null}
      </div>
      ) : null}
      {open && p.call ? (
        <ol id={detailsId} className="grid gap-2 border-t border-line-2 px-5 py-4 text-sm">
          {p.call.transcript.map((t, i) => (
            <li key={i} className="grid grid-cols-[3.5rem_1fr] gap-2">
              <span className="text-muted">{t.speaker}</span>
              <span>{t.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs" aria-label="Etapas">
      {steps.map((s) => (
        <li key={s.label} className={`flex items-center gap-1.5 ${s.status === "pending" || s.status === "skipped" ? "text-faint" : "text-ink-2"}`} aria-current={s.status === "current" ? "step" : undefined}>
          <span
            aria-hidden
            className={`grid h-4 w-4 place-items-center rounded-full text-[9px] ${
              s.status === "done" ? "bg-accent text-bg" : s.status === "current" ? "border border-accent" : s.status === "failed" ? "bg-surface-2 text-muted" : "border border-line"
            }`}
          >
            {s.status === "done" ? "✓" : s.status === "failed" ? "×" : ""}
          </span>
          <span className={s.status === "skipped" ? "line-through decoration-line" : ""}>{s.label}</span>
          <span className="sr-only">{{ done: "feito", current: "em andamento", pending: "a fazer", failed: "interrompido", skipped: "não aconteceu" }[s.status]}</span>
        </li>
      ))}
    </ol>
  );
}

/** Stops the whole task (the run). Only offered before anything was approved; Wendy re-checks. */
function CancelTask({ id, onDone }: { id: string; onDone: () => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line-2 pt-3">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await cancelExecution(id);
            if (!r.ok) setError(r.error);
            onDone();
          })
        }
        className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline disabled:opacity-50"
      >
        {pending ? "Cancelando…" : "Cancelar esta tarefa"}
      </button>
      {error ? (
        <span className="text-sm text-bad" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

// ── the object ──────────────────────────────────────────────────────────────────────────

export function TaskObject({
  initial,
  live = true,
  interactive = true,
  compact = false,
  onChange,
}: {
  initial: ExecutionView;
  live?: boolean;
  interactive?: boolean;
  compact?: boolean;
  /** Told when the task's state changes (the desk's presence follows the live task). */
  onChange?: (p: TaskPresentation) => void;
}) {
  const { p, reload } = useLiveExecution(initial, live);
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (told.current === p.state) return;
    told.current = p.state;
    onChange?.(p);
  }, [p, onChange]);
  const titleId = useId();
  return (
    <article aria-labelledby={titleId} data-state={p.state} className={`card ${compact ? "my-2 p-4" : "p-5 sm:p-7"}`}>
      <header className="flex items-start gap-4">
        <WendyPresence state={p.presence} size="sm" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Ligação{p.terminal ? "" : " · em andamento"}</p>
          <h3 id={titleId} className={`mt-1 font-semibold tracking-tight ${compact ? "text-lg" : "text-xl sm:text-2xl"}`}>
            {p.title}
          </h3>
          {p.subtitle ? <p className="mt-0.5 text-sm text-muted">{p.subtitle}</p> : null}
        </div>
      </header>
      {/* The state in words: what screen readers announce when it changes. */}
      {/* When a result is shown its title says it; the line stays for screen readers only. */}
      <p className={p.result ? "sr-only" : `mt-4 font-medium ${compact ? "text-[15px]" : "text-lg"}`} role="status" aria-live="polite">
        {p.line}
      </p>
      {p.approval ? <ApprovalPanel a={p.approval} onDecided={() => void reload()} interactive={interactive && live} /> : null}
      {p.inCall ? <LiveCall p={p} live={live} /> : null}
      {p.blocked ? <BlockedPanel b={p.blocked} /> : null}
      {p.questions.length ? <Questions qs={p.questions} /> : null}
      {p.result ? <ResultPanel p={p} /> : null}
      <Timeline steps={p.timeline} />
      {p.cancellable && interactive && live ? <CancelTask id={initial.id} onDone={() => void reload()} /> : null}
    </article>
  );
}
