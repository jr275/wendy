import Link from "next/link";
import { Suspense } from "react";
import { ShareViewing } from "@/components/share-viewing";
import { Workspace } from "@/components/workspace";
import { WorkspaceProvider } from "@/components/workspace-context";
import { Sparkline } from "@/components/sparkline";
import { TopBar } from "@/components/top-bar";
import { ACTION_LABEL, dateLong, firstName, greeting, intPt, pct, stripRefs } from "@/lib/format";
import { InsightTile } from "@/components/insight-tile";
import { QuietList } from "@/components/quiet-list";
import { quietOf } from "@/lib/proactive";
import { AgentAvailability } from "@/components/agent-availability";
import { MarketWatch } from "@/components/market-watch";
import { ReadingDigest } from "@/components/reading-digest";
import { ApiDown } from "@/components/api-down";
import { ConciergeDesk } from "@/components/concierge/desk";
import { History } from "@/components/concierge/history";
import { Now, type AttentionItem } from "@/components/concierge/now";
import { awaitingApproval } from "@/lib/taskStatus";
import { executions as getExecutions, digestFor, marketFor, principalState, reasonerLabel, recentQuestions, sites as getSites, ACTION_UNAVAILABLE_REASON, UNAVAILABLE_REASON, tasks as getTasks, today as getToday, type Site } from "@/lib/wendy";

const INSPECTOR = process.env.NEXT_PUBLIC_WENDY_INSPECTOR_URL ?? "http://127.0.0.1:3457";

export default function Page() {
  return (
    <Suspense fallback={<Skeleton />}>
      <Today />
    </Suspense>
  );
}

function Skeleton() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-16 sm:px-6" aria-busy>
      <div className="h-4 w-40 animate-pulse rounded bg-surface-2" />
      <div className="mt-6 h-12 w-3/4 animate-pulse rounded bg-surface-2" />
      <div className="mt-3 h-12 w-1/2 animate-pulse rounded bg-surface-2" />
    </main>
  );
}

