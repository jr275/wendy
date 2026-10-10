"use client";
import {
  CopilotKitCoreErrorCode,
  CopilotKitCoreRuntimeConnectionStatus,
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
  useRenderToolCall,
} from "@copilotkit/react-core/v2";
import { useEffect, useId, useRef, useState } from "react";
import { fetchExecution } from "@/lib/live";
import type { ExecutionView } from "@/lib/wendy";
import { conversationItems, conversationStatus, type AgUiMessage } from "@/lib/conversation";
import { STEPS, useWendyChat } from "../wendy-chat";
import { EmotionalPresence } from "./character-presence";
import { SafeMarkdown } from "./markdown";
import { MoodControl } from "./mood-control";
import { useMoodPresentation } from "./use-mood-presentation";

/**
 * The home conversation, built on CopilotKit's headless hooks (Emotional Concierge, phase 1).
 * Same agent ("wendy"), same thread ("main"), same messages: on mount it connects the way the
 * default chat did, which replays the conversation Wendy keeps in her database. Wendy's cards are
 * the renderers already registered by useWendyChat (show_answer / show_site / show_execution).
 * Answers arrive whole — Wendy validates every claim before sending — so there is no token stream
 * to show; the run's steps and cards arrive as they happen.
 */
const RUN_FAILURES: readonly string[] = [CopilotKitCoreErrorCode.AGENT_RUN_FAILED, CopilotKitCoreErrorCode.AGENT_RUN_FAILED_EVENT, CopilotKitCoreErrorCode.AGENT_RUN_ERROR_EVENT];

const needsYou = (v: ExecutionView): boolean => v.approvals.some((a) => a.state === "AWAITING_APPROVAL") || v.children.some(needsYou);

/**
 * True while one of the latest runs shown in this conversation really has an approval waiting
 * (read from Wendy's persisted state, never inferred from the card text). Presentation only.
 */
