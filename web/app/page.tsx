import Link from "next/link";
import { Suspense } from "react";
import { ShareViewing } from "@/components/share-viewing";
import { Workspace } from "@/components/workspace";
import { WorkspaceProvider } from "@/components/workspace-context";
import { Sparkline } from "@/components/sparkline";
import { TopBar } from "@/components/top-bar";
import { ACTION_LABEL, EVENT_LABEL, dateLong, firstName, greeting, intPt, pct, stripRefs } from "@/lib/format";
import { principal as getPrincipal, reasonerLabel, sites as getSites, tasks as getTasks, today as getToday, type InsightCard, type Site } from "@/lib/wendy";

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
  const p = await getPrincipal();
  if (!p) return <Empty title="Nenhum executivo cadastrado" body="Cadastre um executivo na Wendy para começar." />;
  const [t, s, open] = await Promise.all([getToday(p.id), getSites(p.id), getTasks(p.id).catch(() => [])]);
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
  const reasoner = reasonerLabel(insights);

  // Suggestions are about the principal (Wendy is a personal assistant), shown only when they apply.
  const suggestions = [open.length ? "Quais são minhas tarefas?" : null, "O que você sabe sobre mim?"].filter((x): x is string => !!x);

  return (
    <>
      <TopBar reasoner={reasoner} wide />
      <WorkspaceProvider>
      <Workspace suggestions={suggestions}>
      <main className="mx-auto max-w-5xl px-4 pb-24 pt-10 sm:px-6 sm:pt-14">
        <p className="eyebrow">{dateLong(now, p.timezone)} · Hoje</p>
        <h1 className="mt-4 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
          {greeting(now, p.timezone)}, {firstName(p.display_name)}.
          <span className="block text-muted">
            {needs.length ? `${needs.length} ${needs.length === 1 ? "coisa pede" : "coisas pedem"} sua atenção.` : "Nada pendente com você."}
          </span>
        </h1>
        {surfaced[0] ? (
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-2">
            O mais importante agora: <Link className="font-medium text-ink underline decoration-line underline-offset-4 hover:decoration-accent" href={`/insight/${surfaced[0].id}`}>{stripRefs(surfaced[0].headline)}</Link>
          </p>
        ) : null}

        {needs.length ? (
          <Section title="Precisa de você" count={needs.length}>
            <ul className="card divide-y divide-line-2 overflow-hidden">
              {needs.map((n) => (
                <li key={n.key}>
                  <a href={n.href} className="flex items-start gap-4 px-5 py-4 transition-colors hover:bg-surface-2">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.tone === "warn" ? "bg-warn" : "bg-info"}`} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{n.title}</span>
                      {n.detail ? <span className="mt-0.5 block truncate text-sm text-muted">{n.detail}</span> : null}
                    </span>
                    <span className="text-faint" aria-hidden>→</span>
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section title="O que a Wendy encontrou" count={surfaced.length} hint={quiet.length ? `${quiet.length} outros registrados sem interromper` : undefined}>
          {surfaced.length ? (
            <div className="grid gap-4">
              {surfaced.slice(0, 6).map((i, n) => (
                <InsightTile key={i.id} i={i} n={n + 1} />
              ))}
            </div>
          ) : (
            <Empty title="Nada urgente" body="Quando algo merecer sua atenção, aparece aqui — com a fonte de cada afirmação." />
          )}
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
                  {task.created_by === "WENDY" ? <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">pela Wendy</span> : null}
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
    </>
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

function Dots({ score }: { score: number }) {
  const n = score >= 0.75 ? 3 : score >= 0.5 ? 2 : 1;
  return (
    <span className="flex gap-1" aria-label={`prioridade ${score.toFixed(2)}`}>
      {[0, 1, 2].map((k) => (
        <span key={k} className={`h-1.5 w-1.5 rounded-full ${k < n ? "bg-accent" : "bg-line"}`} />
      ))}
    </span>
  );
}

function InsightTile({ i, n }: { i: InsightCard; n: number }) {
  return (
    <Link href={`/insight/${i.id}`} className="card group block p-5 transition-shadow hover:shadow-md sm:p-6">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="num text-faint">{String(n).padStart(2, "0")}</span>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-ink-2">{EVENT_LABEL[i.event_type] ?? i.event_type}</span>
        <Dots score={i.score} />
        <span className="num text-faint">prioridade {i.score.toFixed(2)}</span>
        {i.other_model ? <span className="rounded-full bg-warn-soft px-2 py-0.5 text-warn">{i.other_model} · não é o Claude</span> : null}
        {i.test_double ? <span className="rounded-full bg-warn-soft px-2 py-0.5 text-warn">substituto de teste</span> : null}
      </div>
      <h3 className="mt-3 text-lg font-semibold leading-snug tracking-tight group-hover:text-accent-ink">{stripRefs(i.headline)}</h3>
      {i.narrative ? <p className="mt-2 line-clamp-3 text-[15px] leading-relaxed text-ink-2">{stripRefs(i.narrative)}</p> : null}
      <p className="mt-3 text-sm text-muted">
        {(i.claims ?? []).length} afirmações validadas · ver evidências <span aria-hidden>→</span>
      </p>
    </Link>
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
