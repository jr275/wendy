import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ApprovalCard } from "@/components/approval";
import { Lead } from "@/components/lead";
import { ShareViewing } from "@/components/share-viewing";
import { WendySidebar } from "@/components/wendy-chat";
import { TopBar } from "@/components/top-bar";
import { EVENT_LABEL, stripRefs } from "@/lib/format";
import { insight as getInsight, type DetailAction, type DetailClaim, type InsightDetail } from "@/lib/wendy";

export default function Page(props: PageProps<"/insight/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <InsightView params={props.params} />
    </Suspense>
  );
}

function Loading() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-16 sm:px-6" aria-busy>
      <div className="h-4 w-32 animate-pulse rounded bg-surface-2" />
      <div className="mt-6 h-10 w-4/5 animate-pulse rounded bg-surface-2" />
      <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="card h-64 animate-pulse" />
        <div className="card h-64 animate-pulse" />
      </div>
    </main>
  );
}

const FACTOR: Record<string, string> = {
  importance: "Importância",
  urgency: "Urgência expressa",
  relationship_relevance: "Relevância da relação",
  business_impact: "Impacto no negócio",
  novelty: "Novidade",
  confidence: "Confiança na análise",
  time_sensitivity: "Prazo",
  actionability: "Dá para agir",
  executive_preference: "Suas preferências",
  reply_pressure: "Resposta sua pendente",
};
const KIND_PT: Record<DetailClaim["kind"], string> = {
  FACT: "Fato",
  INFERENCE: "Conclusão",
  HYPOTHESIS: "Hipótese",
  ANTICIPATION: "Antecipação",
  RECOMMENDATION: "Recomendação",
};
const LAYERS: { kinds: DetailClaim["kind"][]; title: string; hint: string; tone: string }[] = [
  { kinds: ["FACT"], title: "Fatos", hint: "registros, gerados pelo código", tone: "bg-surface-2 text-ink-2" },
  { kinds: ["INFERENCE"], title: "Conclusões", hint: "deduzidas dos fatos", tone: "bg-info-soft text-info" },
  { kinds: ["HYPOTHESIS", "ANTICIPATION"], title: "Hipóteses e antecipações", hint: "o que pode estar acontecendo ou vir a acontecer", tone: "bg-warn-soft text-warn" },
  { kinds: ["RECOMMENDATION"], title: "Recomendações", hint: "o que fazer", tone: "bg-accent-soft text-accent-ink" },
];

const short = (t: string) => (t.length > 36 ? `${t.slice(0, 35).trimEnd()}…` : t);

