"use client";
import { CopilotKitCoreErrorCode, UseAgentUpdate, useAgent, useCopilotKit } from "@copilotkit/react-core/v2";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { COMMUNICATION_FAILURE, describeRunFailure } from "@/lib/conversation";
import { deskPresence, toTaskPresentation, type PresenceState, type TaskPresentation } from "@/lib/concierge";
import type { ExecutionView } from "@/lib/wendy";
import { ExecutionCard } from "../execution-card";
import { WendyPresence } from "./presence";
import { TaskObject } from "./task-object";
import { PHASE_LABEL, taskPhase } from "@/lib/taskStatus";
import { useOptionalWorkspace } from "../workspace-context";

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
          <span className="block truncate font-medium">
            <span className="sr-only">{PHASE_LABEL[taskPhase(v)]}: </span>
            {p ? p.title : v.skillName}
          </span>
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

export function ConciergeDesk({ tasks, greeting, dateLabel, unavailableReason }: { tasks: ExecutionView[]; greeting: string; dateLabel: string; unavailableReason?: string }) {
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
  const ws = useOptionalWorkspace();
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
  const deskRun = useRef(false); // also the synchronous one-at-a-time guard: `running` (state) is stale within the same tick
  const lastRequest = useRef("");
  useEffect(() => {
    const sub = copilotkit.subscribe({
      onError: ({ code, error, context }) => {
        if (!deskRun.current || (context?.agentId && context.agentId !== "wendy")) return;
        if (code === CopilotKitCoreErrorCode.AGENT_RUN_FAILED || code === CopilotKitCoreErrorCode.AGENT_RUN_FAILED_EVENT || code === CopilotKitCoreErrorCode.AGENT_RUN_ERROR_EVENT) {
          setError(describeRunFailure({ agentEvent: code === CopilotKitCoreErrorCode.AGENT_RUN_ERROR_EVENT, message: error?.message, runtimeErrorCode: context?.runtimeErrorCode ?? (error as { code?: unknown } | undefined)?.code }));
          setText((t) => t || lastRequest.current); // the failure arrives as an event (no throw): give the request back instead of leaving the field empty
        }
      },
    });
    return () => sub.unsubscribe();
  }, [copilotkit]);

  const delegate = async () => {
    const request = text.trim();
    // One turn at a time on the shared agent (the library itself would start a second, concurrent run).
    if (!request || running || agent.isRunning || deskRun.current || unavailableReason) return;
    deskRun.current = true;
    lastRequest.current = request;
    setError(null);
    setReply(null);
    setRunning(true);
    ws?.beginLive();
    try {
      agent.addMessage({ id: crypto.randomUUID(), role: "user", content: request });
      const sentAt = agent.messages.length; // only what arrives after this request is its reply
      setText("");
      await copilotkit.runAgent({ agent });
      const last = [...agent.messages.slice(sentAt)].reverse().find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim());
      setReply(last ? String(last.content) : null);
      router.refresh(); // the task Wendy created comes back from her runtime
    } catch {
      setError(COMMUNICATION_FAILURE);
      setText(request);
    } finally {
      ws?.endLive();
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
        <h1 id={titleId} className="display mt-3 text-4xl tracking-tight sm:text-6xl">
          {greeting}
        </h1>
        <p className="mt-2 text-lg text-muted sm:text-xl">O que eu resolvo para você?</p>

        {/* One real field at every width. Where the conversation is already a column beside this page (lg+), this is only a way
            into that column's field: same agent, same thread, no second composer to choose between. Below lg the field is real. */}
        <button
          type="button"
          disabled={!!unavailableReason}
          onClick={() => document.querySelector<HTMLTextAreaElement>('section[aria-label="Conversa com a Wendy"] textarea')?.focus()}
          className="card mt-8 hidden min-h-[4.25rem] w-full items-center px-5 text-left text-lead text-faint transition-colors hover:border-accent disabled:opacity-60 lg:flex"
        >
          {unavailableReason ? "Conversa indisponível" : "Peça algo à Wendy…"}
          <span className="sr-only"> — vai para o campo de mensagem da conversa</span>
        </button>
        <form
          className="mt-8 w-full lg:hidden"
          onSubmit={(e) => {
            e.preventDefault();
            void delegate();
          }}
        >
          <label htmlFor={`${titleId}-ask`} className="sr-only">
            Pedido para a Wendy
          </label>
          <div className="card flex flex-col gap-1 p-2 pl-4 text-left focus-within:border-accent sm:flex-row sm:items-end sm:gap-2 sm:pl-5">
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
              placeholder={unavailableReason ? "Delegar indisponível" : "Ex.: liga para o Aprazível e reserva uma mesa para 2 amanhã às 20h"}
              className="max-h-48 min-h-[3.25rem] flex-1 resize-none bg-transparent py-3 text-lead leading-snug outline-none [field-sizing:content] placeholder:text-faint"
              disabled={running || agent.isRunning || !!unavailableReason}
            />
            <button type="submit" disabled={running || agent.isRunning || !text.trim() || !!unavailableReason} className="mb-1 shrink-0 self-end rounded-full bg-ink px-5 py-3 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-40 sm:self-auto">
              {running ? "Cuidando…" : "Delegar"}
            </button>
          </div>
        </form>
        <div className="mt-3 min-h-6 text-sm" role="status" aria-live="polite">
          {unavailableReason ? <span className="text-info">{unavailableReason}</span> : running ? <span className="text-muted">{(step && STEP[step]) || "Deixa comigo…"}</span> : error ? <span className="text-bad">{error}</span> : reply ? <span className="text-ink-2">{reply}</span> : null}
        </div>
      </section>

      {active.length ? (
        <section aria-label="Em andamento" className="mt-10">
          <h2 className="eyebrow mb-3">Em andamento</h2>
          <div className="grid gap-4">
            {active.map((v) => (
              <div key={v.id} id={`tarefa-${v.id}`} className="scroll-mt-20">
                {v.skillId === "voice-concierge" ? <TaskObject initial={v} onChange={onTask} /> : <ExecutionCard initial={v} />}
              </div>
            ))}
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
