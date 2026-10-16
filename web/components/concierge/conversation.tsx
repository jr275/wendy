"use client";
import {
  CopilotKitCoreErrorCode,
  CopilotKitCoreRuntimeConnectionStatus,
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
  useRenderToolCall,
} from "@copilotkit/react-core/v2";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { fetchExecution } from "@/lib/live";
import type { ExecutionView } from "@/lib/wendy";
import { COMMUNICATION_FAILURE, conversationItems, conversationStatus, describeRunFailure, unansweredUserText, type AgUiMessage } from "@/lib/conversation";
import { SeeingChip, STEPS, useWendyChat } from "../wendy-chat";
import { useOptionalWorkspace } from "../workspace-context";
import { EmotionalPresence } from "./character-presence";
import { SafeMarkdown } from "./markdown";
import { MoodControl } from "./mood-control";
import { useMoodPresentation } from "./use-mood-presentation";
import { useVoiceConversation } from "./use-voice-conversation";
import { MicButton, VoicePanel } from "./voice-controls";

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
/**
 * `trail` is the container's own control (the Conversa/Painel switch, or the drawer's close button); it
 * shares the one header row with the presence and the character control, so there is no second title bar.
 * `unavailableReason`: set only when the server KNOWS this conversation cannot process messages (the demo mode,
 * WENDY_DEMO). The history stays readable, nothing can be sent, and the reason is said before any attempt.
 * Unset means "not known", never "available".
 */
