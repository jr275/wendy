"use client";
import { useEffect, useState, useTransition } from "react";
import { approveAction, rejectAction } from "@/lib/actions";
import { MemoryRow } from "./memory-row";
import { TaskObject } from "./concierge/task-object";
import { fetchExecution } from "@/lib/live";
import type { ExecutionView } from "@/lib/wendy";

/**
 * A skill run in the chat: what Wendy is doing, what she needs from you, and what came out.
 * The card only displays what Wendy persisted; approving goes through her action state machine.
 */
const STATUS: Record<ExecutionView["status"], { label: string; tone: string }> = {
  queued: { label: "Na fila", tone: "bg-surface-2 text-ink-2" },
  running: { label: "Trabalhando", tone: "bg-info-soft text-info" },
  waiting_child: { label: "Trabalhando", tone: "bg-info-soft text-info" },
  waiting_permission: { label: "Precisa de você", tone: "bg-warn-soft text-warn" },
  completed: { label: "Concluída", tone: "bg-accent-soft text-accent-ink" },
  failed: { label: "Não concluída", tone: "bg-bad-soft text-bad" },
  cancelled: { label: "Cancelada", tone: "bg-surface-2 text-muted" },
};
const KIND: Record<string, string> = { INFERENCE: "Conclusão", HYPOTHESIS: "Hipótese", ANTICIPATION: "Antecipação", RECOMMENDATION: "Recomendação" };
const CATEGORY_NOTE: Record<string, string> = {
  WRITE: "Fica só na sua lista de tarefas; nada é enviado a ninguém.",
  DESTRUCTIVE: "Ação destrutiva: a tarefa sai da sua lista (fica no histórico).",
  EXTERNAL: "Ação externa: sai da Wendy.",
};
const isLive = (v: ExecutionView): boolean => !["completed", "failed", "cancelled"].includes(v.status) || v.children.some(isLive);
const pending = (v: ExecutionView): ExecutionView["approvals"] => [...v.approvals.filter((a) => a.state === "AWAITING_APPROVAL"), ...v.children.flatMap(pending)];

interface Analysis {
  claims: { label: string; kind: string; statement: string; confidence: number; evidence: string[] }[];
  rejectedClaims: number;
  gaps: string[];
  sources: { handle: string; uri: string; title: string | null }[];
  skipped?: { uri: string; reason: string }[];
  path?: string;
  truncated?: boolean;
}

