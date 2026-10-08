"use client";
import { CopilotChat, CopilotSidebar, UseAgentUpdate, useAgent, useConfigureSuggestions, useRenderTool } from "@copilotkit/react-core/v2";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { AnswerCard, SiteCard, type AnswerPayload, type SitePayload } from "./cards";
import { ExecutionCard } from "./execution-card";
import type { ExecutionView } from "@/lib/wendy";
import { Sparkline } from "./sparkline";
import { useOptionalWorkspace, type FocusCard } from "./workspace-context";

/**
 * The conversation with Wendy, on CopilotKit's chat.
 * Wendy's agent (AG-UI) answers in text and then emits `show_answer` / `show_site` tool calls;
 * those are render-only here (useRenderTool), so the browser never runs a model or a tool.
 */
const n = (x: number) => Math.round(x).toLocaleString("pt-BR");
const STEPS: Record<string, string> = {
  entendendo: "Entendendo o que você pediu",
  executando: "Executando",
  raciocinando: "Reunindo evidências e validando cada afirmação",
  montando: "Montando os cartões",
};

/** Hands a newly arrived card to the panel once. */
function Arrived({ card }: { card: FocusCard }) {
  const arrived = useOptionalWorkspace()?.arrived;
  useEffect(() => arrived?.(card), [arrived, card]);
  return null;
}

function Pending({ label }: { label: string }) {
  return (
    <div className="my-2 rounded-2xl border border-line bg-surface p-4" aria-busy>
      <div className="h-3 w-32 animate-pulse rounded bg-surface-2" />
      <p className="mt-3 text-xs text-muted">{label}</p>
    </div>
  );
}