function useAwaitingApproval(items: ReturnType<typeof conversationItems>): boolean {
  const ids = items
    .filter((it) => it.kind === "card" && it.name === "show_execution")
    .slice(-3)
    .map((it) => {
      try {
        return (JSON.parse((it as { toolCall: { function: { arguments: string } } }).toolCall.function.arguments) as { id?: string }).id;
      } catch {
        return undefined;
      }
    })
    .filter((id): id is string => typeof id === "string");
  const key = ids.join(",");
  const [awaiting, setAwaiting] = useState(false);
  useEffect(() => {
    if (!key) return;
    let gone = false;
    const check = async () => {
      const views = await Promise.all(key.split(",").map((id) => fetchExecution(id).catch(() => null)));
      if (!gone) setAwaiting(views.some((v) => !!v && needsYou(v)));
    };
    void check();
    const t = setInterval(() => void check(), 3000);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [key]);
  return !!key && awaiting;
}

/** The thread is pinned by the chat configuration around this component (workspace.tsx: threadId "main"). */
export function ConciergeConversation({ suggestions }: { suggestions: string[] }) {
  const step = useWendyChat(suggestions); // registers Wendy's card renderers; reports the run's step
  const { agent } = useAgent({ agentId: "wendy", updates: [UseAgentUpdate.OnMessagesChanged, UseAgentUpdate.OnRunStatusChanged, UseAgentUpdate.OnStateChanged] });
  const { copilotkit } = useCopilotKit();
  const renderToolCall = useRenderToolCall();
  const [connected, setConnected] = useState(false);
  const [connectFailed, setConnectFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [text, setText] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const sending = useRef(false);
  const inputId = useId();

  // Restore the conversation (thread "main", from the configuration), once the runtime is ready.
  useEffect(() => {
    let gone = false;
    let sub: { unsubscribe: () => void } | undefined;
    const connect = async () => {
      try {
        await copilotkit.connectAgent({ agent });
        if (!gone) setConnected(true);
      } catch {
        if (!gone) setConnectFailed(true);
      }
    };
    if (copilotkit.runtimeConnectionStatus === CopilotKitCoreRuntimeConnectionStatus.Connected) void connect();
    else
      sub = copilotkit.subscribe({
        onRuntimeConnectionStatusChanged: ({ status }) => {
          if (status === CopilotKitCoreRuntimeConnectionStatus.Connected) {
            sub?.unsubscribe();
            void connect();
          } else if (status === CopilotKitCoreRuntimeConnectionStatus.Error && !gone) setConnectFailed(true);
        },
      });
    return () => {
      gone = true;
      sub?.unsubscribe();
    };
  }, [agent, copilotkit]);

  // CopilotKit 1.77 reports connect / run failures as events (it does not throw), so they are
  // listened to here — otherwise an unavailable history would look like an empty conversation.
  useEffect(() => {
    const sub = copilotkit.subscribe({
      onError: ({ code, error, context }) => {
        if (context?.agentId && context.agentId !== "wendy") return;
        if (code === CopilotKitCoreErrorCode.AGENT_CONNECT_FAILED) setConnectFailed(true);
        // A failed connect also emits run-failure codes: only a run this conversation started is a send error.
        // When the agent itself reports the failure (RUN_ERROR) its message is already a short pt-BR sentence
        // written for the principal (src/agent/errors.ts); otherwise the generic one.
        else if (RUN_FAILURES.includes(code) && sending.current)
          setError(code === CopilotKitCoreErrorCode.AGENT_RUN_ERROR_EVENT && error?.message ? `${error.message.slice(0, 300)} Sua mensagem ficou na conversa.` : "A Wendy não respondeu agora. Sua mensagem ficou na conversa; tente de novo em instantes.");
      },
    });
    return () => sub.unsubscribe();
  }, [copilotkit]);

  // Not memoized on the array: AG-UI's addMessage mutates agent.messages in place (same reference),
  // so a memo would hide the principal's own message until the reply's first event. Cheap to recompute.
  const items = conversationItems(agent.messages as unknown as AgUiMessage[]);
  const running = agent.isRunning;
  const status = conversationStatus({ connected, connectFailed, running, error, items: items.length });
  // Mood (a transient reading Wendy sends as agent state) and the interaction state are separate things.
  const awaiting = useAwaitingApproval(items);
  const { selection, interaction, reading, prefs, setPrefs, onCorrect } = useMoodPresentation((agent.state as { mood?: unknown } | undefined)?.mood, { running, step, failed: !!error, awaiting });

  // Follow new messages only when the principal is already at the bottom (never yank the reading position).
  useEffect(() => {
    const el = logRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [items.length, running]);

  const send = async (request: string) => {
    const msg = request.trim();
    if (!msg || agent.isRunning) return;
    setError(null);
    setStopped(false);
    atBottom.current = true;
    agent.addMessage({ id: crypto.randomUUID(), role: "user", content: msg });
    setText("");
    sending.current = true;
    try {
      await copilotkit.runAgent({ agent });
    } catch {
      setError("A Wendy não respondeu agora. Sua mensagem ficou na conversa; tente de novo em instantes.");
    } finally {
      sending.current = false;
    }
  };

  const stop = () => {
    copilotkit.stopAgent({ agent });
    setStopped(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[60px] shrink-0 items-center justify-between gap-3 px-4">
        <EmotionalPresence selection={selection} interaction={interaction} />
        <MoodControl selection={selection} reading={reading} prefs={prefs} onPrefs={setPrefs} onCorrect={onCorrect} />
      </div>
      <div
        ref={logRef}
        role="log"
        aria-label="Conversa com a Wendy"
        aria-live="polite"
        aria-relevant="additions"
        aria-busy={status === "connecting" || status === "running"}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2"
      >
        {status === "connecting" ? (
          <div className="grid gap-3 py-6" aria-label="Carregando a conversa">
            <div className="h-3 w-2/3 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
          </div>
        ) : null}

        {status === "empty" || (connectFailed && !items.length) ? (
          <div className="py-8">
            <p className="text-[15px] text-ink-2">{connectFailed ? "Não consegui carregar a conversa anterior. Você pode escrever mesmo assim." : "O que você quer saber ou delegar hoje?"}</p>
            {suggestions.length ? (
              <ul className="mt-4 flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <li key={s}>
                    <button type="button" onClick={() => void send(s)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm text-ink-2 hover:border-accent hover:text-ink">
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <ol className="grid gap-3">
          {items.map((it) =>
            it.kind === "user" ? (
              <li key={it.id} className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-[15px] leading-snug text-bg">
                  <span className="sr-only">Você: </span>
                  {it.text}
                </p>
              </li>
            ) : it.kind === "assistant" ? (
              <li key={it.id} className="wendy-answer max-w-full text-[15px] leading-relaxed text-ink">
                <span className="sr-only">Wendy: </span>
                <SafeMarkdown content={it.text} />
              </li>
            ) : (
              <li key={it.id} className="min-w-0">
                {renderToolCall({ toolCall: it.toolCall as never, toolMessage: it.toolMessage as never })}
              </li>
            ),
          )}
        </ol>

        {status === "running" ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-muted" role="status">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none" aria-hidden />
            {(step && STEPS[step]) ?? "Cuidando disso"}…
          </p>
        ) : null}
        {stopped && !running ? (
          <p className="mt-3 text-sm text-muted" role="status">
            Parei de esperar a resposta aqui. Se uma tarefa já começou, ela aparece no cartão dela — e pode ser cancelada lá enquanto nada foi aprovado.
          </p>
        ) : null}
        {error ? (
          <p className="mt-3 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <form
        className="border-t border-line/70 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Mensagem para a Wendy
        </label>
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-1.5 pl-4 focus-within:border-accent">
          <textarea
            id={inputId}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(text);
              }
            }}
            placeholder="Pergunte ou peça algo à Wendy…"
            className="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent py-2 text-[15px] outline-none placeholder:text-faint"
          />
          {running ? (
            <button type="button" onClick={stop} className="shrink-0 rounded-full border border-line px-4 py-2 text-sm text-ink-2 hover:bg-surface-2">
              Parar
            </button>
          ) : (
            <button type="submit" disabled={!text.trim()} className="shrink-0 rounded-full bg-ink px-4 py-2 text-sm font-medium text-bg disabled:opacity-40">
              Enviar
            </button>
          )}
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-faint">Cada afirmação é validada contra registros reais · nada é enviado sem sua aprovação</p>
      </form>
    </div>
  );
}