async function Today() {
  const st = await principalState();
  if (st.status === "down") return <ApiDown />;
  if (st.status === "none") return <Empty title="Nenhum executivo cadastrado" body="Cadastre um executivo na Wendy para começar." />;
  const p = st.principal;
  const loaded = await Promise.all([getToday(p.id), getSites(p.id), getTasks(p.id).catch(() => []), getExecutions(p.id), recentQuestions(p.id), digestFor(p.id), marketFor(p.id)]).catch(() => null);
  if (!loaded) return <ApiDown />;
  const [t, s, open, runs, past, readings, marketView] = loaded;
  const insights = t.insights ?? [];
  const surfaced = insights.filter((i) => i.status === "SURFACED");
  const quiet = insights.filter((i) => i.status === "SUPPRESSED");
  const now = new Date();
  const needs = [
    ...(t.needsYou ?? []).map((a) => ({ key: `a-${a.id}`, tone: "warn" as const, title: `${ACTION_LABEL[a.action_type] ?? a.action_type} aguardando sua aprovação`, detail: [a.subject, a.recipients?.length ? `para ${a.recipients.join(", ")}` : null].filter(Boolean).join(" · "), href: `/insight/${a.insight_id}` })),
    ...(t.pendingCommitments ?? []).map((c) => ({ key: `c-${c.id}`, tone: "warn" as const, title: `Confirmar compromisso com ${c.full_name}`, detail: c.description, href: `${INSPECTOR}/#/pessoas` })),
    // Memories are reviewed on the Memória page (with their source and quote), not one by one here.
    ...(t.pendingMemoryCount
      ? [{ key: "memories", tone: "info" as const, title: `${t.pendingMemoryCount} memória${t.pendingMemoryCount === 1 ? "" : "s"} para confirmar`, detail: "A Wendy anotou coisas sobre você; confirme o que estiver certo.", href: "/memoria" }]
      : []),
    ...((t.memoriesToReview ?? []).length
      ? [{ key: "review", tone: "info" as const, title: "Isto ainda vale?", detail: `${(t.memoriesToReview ?? []).length} memória(s) antiga(s) para rever`, href: "/memoria" }]
      : []),
  ];
  // Everything that is waiting for the principal, most direct first: a run stopped on an approval, then the rest.
  const runAsks: AttentionItem[] = runs
    .filter((r) => awaitingApproval(r))
    .map((r) => {
      const asks = [r, ...r.children].flatMap((x) => x.approvals).filter((a) => a.state === "AWAITING_APPROVAL");
      return { key: `r-${r.id}`, tone: "warn" as const, title: `${r.skillName}: ${asks[0]?.label ?? "aprovação"} aguardando você`, detail: asks.flatMap((a) => a.items).join(" · "), href: `#tarefa-${r.id}` };
    });
  const attention: AttentionItem[] = [...runAsks, ...needs];
  const reasoner = reasonerLabel(insights);

  // Suggestions are about the principal (Wendy is a personal assistant), shown only when they apply.
  const suggestions = [open.length ? "Quais são minhas tarefas?" : null, "O que você sabe sobre mim?"].filter((x): x is string => !!x);

  return (
    <AgentAvailability actionReason={ACTION_UNAVAILABLE_REASON}>
      <TopBar reasoner={reasoner} wide />
      <WorkspaceProvider>
      <Workspace
        suggestions={suggestions}
        unavailableReason={UNAVAILABLE_REASON}
        top={
          attention.length ? (
            <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
              <Now items={attention} className="mt-6" />
            </div>
          ) : null
        }
      >
      {/* Delegate first: Wendy, one field, the tasks she is handling. The Hoje overview follows. */}
      <ConciergeDesk unavailableReason={UNAVAILABLE_REASON} tasks={runs} greeting={`${greeting(now, p.timezone)}, ${firstName(p.display_name)}.`} dateLabel={dateLong(now, p.timezone)} />
      <History questions={past} runs={runs} timeZone={p.timezone} now={now.toISOString()} />
      <main className="mx-auto max-w-5xl px-4 pb-24 pt-6 sm:px-6">
        <div className="mt-14 border-t border-line pt-10">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Hoje</h2>
            <Link href="/semana" className="inline-flex min-h-11 items-center text-sm font-medium text-accent-ink hover:underline lg:min-h-8">
              Ver a revisão da semana →
            </Link>
          </div>
          <p className="mt-1 text-muted">{attention.length ? `${attention.length} ${attention.length === 1 ? "coisa pede" : "coisas pedem"} sua atenção.` : "Nada pendente com você."}</p>
        </div>
        {surfaced[0] ? (
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-2">
            O mais importante agora: <Link className="font-medium text-ink underline decoration-line underline-offset-4 hover:decoration-accent" href={`/insight/${surfaced[0].id}`}>{stripRefs(surfaced[0].headline)}</Link>
          </p>
        ) : null}

        <Section title="O que a Wendy encontrou" count={surfaced.length}>
          {surfaced.length ? (
            <div className="grid gap-4">
              {surfaced.slice(0, 6).map((i, n) => (
                <InsightTile key={i.id} i={i} n={n + 1} />
              ))}
            </div>
          ) : (
            <Empty title="Nada urgente" body="Quando algo merecer sua atenção, aparece aqui — com a fonte de cada afirmação." />
          )}
          <QuietList items={quietOf(insights)} total={quiet.length} timeZone={p.timezone} />
        </Section>

        <Section title="Leituras do dia" hint="ML, IA e ciência · fontes públicas">
          <ReadingDigest digest={readings} canWrite={!ACTION_UNAVAILABLE_REASON} />
        </Section>

        <Section title="Mercado" hint="B3 e tecnologia dos EUA · só acompanhamento">
          <MarketWatch market={marketView} />
        </Section>

        {open.length ? (
          <Section title="Suas tarefas" count={open.length} hint="criadas por você ou pela Wendy com sua aprovação">
            <ul className="card divide-y divide-line-2 overflow-hidden">
              {open.map((task) => (
                <li key={task.id} className="flex items-start gap-3 px-5 py-3">
                  <span className="mt-0.5 text-faint" aria-hidden>
                    ○
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block">{task.title}</span>
                    {task.notes ? <span className="mt-0.5 block truncate text-sm text-muted">{task.notes}</span> : null}
                  </span>
                  {task.created_by === "WENDY" ? <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-micro text-muted">pela Wendy</span> : null}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {s.length ? (
          <Section title="Seus sites no Google" count={s.length} hint="últimos 7 dias contra a média das 4 semanas anteriores">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {s.map((site) => (
                <SiteTile key={site.id} s={site} />
              ))}
            </div>
          </Section>
        ) : null}
      </main>
        <ShareViewing viewing={{ kind: "today", label: "Hoje" }} />
      </Workspace>
      </WorkspaceProvider>
    </AgentAvailability>
  );
}

function Section({ title, count, hint, children }: { title: string; count?: number; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-14">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {count !== undefined ? <span className="num text-sm text-muted">{count}</span> : null}
        {hint ? <span className="text-sm text-faint">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

function SiteTile({ s }: { s: Site }) {
  const baseWeekly = s.baseline ? s.baseline.clicks / 4 : null;
  const change = s.current && baseWeekly ? ((s.current.clicks - baseWeekly) / baseWeekly) * 100 : null;
  // Same volume floor as the detector: below it, a percentage says little and must not alarm.
  const lowVolume = baseWeekly !== null && baseWeekly < 20;
  const tone = change === null || lowVolume ? "muted" : change <= -20 ? "bad" : "accent";
  const last = s.daily.slice(-56);
  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold tracking-tight">{s.label}</h3>
        <span className="truncate text-xs text-faint">{s.site_url.replace(/^sc-domain:|https?:\/\/(www\.)?/g, "").replace(/\/$/, "")}</span>
      </div>
      <div className="mt-3 flex items-end gap-3">
        <span className="num text-3xl font-semibold tracking-tight">{s.current ? intPt(s.current.clicks) : "—"}</span>
        <span className="pb-1 text-sm text-muted">cliques · 7 dias</span>
      </div>
      <p className={`num mt-1 text-sm ${change === null || lowVolume ? "text-muted" : change < 0 ? "text-bad" : "text-good"}`}>
        {pct(change === null ? null : Math.round(change * 10) / 10)} <span className="text-muted">vs. média semanal anterior ({baseWeekly === null ? "—" : intPt(baseWeekly)})</span>
      </p>
      {lowVolume ? <p className="mt-1 text-xs text-faint">Volume baixo — a variação percentual não é conclusiva.</p> : null}
      <div className="mt-4">
        <Sparkline values={last.map((d) => d.clicks)} tone={tone} label={`Cliques diários de ${s.label}, últimos ${last.length} dias`} />
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-muted">
        <span>{s.changes.length} mudança(s) detectada(s)</span>
        <span>importância {s.explicit_importance ?? <span className="text-warn">não definida</span>}</span>
      </div>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="card px-6 py-10 text-center">
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm text-muted">{body}</p>
    </div>
  );
}
