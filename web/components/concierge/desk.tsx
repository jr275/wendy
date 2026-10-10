"use client";
import { CopilotKitCoreErrorCode, UseAgentUpdate, useAgent, useCopilotKit } from "@copilotkit/react-core/v2";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { deskPresence, toTaskPresentation, type PresenceState, type TaskPresentation } from "@/lib/concierge";
import type { ExecutionView } from "@/lib/wendy";
import { ExecutionCard } from "../execution-card";
import { WendyPresence } from "./presence";
import { TaskObject } from "./task-object";

/**
 * The concierge desk: where the principal delegates. Wendy's presence, one field ("O que eu
 * resolvo para você?"), then the tasks — active ones as live objects, recent ones as results.
 * The field sends a message to the same agent and the same conversation as the chat (nothing
 * parallel); the task it creates comes from Wendy's runtime, read back from the server.
 */
const STEP: Record<string, string> = {
  entendendo: "Entendendo o pedido…",
  executando: "Cuidando disso…",
  raciocinando: "Conferindo nos seus registros…",
  montando: "Organizando a resposta…",
};
const isOver = (v: ExecutionView) => ["completed", "failed", "cancelled"].includes(v.status);

function RecentRow({ v }: { v: ExecutionView }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const p = v.skillId === "voice-concierge" ? toTaskPresentation(v) : null;
  const mark = p?.result?.tone === "success" ? "✓" : p?.result?.tone === "failure" ? "·" : p ? "!" : v.status === "completed" ? "✓" : "·";
  return (
    <li>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((x) => !x)} className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-surface-2">
        <span aria-hidden className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm ${p?.result?.tone === "success" || (!p && v.status === "completed") ? "bg-accent-soft text-accent-ink" : "bg-surface-2 text-muted"}`}>
          {mark}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{p ? p.title : v.skillName}</span>
          <span className="block truncate text-sm text-muted">{p ? [p.subtitle, p.line].filter(Boolean).join(" — ") : new Date(v.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
        </span>
        <span aria-hidden className={`text-faint transition-transform ${open ? "rotate-90" : ""}`}>
          ›
        </span>
      </button>
      {open ? <div id={id} className="px-3 pb-3 sm:px-5">{p ? <TaskObject initial={v} live={false} interactive={false} compact /> : <ExecutionCard initial={v} />}</div> : null}
    </li>
  );
}

export function ConciergeDesk({ tasks, greeting, dateLabel }: { tasks: ExecutionView[]; greeting: string; dateLabel: string }) {
  const router = useRouter();
  // Re-render on run status: the conversation beside the desk drives the same agent.
  const { agent } = useAgent({ agentId: "wendy", updates: [UseAgentUpdate.OnRunStatusChanged] });
  const { copilotkit } = useCopilotKit();
  const [text, setText] = useState("");
  const [composing, setComposing] = useState(false);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, TaskPresentation>>({});
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();

  // A task that finishes while on screen stays where it is and turns into its result.
  const active = tasks.filter((v) => !isOver(v) || v.id in live);
  const recent = tasks.filter((v) => !active.includes(v)).slice(0, 5);

  const presentations = useMemo(() => tasks.filter((v) => v.skillId === "voice-concierge").map((v) => live[v.id] ?? toTaskPresentation(v)), [tasks, live]);
  const presence: PresenceState = deskPresence(presentations, running, composing || text.length > 0);
  const onTask = useCallback((p: TaskPresentation) => setLive((m) => (m[p.id]?.state === p.state ? m : { ...m, [p.id]: p })), []);

  useEffect(() => {
    const sub = agent.subscribe({
      onStepStartedEvent: ({ event }) => setStep(event.stepName),
      onRunFinishedEvent: () => setStep(null),
      onRunErrorEvent: () => setStep(null),
    });
    return () => sub.unsubscribe();
  }, [agent]);

  // Run failures arrive as CopilotKit error events (runAgent does not throw on them); shown only for
  // the run this field started, so an error from the conversation beside it is not repeated here.
  const deskRun = useRef(false);
  useEffect(() => {
    const sub = copilotkit.subscribe({
      onError: ({ code, context }) => {
        if (!deskRun.current || (context?.agentId && context.agentId !== "wendy")) return;
        if (code === CopilotKitCoreErrorCode.AGENT_RUN_FAILED || code === CopilotKitCoreErrorCode.AGENT_RUN_FAILED_EVENT || code === CopilotKitCoreErrorCode.AGENT_RUN_ERROR_EVENT)
          setError("A Wendy não respondeu agora. Tente de novo em instantes.");
      },
    });
    return () => sub.unsubscribe();
  }, [copilotkit]);

  const delegate = async () => {
    const request = text.trim();
    // One turn at a time on the shared agent (the library itself would start a second, concurrent run).
    if (!request || running || agent.isRunning) return;
    setError(null);
    setReply(null);
    setRunning(true);
    deskRun.current = true;
    try {
      agent.addMessage({ id: crypto.randomUUID(), role: "user", content: request });
      const sentAt = agent.messages.length; // only what arrives after this request is its reply
      setText("");
      await copilotkit.runAgent({ agent });
      const last = [...agent.messages.slice(sentAt)].reverse().find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim());
      setReply(last ? String(last.content) : null);
      router.refresh(); // the task Wendy created comes back from her runtime
    } catch {
      setError("A Wendy não respondeu agora. Tente de novo em instantes.");
      setText(request);
    } finally {
      deskRun.current = false;
      setRunning(false);
      setStep(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
      <section aria-labelledby={titleId} className="flex flex-col items-center pt-10 text-center sm:pt-16">
        <WendyPresence state={presence} size="lg" />
        <p className="eyebrow mt-6">{dateLabel}</p>
        <h1 id={titleId} className="mt-3 text-3xl font-semibold tracking-tight sm:text-5xl">
          {greeting}
        </h1>
        <p className="mt-2 text-lg text-muted sm:text-xl">O que eu resolvo para você?</p>

        <form
          className="mt-8 w-full"
          onSubmit={(e) => {
            e.preventDefault();
            void delegate();
          }}
        >
          <label htmlFor={`${titleId}-ask`} className="sr-only">
            Pedido para a Wendy
          </label>
          <div className="card flex items-end gap-2 p-2 pl-5 text-left focus-within:border-accent">
            <textarea
              id={`${titleId}-ask`}
              ref={inputRef}
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onFocus={() => setComposing(true)}
              onBlur={() => setComposing(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void delegate();
                }
              }}
              placeholder="Ex.: liga para o Aprazível e reserva uma mesa para 2 amanhã às 20h"
              className="min-h-[3.25rem] flex-1 resize-none bg-transparent py-3 text-[17px] leading-snug outline-none placeholder:text-faint"
              disabled={running || agent.isRunning}
            />
            <button type="submit" disabled={running || agent.isRunning || !text.trim()} className="mb-1 shrink-0 rounded-full bg-ink px-5 py-3 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
              {running ? "Cuidando…" : "Delegar"}
            </button>
          </div>
        </form>
        <div className="mt-3 min-h-6 text-sm" role="status" aria-live="polite">
          {running ? <span className="text-muted">{(step && STEP[step]) || "Deixa comigo…"}</span> : error ? <span className="text-bad">{error}</span> : reply ? <span className="text-ink-2">{reply}</span> : null}
        </div>
      </section>

      {active.length ? (
        <section aria-label="Em andamento" className="mt-10">
          <h2 className="eyebrow mb-3">Em andamento</h2>
          <div className="grid gap-4">
            {active.map((v) => (v.skillId === "voice-concierge" ? <TaskObject key={v.id} initial={v} onChange={onTask} /> : <ExecutionCard key={v.id} initial={v} />))}
          </div>
        </section>
      ) : null}

      {recent.length ? (
        <section aria-label="Recentes" className="mt-10">
          <h2 className="eyebrow mb-3">Recentes</h2>
          <ul className="card divide-y divide-line-2 overflow-hidden">
            {recent.map((v) => (
              <RecentRow key={v.id} v={v} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