async function InsightView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let d: InsightDetail;
  try {
    d = await getInsight(id);
  } catch {
    notFound();
  }
  const i = d.insight;
  const valid = d.claims.filter((c) => c.validation_status === "VALID");
  const rejected = d.claims.filter((c) => c.validation_status !== "VALID");
  const byOrdinal = new Map(d.claims.map((c) => [c.ordinal, c]));
  const reasoner = d.calls.find((c) => c.model !== "TEST_DOUBLE" && !c.model.startsWith("claude-"))?.model ?? null;
  const pending = d.actions.filter((a) => a.state === "AWAITING_APPROVAL" && a.action_type === "SEND_EMAIL");
  const others = d.actions.filter((a) => !pending.includes(a));
  const factors = [...i.salience.factors].filter((f) => f.value !== null).sort((a, b) => b.contribution - a.contribution);
  const score = i.salience.score;

  return (
    <>
      <TopBar reasoner={reasoner} />
      <main className="mx-auto max-w-5xl px-4 pb-24 pt-8 sm:px-6 sm:pt-10">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link href="/" className="rounded-full border border-line px-3 py-1.5 text-ink-2 hover:bg-surface-2">
            ← Hoje
          </Link>
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-ink-2">{EVENT_LABEL[d.event.event_type] ?? d.event.event_type}</span>
          <span className="text-xs text-muted">{new Date(i.created_at).toLocaleString("pt-BR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}</span>
          {i.status !== "SURFACED" ? <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted">{i.status === "SUPPRESSED" ? "registrado sem interromper" : "descartado pela validação"}</span> : null}
        </div>

        <h1 className="mt-6 max-w-4xl text-3xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">{stripRefs(i.headline) || "Insight"}</h1>
        <div className="mt-6 max-w-3xl">
          <Lead text={i.narrative} />
        </div>

        {pending.length ? (
          <section className="mt-10 grid gap-4" aria-label="Precisa de você">
            {pending.map((a) => (
              <ApprovalCard key={a.id} a={a} />
            ))}
          </section>
        ) : null}

        <div className="mt-12 grid items-start gap-8 lg:grid-cols-[1fr_320px]">
          <section aria-label="Linha de raciocínio">
            <h2 className="text-xl font-semibold tracking-tight">Como a Wendy chegou a isso</h2>
            <p className="mt-1 text-sm text-muted">Cada camada só usa a anterior. Afirmações sem fonte válida são descartadas.</p>
            <ol className="mt-6 grid gap-8 border-l border-line pl-6">
              {LAYERS.map((layer) => {
                const items = valid.filter((c) => layer.kinds.includes(c.kind));
                if (!items.length) return null;
                return (
                  <li key={layer.title} className="relative">
                    <span className="absolute -left-[31px] top-1 h-2.5 w-2.5 rounded-full border-2 border-bg bg-accent" aria-hidden />
                    <h3 className="flex flex-wrap items-baseline gap-2">
                      <span className="font-semibold">{layer.title}</span>
                      <span className="text-xs text-faint">{layer.hint}</span>
                    </h3>
                    <ul className="mt-3 grid gap-3">
                      {items.map((c) =>
                        c.kind === "FACT" ? (
                          <li key={c.label} className="flex items-start gap-3 text-[15px] text-ink-2">
                            <span className="num mt-0.5 rounded bg-surface-2 px-1.5 text-[11px] text-muted">{c.label}</span>
                            <span>{readableFact(c, d.labels)}</span>
                          </li>
                        ) : (
                          <li key={c.label} className="card p-4 shadow-none">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className={`rounded-full px-2 py-0.5 ${layer.tone}`}>{KIND_PT[c.kind]}</span>
                              <Confidence value={c.confidence} />
                            </div>
                            <p className="mt-2 leading-relaxed">{c.statement}</p>
                            {c.derived_from.length ? (
                              <p className="mt-2 text-xs text-faint">
                                baseado em {c.derived_from.map((o) => byOrdinal.get(o)?.label).filter(Boolean).join(", ")}
                              </p>
                            ) : null}
                          </li>
                        ),
                      )}
                    </ul>
                  </li>
                );
              })}
            </ol>
            {rejected.length ? <p className="mt-6 text-sm text-muted">{rejected.length} afirmação(ões) do modelo foram descartadas pela validação e não aparecem acima.</p> : null}

            {others.length ? (
              <section className="mt-12">
                <h2 className="text-xl font-semibold tracking-tight">O que a Wendy já preparou</h2>
                <div className="mt-4 grid gap-4">
                  {others.map((a) => (
                    <PreparedAction key={a.id} a={a} />
                  ))}
                </div>
              </section>
            ) : null}
          </section>

          <aside className="card p-6 lg:sticky lg:top-20" aria-label="Por que isso apareceu">
            <p className="eyebrow">Por que isso apareceu</p>
            <div className="mt-3 flex items-end gap-2">
              <span className="num text-5xl font-semibold tracking-tight">{score.toFixed(2)}</span>
              <span className="pb-2 text-sm text-muted">de 1,00</span>
            </div>
            <div className="relative mt-3 h-2 rounded-full bg-surface-2">
              <div className={`h-full rounded-full ${score >= i.salience.threshold ? "bg-accent" : "bg-faint"}`} style={{ width: `${Math.min(100, score * 100)}%` }} />
              <span className="absolute -top-1 h-4 w-px bg-ink" style={{ left: `${i.salience.threshold * 100}%` }} aria-hidden />
            </div>
            <p className="mt-2 text-xs text-muted">
              Limiar para te interromper: <span className="num">{i.salience.threshold.toFixed(2)}</span> · {score >= i.salience.threshold ? "passou — por isso você foi avisado" : "não passou — ficou registrado"}
            </p>
            <ul className="mt-6 grid gap-4">
              {factors.map((f) => (
                <li key={f.name}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span>{FACTOR[f.name] ?? f.name}</span>
                    <span className="num text-xs text-muted">{(f.value ?? 0).toFixed(2)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-accent/70" style={{ width: `${(f.value ?? 0) * 100}%` }} />
                  </div>
                  <p className="mt-1 text-xs leading-snug text-faint">{f.basis}</p>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </main>
      <ShareViewing viewing={{ kind: "insight", id, label: `Insight · ${short(stripRefs(i.headline) || "sem título")}` }} />
      <WendySidebar suggestions={["Explique isso com mais detalhe", "O que eu devo fazer sobre isso?", "O que a Wendy ainda não sabe aqui?"]} />
    </>
  );
}

/** Human label of a code-produced fact (record), with event types in plain Portuguese. */
function readableFact(c: DetailClaim, labels: Record<string, string>): string {
  const e = c.evidence[0];
  const raw = (e ? labels[`${e.kind}:${e.id}`] : undefined) ?? c.statement.split("\n")[0] ?? "";
  return raw.replace(/^([A-Z_]{6,})(?=\s·|$)/, (t) => (EVENT_LABEL[t] ? `Sinal: ${EVENT_LABEL[t]}` : t));
}

function Confidence({ value }: { value: number }) {
  const n = value >= 0.8 ? 3 : value >= 0.5 ? 2 : 1;
  return (
    <span className="flex items-center gap-1.5 text-faint" aria-label={`confiança ${value.toFixed(2)}`}>
      <span className="flex gap-0.5">
        {[0, 1, 2].map((k) => (
          <span key={k} className={`h-1.5 w-1.5 rounded-full ${k < n ? "bg-ink-2" : "bg-line"}`} />
        ))}
      </span>
      <span className="num">{value.toFixed(2)}</span>
    </span>
  );
}

const STATE: Record<string, { label: string; tone: string }> = {
  VERIFIED: { label: "verificada", tone: "bg-accent-soft text-accent-ink" },
  EXECUTED: { label: "executada", tone: "bg-info-soft text-info" },
  APPROVED: { label: "aprovada, na fila", tone: "bg-info-soft text-info" },
  REJECTED: { label: "rejeitada", tone: "bg-surface-2 text-muted" },
  EXPIRED: { label: "expirou", tone: "bg-surface-2 text-muted" },
  FAILED: { label: "falhou", tone: "bg-bad-soft text-bad" },
  AWAITING_APPROVAL: { label: "aguardando você", tone: "bg-warn-soft text-warn" },
};

function PreparedAction({ a }: { a: DetailAction }) {
  const s = STATE[a.state] ?? { label: a.state.toLowerCase(), tone: "bg-surface-2 text-muted" };
  return (
    <article className="card p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{a.action_type === "PREPARE_BRIEFING" ? `Briefing · ${a.content.title ?? ""}` : `E-mail · ${a.content.subject ?? ""}`}</span>
        <span className={`rounded-full px-2.5 py-1 text-xs ${s.tone}`}>{s.label}</span>
      </div>
      {a.action_type === "PREPARE_BRIEFING" ? (
        <div className="mt-4 grid gap-4">
          {(a.content.sections ?? []).map((sec) => (
            <div key={sec.heading}>
              <p className="text-sm font-semibold">{stripRefs(sec.heading)}</p>
              <ul className="mt-1 grid gap-1 text-[15px] text-ink-2">
                {sec.points.map((p, k) => (
                  <li key={k}>— {stripRefs(p.text)}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 whitespace-pre-wrap leading-relaxed text-ink-2">{a.content.body}</p>
      )}
      {a.rejection_reason ? <p className="mt-3 text-sm text-muted">Motivo da rejeição: {a.rejection_reason}</p> : null}
      {a.execution?.verification ? (
        <p className="mt-4 text-xs text-faint">
          {a.execution.verification.contentMatches ? "Conferido por leitura de volta" : "Verificação falhou"} · {a.execution.verification.deliversExternally === false ? "local, não entregue externamente" : a.execution.provider}
        </p>
      ) : null}
    </article>
  );
}