function Approval({ a, onDone }: { a: ExecutionView["approvals"][number]; onDone: () => void }) {
  const [pendingT, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "erro");
      onDone();
    });
  return (
    <div className="rounded-2xl border border-warn/30 bg-warn-soft p-4">
      <p className="text-sm font-medium text-warn">{a.label}?</p>
      {a.items.length ? (
        <ul className="mt-2 grid gap-1 text-sm text-ink">
          {a.items.map((t, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-faint" aria-hidden>
                ○
              </span>
              {t}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-xs text-ink-2">{CATEGORY_NOTE[a.category] ?? ""}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={pendingT} onClick={() => act(() => approveAction(a.actionId))} className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-50">
          Aprovar
        </button>
        <button type="button" disabled={pendingT} onClick={() => act(() => rejectAction(a.actionId, null))} className="rounded-full border border-line bg-surface px-4 py-1.5 text-sm text-ink-2 disabled:opacity-50">
          Recusar
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Findings({ o }: { o: Analysis }) {
  const byHandle = new Map(o.sources.map((s) => [s.handle, s]));
  return (
    <div className="grid gap-3">
      {o.claims.map((c) => (
        <div key={c.label} className="rounded-xl border border-line-2 bg-surface-2/50 p-3">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="rounded-full bg-info-soft px-2 py-0.5 text-info">{KIND[c.kind] ?? c.kind}</span>
            <span className="num text-faint">confiança {c.confidence.toFixed(2)}</span>
          </div>
          <p className="mt-1.5 text-sm leading-relaxed">{c.statement}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {c.evidence.map((h) => {
              const s = byHandle.get(h);
              if (!s) return null;
              const label = s.uri.startsWith("documents:") ? `${s.title ?? "documento"} · trecho ${h.slice(1)}` : (s.title ?? new URL(s.uri).hostname);
              return s.uri.startsWith("http") ? (
                <a key={h} href={s.uri} target="_blank" rel="noopener noreferrer nofollow" className="max-w-full truncate rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-2 hover:border-accent" title={s.uri}>
                  {label} ↗
                </a>
              ) : (
                <span key={h} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-2">
                  {label}
                </span>
              );
            })}
          </div>
        </div>
      ))}
      {o.gaps.length ? (
        <div>
          <p className="eyebrow">O que as fontes não dizem</p>
          <ul className="mt-1 grid gap-1 text-sm text-ink-2">{o.gaps.map((g, i) => <li key={i}>— {g}</li>)}</ul>
        </div>
      ) : null}
      <p className="text-xs text-faint">
        {o.claims.length} afirmaç{o.claims.length === 1 ? "ão comprovada" : "ões comprovadas"}
        {o.rejectedClaims ? ` · ${o.rejectedClaims} descartada${o.rejectedClaims === 1 ? "" : "s"} pela validação` : ""}
        {o.skipped?.length ? ` · ${o.skipped.length} página${o.skipped.length === 1 ? "" : "s"} não pôde ser lida` : ""}
        {o.truncated ? " · documento longo: só o começo foi lido" : ""}
      </p>
    </div>
  );
}

const CATEGORY_PT: Record<string, string> = { work_style: "Como trabalha", preferences: "Preferência", values: "Valores", routines: "Rotina", background: "Trajetória", people: "Pessoas", projects: "Projetos" };

function Result({ v }: { v: ExecutionView }) {
  const o = (v.output ?? {}) as Record<string, unknown>;
  if (v.status === "failed") return <p className="text-sm text-bad">{v.error?.message}</p>;
  if (v.status !== "completed") return null;
  if (v.skillId === "web-research" || v.skillId === "document-analysis") return <Findings o={o as unknown as Analysis} />;
  if (v.skillId === "learn-about-me") {
    const proposed = (o.proposed as { memoryId: string | null; statement: string; quote: string; category: string }[]) ?? [];
    return (
      <div>
        <ul className="grid gap-2">{proposed.map((p, i) => <MemoryRow key={p.memoryId ?? i} id={p.memoryId} status="PROPOSED" tag={CATEGORY_PT[p.category] ?? p.category} content={`${p.statement} — "${p.quote}" ()`} />)}</ul>
        <p className="mt-2 text-xs text-faint">
          Fonte: {(o.source as { title: string | null })?.title ?? "—"}
          {(o.source as { date: string | null })?.date ? ` · ${(o.source as { date: string }).date}` : ""}
          {o.droppedSensitive ? ` · ${o.droppedSensitive} ponto(s) sensível(is) deixado(s) de fora` : ""}
          {o.droppedUnquoted ? ` · ${o.droppedUnquoted} sem citação exata descartado(s)` : ""}
        </p>
      </div>
    );
  }
  if (v.skillId === "task-management") {
    const tasks = (o.tasks as { title: string }[]) ?? [];
    return (
      <div>
        <p className="text-sm">{o.status === "declined" ? "Nada foi alterado." : tasks.length ? "Suas tarefas:" : "Nenhuma tarefa em aberto."}</p>
        <ul className="mt-1 grid gap-1 text-sm">
          {tasks.map((t, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className={o.operation === "list" ? "text-faint" : "text-accent"}>
                {o.operation === "list" ? "○" : "✓"}
              </span>
              {t.title}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return null;
}

export function ExecutionCard({ initial }: { initial: ExecutionView }) {
  // A call is a delegated task, not a generic skill card: it gets the concierge task object.
  if (initial.skillId === "voice-concierge") return <TaskObject initial={initial} compact />;
  return <SkillCard initial={initial} />;
}

function SkillCard({ initial }: { initial: ExecutionView }) {
  const [v, setV] = useState(initial);
  const reload = async () => {
    const next = await fetchExecution(v.id);
    if (next) setV(next);
  };
  useEffect(() => {
    if (!isLive(v)) return;
    const t = setInterval(() => void fetchExecution(v.id).then((n) => n && setV(n)), 2500);
    return () => clearInterval(t);
  }, [v]);

  const asks = pending(v);
  const status = asks.length ? STATUS.waiting_permission : STATUS[v.status];
  const notClaude = v.models.some((m) => !m.startsWith("claude-"));
  const research = v.children.filter((c) => c.skillId === "web-research" || c.skillId === "document-analysis");

  return (
    <article className="my-2 rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">Habilidade</span>
        <span className="text-sm font-medium">{v.skillName}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] ${status.tone}`}>{status.label}</span>
        {notClaude ? <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">não é o Claude</span> : null}
      </div>

      <ol className="mt-3 grid gap-1 text-xs" aria-label="Etapas">
        {[...v.steps, ...v.children.flatMap((c) => c.steps.map((s) => ({ ...s, id: `${c.id}:${s.id}` })))]
          .filter((s, i, all) => all.findIndex((x) => x.label === s.label) === i)
          .map((s) => (
            <li key={s.id} className={`flex items-center gap-2 ${s.status === "pending" ? "text-faint" : "text-ink-2"}`}>
              <span aria-hidden className={s.status === "done" ? "text-accent" : s.status === "failed" ? "text-bad" : s.status === "waiting" ? "text-warn" : ""}>
                {s.status === "done" ? "✓" : s.status === "failed" ? "×" : s.status === "running" ? "•" : s.status === "waiting" ? "…" : "○"}
              </span>
              {s.label}
            </li>
          ))}
      </ol>

      {asks.length ? (
        <div className="mt-3 grid gap-2">
          {asks.map((a) => (
            <Approval key={a.actionId} a={a} onDone={() => void reload()} />
          ))}
        </div>
      ) : null}

      {research.map((c) =>
        c.status === "completed" ? (
          <div key={c.id} className="mt-3">
            <Findings o={c.output as Analysis} />
          </div>
        ) : null,
      )}
      <div className="mt-3">
        <Result v={v} />
      </div>
    </article>
  );
}
