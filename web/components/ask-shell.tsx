"use client";
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIsClient } from "@/lib/client";
import { AnswerCard, SiteCard, type AnswerPayload, type SitePayload } from "./cards";

/**
 * Generative workspace: a question becomes a set of cards emitted by Wendy's agent (AG-UI tool calls).
 * The browser never talks to a model; CopilotKit relays to Wendy, which validates everything it says.
 */
type Msg = { id: string; role: string; content?: unknown; toolCalls?: { id: string; function: { name: string; arguments: string } }[] };
type Turn = { id: string; question: string; cards: { id: string; name: string; args: unknown }[]; text: string };

const STEPS = [
  { key: "raciocinando", label: "Entender e raciocinar" },
  { key: "montando", label: "Montar o workspace" },
  { key: "pronto", label: "Pronto" },
];

function turnsFrom(messages: Msg[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === "user") turns.push({ id: m.id, question: typeof m.content === "string" ? m.content : "", cards: [], text: "" });
    const t = turns[turns.length - 1];
    if (!t || m.role !== "assistant") continue;
    for (const tc of m.toolCalls ?? []) {
      try {
        t.cards.push({ id: tc.id, name: tc.function.name, args: JSON.parse(tc.function.arguments) });
      } catch {
        /* arguments still streaming */
      }
    }
    if (typeof m.content === "string" && m.content) t.text = m.content;
  }
  return turns;
}

export function AskShell({ suggestions, children }: { suggestions: string[]; children: React.ReactNode }) {
  const { agent, isReady: agentReady } = useAgent({ agentId: "wendy" });
  // Server markup always says "connecting"; flip to ready only after mount so hydration matches.
  const isReady = useIsClient() && agentReady;
  const { copilotkit } = useCopilotKit();
  const [input, setInput] = useState("");
  const [step, setStep] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHome, setShowHome] = useState(true);
  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isReady) return;
    const sub = agent.subscribe({
      onStepStartedEvent: ({ event }) => setStep(event.stepName),
      onRunErrorEvent: ({ event }) => setError(event.message),
    });
    return () => sub.unsubscribe();
  }, [agent, isReady]);

  const turns = useMemo(() => turnsFrom(agent.messages as unknown as Msg[]), [agent.messages]);

  async function ask(q: string) {
    const question = q.trim();
    if (!question || running || !isReady) return;
    setError(null);
    setStep("raciocinando");
    setRunning(true);
    setShowHome(false);
    setInput("");
    agent.addMessage({ id: crypto.randomUUID(), role: "user", content: question });
    topRef.current?.scrollIntoView({ behavior: "smooth" });
    try {
      await copilotkit.runAgent({ agent });
      setStep("pronto");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const activeIdx = STEPS.findIndex((s) => s.key === step);
  const latest = turns[turns.length - 1];

  return (
    <>
      <div ref={topRef} />
      {!showHome && latest ? (
        <main className="mx-auto max-w-5xl px-4 pb-48 pt-8 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button type="button" onClick={() => setShowHome(true)} className="rounded-full border border-line px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2">
              ← Voltar ao Hoje
            </button>
            <ol className="flex flex-wrap items-center gap-2 text-xs" aria-label="Etapas">
              {STEPS.map((s, i) => (
                <li key={s.key} className="flex items-center gap-2">
                  <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 ${i < activeIdx || (i === activeIdx && s.key === "pronto") ? "bg-accent-soft text-accent-ink" : i === activeIdx ? "bg-ink text-bg" : "text-faint"}`}>
                    {i === activeIdx && running ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden /> : null}
                    {s.label}
                  </span>
                  {i < STEPS.length - 1 ? <span className="text-faint" aria-hidden>—</span> : null}
                </li>
              ))}
            </ol>
          </div>

          {[...turns].reverse().map((t, idx) => (
            <section key={t.id} className={idx === 0 ? "mt-10" : "mt-16 border-t border-line pt-10 opacity-80"}>
              <p className="eyebrow">{idx === 0 ? "Sua pergunta" : "Pergunta anterior"}</p>
              <h1 className="mt-3 text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">{t.question}</h1>
              {idx === 0 && running && !t.cards.length ? (
                <div className="mt-8 grid gap-4" aria-busy>
                  <div className="card h-40 animate-pulse" />
                  <p className="text-sm text-muted">A Wendy está reunindo evidências e validando cada afirmação. Isso pode levar até um minuto.</p>
                </div>
              ) : null}
              <div className="mt-8 grid gap-6">
                {t.cards.map((c) =>
                  c.name === "show_answer" ? <AnswerCard key={c.id} a={c.args as AnswerPayload} /> : c.name === "show_site" ? <SiteCard key={c.id} s={c.args as SitePayload} /> : null,
                )}
              </div>
            </section>
          ))}
          {error ? <p className="mt-6 rounded-2xl bg-bad-soft p-4 text-sm text-bad">Não consegui completar: {error}</p> : null}
        </main>
      ) : (
        children
      )}

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto max-w-5xl px-4 pb-5 pt-3 sm:px-6">
          {suggestions.length && !running ? (
            <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
              {suggestions.map((s) => (
                <button key={s} type="button" onClick={() => ask(s)} className="shrink-0 rounded-full border border-line bg-surface px-3 py-1.5 text-sm text-ink-2 hover:border-accent">
                  {s}
                </button>
              ))}
            </div>
          ) : null}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask(input);
            }}
            className="flex items-center gap-2 rounded-full border border-line bg-surface px-2 py-2 shadow-sm focus-within:border-accent"
          >
            <label htmlFor="ask" className="sr-only">Pergunte à Wendy</label>
            <input
              id="ask"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={isReady ? "Pergunte à Wendy sobre pessoas, compromissos ou seus sites…" : "Conectando à Wendy…"}
              disabled={!isReady || running}
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-[15px] outline-none placeholder:text-faint"
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={!input.trim() || running || !isReady}
              className="grid h-10 w-10 place-items-center rounded-full bg-accent text-bg transition-opacity disabled:opacity-40"
              aria-label="Enviar pergunta"
            >
              {running ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-bg border-t-transparent" /> : "↑"}
            </button>
          </form>
          <p className="mt-2 text-center text-[11px] text-faint">Cada afirmação da Wendy é validada contra registros reais · nada é enviado sem sua aprovação</p>
        </div>
      </div>
    </>
  );
}