function ProofCompact({ a, onOpen }: { a: AnswerPayload; onOpen?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const kinds = a.claims.reduce<Record<string, number>>((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {});
  const KIND_PT: Record<string, [string, string]> = { INFERENCE: ["conclusão", "conclusões"], HYPOTHESIS: ["hipótese", "hipóteses"], ANTICIPATION: ["antecipação", "antecipações"], RECOMMENDATION: ["recomendação", "recomendações"] };
  return (
    <div className="my-2 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">Verificado</span>
        {a.notClaude ? <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">não é o Claude</span> : null}
      </div>
      <p className="mt-2 text-sm">
        <span className="num font-medium">{a.claims.length}</span> afirmaç{a.claims.length === 1 ? "ão comprovada" : "ões comprovadas"} por <span className="num font-medium">{a.evidence.length}</span> registro{a.evidence.length === 1 ? "" : "s"}
        {a.rejectedClaims ? <span className="text-muted"> · {a.rejectedClaims} descartada{a.rejectedClaims === 1 ? "" : "s"}</span> : null}
      </p>
      {a.claims.length ? (
        <p className="mt-1 text-xs text-muted">
          {Object.entries(kinds)
            .map(([k, v]) => `${v} ${KIND_PT[k]?.[v === 1 ? 0 : 1] ?? k.toLowerCase()}`)
            .join(" · ")}
          {a.gaps.length ? ` · ${a.gaps.length} lacuna${a.gaps.length === 1 ? "" : "s"}` : ""}
        </p>
      ) : null}
      <button type="button" onClick={onOpen ?? (() => setExpanded((x) => !x))} aria-expanded={onOpen ? undefined : expanded} className="mt-3 text-sm font-medium text-accent-ink hover:underline">
        {onOpen ? "Ver raciocínio e fontes →" : expanded ? "Esconder raciocínio" : "Ver raciocínio e fontes"}
      </button>
      {expanded ? (
        <div className="mt-3 [&_.card]:border-0 [&_.card]:p-0 [&_.card]:shadow-none">
          <AnswerCard a={a} proofOnly />
        </div>
      ) : null}
    </div>
  );
}

function SiteCompact({ s, onOpen }: { s: SitePayload; onOpen?: () => void }) {
  const change = s.current && s.baselineWeekly?.clicks ? ((s.current.clicks - s.baselineWeekly.clicks) / s.baselineWeekly.clicks) * 100 : null;
  const alarm = change !== null && change <= -20;
  return (
    onOpen ? (
      <button type="button" onClick={onOpen} className="my-2 block w-full rounded-2xl border border-line bg-surface p-4 text-left transition-colors hover:border-accent">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{s.label}</span>
        <span className="eyebrow">Search Console</span>
      </div>
      <p className="mt-1 text-sm">
        <span className="num text-lg font-semibold">{s.current ? n(s.current.clicks) : "—"}</span> <span className="text-muted">cliques em 7 dias</span>
        {change !== null ? <span className={`num ml-2 ${alarm ? "text-bad" : "text-muted"}`}>{`${change > 0 ? "+" : ""}${change.toFixed(1)}%`}</span> : null}
      </p>
      <div className="mt-2">
        <Sparkline values={s.daily.slice(-35).map((d) => d.clicks)} tone={alarm ? "bad" : "accent"} height={36} label={`Cliques diários de ${s.label}`} />
      </div>
      <span className="mt-2 block text-sm font-medium text-accent-ink">Abrir no painel →</span>
      </button>
    ) : (
      <Link href="/sites" className="my-2 block w-full rounded-2xl border border-line bg-surface p-4 text-left transition-colors hover:border-accent">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{s.label}</span>
        <span className="eyebrow">Search Console</span>
      </div>
      <p className="mt-1 text-sm">
        <span className="num text-lg font-semibold">{s.current ? n(s.current.clicks) : "—"}</span> <span className="text-muted">cliques em 7 dias</span>
        {change !== null ? <span className={`num ml-2 ${alarm ? "text-bad" : "text-muted"}`}>{`${change > 0 ? "+" : ""}${change.toFixed(1)}%`}</span> : null}
      </p>
      <div className="mt-2">
        <Sparkline values={s.daily.slice(-35).map((d) => d.clicks)} tone={alarm ? "bad" : "accent"} height={36} label={`Cliques diários de ${s.label}`} />
      </div>
      <span className="mt-2 block text-sm font-medium text-accent-ink">Ver em Sites →</span>
      </Link>
    )
  );
}

const LABELS = {
  welcomeMessageText: "O que você quer saber hoje?",
  chatInputPlaceholder: "Pergunte à Wendy…",
  chatDisclaimerText: "Cada afirmação é validada contra registros reais · nada é enviado sem sua aprovação",
  assistantMessageToolbarCopyMessageLabel: "Copiar",
  userMessageToolbarCopyMessageLabel: "Copiar",
  userMessageToolbarEditMessageLabel: "Editar",
  chatInputToolbarAddButtonLabel: "Adicionar",
  modalHeaderTitle: "Wendy",
  chatToggleOpenLabel: "Abrir conversa com a Wendy",
  chatToggleCloseLabel: "Fechar conversa",
};

/**
 * Everything both chat shells share: Wendy's card renderers, data-derived suggestions and the run step.
 * In the Hoje workspace cards can open in the panel; elsewhere (sidebar) they expand in place.
 */
function useWendyChat(suggestions: string[]) {
  const ws = useOptionalWorkspace();
  const full = ws?.mode === "conversa";
  const open = ws?.open;
  const { agent } = useAgent({ agentId: "wendy" });
  const [step, setStep] = useState<string | null>(null);

  useEffect(() => {
    const sub = agent.subscribe({
      onStepStartedEvent: ({ event }) => setStep(event.stepName),
      onRunFinishedEvent: () => setStep(null),
      onRunErrorEvent: () => setStep(null),
    });
    return () => sub.unsubscribe();
  }, [agent]);

  // Suggestions come from Wendy's own data (what she surfaced, which sites she watches, what is on screen); no model writes them.
  useConfigureSuggestions({ suggestions: suggestions.map((s) => ({ title: s.length > 44 ? `${s.slice(0, 43).trimEnd()}…` : s, message: s })), available: "always", consumerAgentId: "wendy" }, [suggestions.join("|")]);

  useRenderTool(
    {
      name: "show_answer",
      agentId: "wendy",
      parameters: z.custom<AnswerPayload>(),
      render: ({ status, parameters, toolCallId }) => {
        if (status === "inProgress" || !parameters?.claims) return <Pending label="Conferindo as afirmações…" />;
        const card: FocusCard = { id: toolCallId, kind: "answer", a: parameters };
        return (
          <>
            <Arrived card={card} />
            {full ? (
              <div className="my-3">
                <AnswerCard a={parameters} proofOnly />
              </div>
            ) : (
              <ProofCompact a={parameters} onOpen={open ? () => open(card) : undefined} />
            )}
          </>
        );
      },
    },
    [full, open],
  );

  useRenderTool(
    {
      name: "show_site",
      agentId: "wendy",
      parameters: z.custom<SitePayload>(),
      render: ({ status, parameters, toolCallId }) => {
        if (status === "inProgress" || !parameters?.label) return <Pending label="Buscando os números do site…" />;
        const card: FocusCard = { id: toolCallId, kind: "site", s: parameters };
        return (
          <>
            <Arrived card={card} />
            {full ? (
              <div className="my-3">
                <SiteCard s={parameters} />
              </div>
            ) : (
              <SiteCompact s={parameters} onOpen={open ? () => open(card) : undefined} />
            )}
          </>
        );
      },
    },
    [full, open],
  );

  // A skill run (S1): progress, approvals and result; the card keeps itself up to date.
  useRenderTool(
    {
      name: "show_execution",
      agentId: "wendy",
      parameters: z.custom<ExecutionView>(),
      render: ({ status, parameters }) => (status === "inProgress" || !parameters?.id ? <Pending label="Preparando…" /> : <ExecutionCard initial={parameters} />),
    },
    [],
  );

  return step;
}

function StepBadge({ step }: { step: string | null }) {
  if (!step) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4" role="status" aria-live="polite">
      <span className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-ink-2 shadow-sm">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
        {STEPS[step] ?? step}… pode levar até um minuto
      </span>
    </div>
  );
}

/** Shows back what the page shared with Wendy (agent state), so "isso" is never a guess for the principal either. */
export function SeeingChip() {
  const { agent } = useAgent({ agentId: "wendy", updates: [UseAgentUpdate.OnStateChanged] });
  const label = (agent.state as { viewing?: { label?: string } } | undefined)?.viewing?.label;
  if (!label) return null;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full bg-accent-soft px-2.5 py-1 text-xs text-accent-ink" title="O que a Wendy considera quando você diz “isso”">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
      <span className="truncate">Vendo: {label}</span>
    </span>
  );
}

export function WendyChat({ suggestions }: { suggestions: string[] }) {
  const step = useWendyChat(suggestions);
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <StepBadge step={step} />
      <CopilotChat agentId="wendy" className="h-full min-h-0" labels={LABELS} />
    </div>
  );
}

const WIDE = "(min-width: 1280px)";
const subscribeWide = (fn: () => void) => {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener("change", fn);
  return () => mq.removeEventListener("change", fn);
};

/**
 * The same conversation as a right-hand sidebar on the other pages (it carries over as you navigate).
 * Opens by itself only where it fits beside the page; on smaller screens it waits for the button.
 */
export function WendySidebar({ suggestions }: { suggestions: string[] }) {
  const step = useWendyChat(suggestions);
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => false);
  const [choice, setChoice] = useState<boolean | null>(null);
  return (
    <>
      <StepBadge step={step} />
      <CopilotSidebar
        agentId="wendy"
        open={choice ?? wide}
        onOpenChange={setChoice}
        width={420}
        labels={LABELS}
        header={{
          title: "Wendy",
          children: ({ titleContent, closeButton }) => (
            <div className="flex items-center gap-3 border-b border-line px-4 py-3">
              {titleContent}
              <span className="flex min-w-0 max-w-[65%] shrink-0 justify-end">
                <SeeingChip />
              </span>
              {closeButton}
            </div>
          ),
        }}
      />
    </>
  );
}
