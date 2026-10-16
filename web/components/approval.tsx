"use client";
import { useId, useState, useTransition } from "react";
import { approveAction, rejectAction } from "@/lib/actions";
import { ActionsOffNote, useActionsOffReason } from "./agent-availability";
import type { DetailAction } from "@/lib/wendy";

/** An e-mail Wendy prepared: approve as is, edit then approve, or reject (with a reason she learns from). */
export function ApprovalCard({ a }: { a: DetailAction }) {
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [subject, setSubject] = useState(a.content.subject ?? "");
  const [body, setBody] = useState(a.content.body ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const off = useActionsOffReason(); // set only when the environment says the agent is off
  const noteId = useId();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    if (off) return; // the controls are disabled; this also covers a stale or programmatic call
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Não foi possível concluir.");
    });
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-2 px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-warn" aria-hidden />
          <span className="font-medium">E-mail aguardando sua aprovação</span>
        </div>
        {a.expires_at ? <span className="text-xs text-muted">expira {new Date(a.expires_at).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span> : null}
      </div>
      <div className="px-6 py-5">
        <p className="text-sm text-muted">
          Para <span className="text-ink">{(a.content.to ?? []).join(", ")}</span>
        </p>
        {mode === "edit" ? (
          <div className="mt-3 grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-muted">Assunto</span>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={500} className="rounded-xl border border-line bg-surface-2 px-3 py-2 outline-none focus:border-accent" />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted">Mensagem</span>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} maxLength={20000} className="rounded-xl border border-line bg-surface-2 px-3 py-2 leading-relaxed outline-none focus:border-accent" />
            </label>
          </div>
        ) : (
          <>
            <p className="mt-2 font-semibold">{a.content.subject}</p>
            <p className="mt-2 whitespace-pre-wrap leading-relaxed text-ink-2">{a.content.body}</p>
          </>
        )}
        {mode === "reject" ? (
          <label className="mt-4 grid gap-1 text-sm">
            <span className="text-muted">Por que rejeitar? (opcional — a Wendy aprende com isso)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} className="rounded-xl border border-line bg-surface-2 px-3 py-2 outline-none focus:border-accent" placeholder="Ex.: não é o momento; prefiro ligar" />
          </label>
        ) : null}
        {error ? <p className="mt-4 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad" role="alert">{error}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line-2 bg-surface-2/50 px-6 py-4">
        {mode === "view" ? (
          <>
            <button type="button" disabled={pending || !!off} aria-describedby={off ? noteId : undefined} onClick={() => run(() => approveAction(a.id))} className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-bg disabled:opacity-50">
              {pending ? "Enviando…" : "Aprovar e enviar"}
            </button>
            <button type="button" disabled={pending || !!off} aria-describedby={off ? noteId : undefined} onClick={() => setMode("edit")} className="rounded-full border border-line px-4 py-2 text-sm hover:bg-surface">
              Editar
            </button>
            <button type="button" disabled={pending || !!off} aria-describedby={off ? noteId : undefined} onClick={() => setMode("reject")} className="rounded-full px-4 py-2 text-sm text-muted hover:text-bad">
              Rejeitar
            </button>
          </>
        ) : mode === "edit" ? (
          <>
            <button
              type="button"
              disabled={pending || !!off || !subject.trim() || !body.trim()}
              aria-describedby={off ? noteId : undefined}
              onClick={() => run(() => approveAction(a.id, { subject: subject.trim(), body: body.trim() }))}
              className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-bg disabled:opacity-50"
            >
              {pending ? "Enviando…" : "Aprovar com alterações"}
            </button>
            <button type="button" disabled={pending} onClick={() => setMode("view")} className="rounded-full px-4 py-2 text-sm text-muted hover:text-ink">
              Cancelar
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={pending || !!off} aria-describedby={off ? noteId : undefined} onClick={() => run(() => rejectAction(a.id, reason.trim() || null))} className="rounded-full bg-bad px-4 py-2 text-sm font-medium text-bg disabled:opacity-50">
              {pending ? "Rejeitando…" : "Confirmar rejeição"}
            </button>
            <button type="button" disabled={pending} onClick={() => setMode("view")} className="rounded-full px-4 py-2 text-sm text-muted hover:text-ink">
              Cancelar
            </button>
          </>
        )}
        <ActionsOffNote id={noteId} className="basis-full" />
        <span className="ml-auto text-xs text-faint">Vai para a caixa de saída local — nada é entregue a ninguém nesta fase.</span>
      </div>
    </div>
  );
}