export function ConciergeConversation({ suggestions, trail, headerClassName = "", unavailableReason }: { suggestions: string[]; trail?: React.ReactNode; headerClassName?: string; unavailableReason?: string }) {
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
  const lastAuto = useRef(0); // when WE last moved the scroll: the scroll events it causes are not the principal's
  const toBottom = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    lastAuto.current = performance.now();
    el.scrollTop = el.scrollHeight;
  }, []);
  const sending = useRef(false);
  const inputId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ws = useOptionalWorkspace(); // present on Hoje: lets a live answer take the "Em foco" panel

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
        // What to say depends on who spoke (describeRunFailure): the agent's own pt-BR sentence, or an honest
        // "no confirmation" when it was the runtime that failed to reach the agent (its raw text is never shown).
        else if (RUN_FAILURES.includes(code) && sending.current)
          setError(describeRunFailure({ agentEvent: code === CopilotKitCoreErrorCode.AGENT_RUN_ERROR_EVENT, message: error?.message, runtimeErrorCode: context?.runtimeErrorCode ?? (error as { code?: unknown } | undefined)?.code }));
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
    if (atBottom.current) toBottom();
  }, [items.length, running, toBottom]);

  // The failure and "stopped" notices are appended after the messages and are the direct result of what the principal
  // just sent, so they always come into view.
  useEffect(() => {
    if (!(error || stopped)) return;
    atBottom.current = true;
    toBottom();
  }, [error, stopped, running, toBottom]);

  // Keep following while the content GROWS after the first scroll (cards, tables and Markdown finish rendering a moment
  // later), and when the box itself gets a size: the conversation is mounted while hidden (the Painel mode on Hoje, the
  // closed drawer elsewhere), where scrolling does nothing, so it used to open at the oldest message or half way down.
  // Only while the principal has not scrolled away.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const follow = () => {
      if (atBottom.current) toBottom();
    };
    const mo = new MutationObserver(follow);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
    ro?.observe(el);
    return () => {
      mo.disconnect();
      ro?.disconnect();
    };
  }, [toBottom]);

  // The history could not be restored (connection failed): try once more, on request.
  const reconnect = async () => {
    setConnectFailed(false);
    try {
      await copilotkit.connectAgent({ agent });
      setConnected(true);
    } catch {
      setConnectFailed(true);
    }
  };

  /** Resolves true when the message was sent and its run finished, false when it was refused (nothing sent). `opts.id` lets voice know which message it sent. */
  const send = async (request: string, opts?: { id?: string }): Promise<boolean> => {
    const msg = request.trim();
    // `sending` is the synchronous guard: agent.isRunning only flips after the run starts, so Enter + click (or a
    // double click) in the same moment used to add the message and start the run several times.
    if (!msg || agent.isRunning || sending.current || unavailableReason) return false;
    sending.current = true;
    setError(null);
    setStopped(false);
    atBottom.current = true;
    agent.addMessage({ id: opts?.id ?? crypto.randomUUID(), role: "user", content: msg });
    setText("");
    ws?.beginLive();
    try {
      await copilotkit.runAgent({ agent });
    } catch {
      setError(COMMUNICATION_FAILURE);
    } finally {
      ws?.endLive();
      sending.current = false;
    }
    return true;
  };

  // After a failed turn the principal's message is still on screen: hand its text back to the composer to be
  // edited and sent as a NEW message (a blind re-run could start a second task; see unansweredUserText).
  const resendText = error && !running ? unansweredUserText(items) : null;
  const resend = () => {
    if (!resendText) return;
    setText(resendText);
    setError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const stop = () => {
    copilotkit.stopAgent({ agent });
    setStopped(true);
  };

  // Voice: the same conversation, the same send. A transcript is reviewed in the composer and sent like any typed message.
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  const voice = useVoiceConversation({ send, stopRun: stop, items, error, running, getText: () => textRef.current, setText });
  // A reviewed transcript goes through the voice session (so Wendy's answer to THAT message can be read aloud); anything typed is a normal send.
  const composerSend = (t: string) => {
    if (voice.submitReviewed(t)) return;
    void send(t);
  };

  return (
    <div className="wendy-chat flex h-full min-h-0 flex-col">
      <div className={`flex h-[calc(3.5rem+1px)] shrink-0 items-center gap-3 px-4 ${headerClassName}`}>
        <EmotionalPresence selection={selection} interaction={interaction} />
        <p className="text-sm font-medium max-[420px]:sr-only">Wendy</p>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <MoodControl selection={selection} reading={reading} prefs={prefs} onPrefs={setPrefs} onCorrect={onCorrect} />
          {trail}
        </span>
      </div>
      <SeeingChip className="mx-4 mb-1 shrink-0 self-start" />
      <div
        ref={logRef}
        role="log"
        aria-label="Conversa com a Wendy"
        aria-live="polite"
        aria-relevant="additions"
        aria-busy={status === "connecting" || status === "running"}
        onScroll={(e) => {
          if (performance.now() - lastAuto.current < 150) return; // our own follow, not the principal scrolling away
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2"
      >
        {status === "connecting" ? (
          <div className="grid gap-3 py-6" aria-label="Carregando a conversa">
            <div className="h-3 w-2/3 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
          </div>
        ) : null}

        {status === "empty" || (connectFailed && !items.length) ? (
          <div className="py-8">
            <p className="text-body text-ink-2">{unavailableReason ? "Ainda não há mensagens para mostrar." : connectFailed ? "Não consegui carregar a conversa anterior. Você pode escrever mesmo assim." : "O que você quer saber ou delegar hoje?"}</p>
            {connectFailed ? (
              <button type="button" onClick={() => void reconnect()} className="mt-3 inline-flex min-h-6 items-center rounded-full border border-line px-3 py-1 text-sm font-medium text-ink-2 hover:bg-surface-2">
                Tentar carregar de novo
              </button>
            ) : null}
            {suggestions.length && !unavailableReason ? (
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
              <li key={it.id} data-message-id={it.id} tabIndex={-1} className="wendy-in flex justify-end outline-none">
                <p className="chat-user max-w-[85%] whitespace-pre-wrap text-body leading-snug">
                  <span className="sr-only">Você: </span>
                  {it.text}
                </p>
              </li>
            ) : it.kind === "assistant" ? (
              <li key={it.id} className="wendy-in wendy-answer max-w-full text-body leading-relaxed text-ink">
                <span className="sr-only">Wendy: </span>
                <SafeMarkdown content={it.text} />
              </li>
            ) : (
              <li key={it.id} className="wendy-in min-w-0">
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
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad" role="alert">
            <p className="min-w-0 flex-1">{error}</p>
            {resendText ? (
              <button type="button" onClick={resend} className="shrink-0 rounded-full border border-bad/40 px-3 py-1 font-medium hover:bg-bad/10">
                Reenviar mensagem
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <form
        className="chat-form border-t border-line/70 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          composerSend(text);
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Mensagem para a Wendy
        </label>
        <div className="chat-composer flex items-end gap-2 p-1.5 pl-4" data-busy={running || undefined}>
          <textarea
            id={inputId}
            ref={inputRef}
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              voice.edited(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                composerSend(text);
              }
            }}
            placeholder={unavailableReason ? "Conversa indisponível" : "Pergunte ou peça algo à Wendy…"}
            disabled={!!unavailableReason}
            aria-describedby={unavailableReason ? `${inputId}-off` : undefined}
            className="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent py-2 text-body outline-none [field-sizing:content] placeholder:text-faint"
          />
          {!unavailableReason ? <MicButton kind={voice.state.kind} supported={voice.supported} onPress={voice.press} /> : null}
          {running ? (
            <button type="button" onClick={stop} className="shrink-0 rounded-full border border-line px-4 py-2 text-sm text-ink-2 hover:bg-surface-2">
              Parar
            </button>
          ) : (
            <button type="submit" disabled={!text.trim() || !!unavailableReason} className="chat-send shrink-0 px-4 py-2 text-sm font-medium">
              Enviar
            </button>
          )}
        </div>
        {!unavailableReason ? (
          <VoicePanel
            state={voice.state}
            supported={voice.supported}
            prefs={voice.prefs}
            voices={voice.voices}
            askConsent={voice.askConsent}
            onConsent={voice.consent}
            onDecline={voice.decline}
            onCancel={voice.cancel}
            onReset={voice.reset}
            onPrefs={voice.setPrefs}
          />
        ) : null}
        {unavailableReason ? (
          <p id={`${inputId}-off`} className="mt-1.5 rounded-lg bg-info-soft px-3 py-2 text-sm text-info" role="status">
            {unavailableReason}
          </p>
        ) : running && text.trim() ? (
          <p className="mt-1.5 px-1 text-micro text-ink-2" role="status">
            A Wendy ainda está respondendo. O envio libera quando ela terminar; seu texto fica guardado.
          </p>
        ) : (
          <p className="mt-1.5 px-1 text-micro text-faint">Cada afirmação é validada contra registros reais · nada é enviado sem sua aprovação</p>
        )}
      </form>
    </div>
  );
}
