import Link from "next/link";
import { Suspense } from "react";
import { SiteCard, type SitePayload } from "@/components/cards";
import { ImportanceControl } from "@/components/importance";
import { TopBar } from "@/components/top-bar";
import { stripRefs } from "@/lib/format";
import { principal as getPrincipal, sites as getSites, today as getToday, reasonerLabel, type Site } from "@/lib/wendy";

export default function Page() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-5xl px-4 py-16 sm:px-6" aria-busy><div className="card h-96 animate-pulse" /></main>}>
      <Sites />
    </Suspense>
  );
}

const KIND_PT: Record<string, string> = {
  SITE_CLICKS_DROP: "Site: queda de cliques",
  SITE_CLICKS_RISE: "Site: alta de cliques",
  PAGE_CLICKS_DROP: "Página: queda de cliques",
  PAGE_CLICKS_RISE: "Página: alta de cliques",
  QUERY_POSITION_DROP: "Busca: perdeu posições",
};

function toPayload(s: Site): SitePayload {
  return {
    label: s.label,
    siteUrl: s.site_url,
    importance: s.explicit_importance,
    daily: s.daily,
    current: s.current,
    baseline: s.baseline,
    baselineWeekly: s.baseline ? { clicks: Math.round((s.baseline.clicks / 4) * 10) / 10, impressions: Math.round(s.baseline.impressions / 4) } : null,
    movers: s.movers,
    direction: s.direction,
  };
}

async function Sites() {
  const p = await getPrincipal();
  if (!p) return null;
  const [all, t] = await Promise.all([getSites(p.id), getToday(p.id)]);
  return (
    <>
      <TopBar reasoner={reasonerLabel(t.insights ?? [])} />
      <main className="mx-auto max-w-5xl px-4 pb-24 pt-10 sm:px-6 sm:pt-14">
        <p className="eyebrow">Google Search Console · só leitura</p>
        <h1 className="mt-4 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
          Seus sites.
          <span className="block text-muted">O que mudou na última semana.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-2">
          A Wendy compara os últimos 7 dias com a média das 4 semanas anteriores e só avisa quando a mudança é grande e tem volume suficiente.
        </p>
        <div className="mt-12 grid gap-16">
          {all.map((s) => (
            <section key={s.id} aria-label={s.label} className="grid gap-4">
              <SiteCard s={toPayload(s)} />
              <div className="grid gap-4 md:grid-cols-[minmax(17rem,1fr)_minmax(0,2fr)]">
                <div className="card p-6">
                  <ImportanceControl propertyId={s.id} label={s.label} value={s.explicit_importance} />
                </div>
                <div className="card min-w-0 p-6">
                  <p className="text-sm font-medium">Mudanças detectadas</p>
                  {s.changes.length ? (
                    <ul className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-2">
                      {s.changes.map((c) => (
                        <li key={c.event_id} className="min-w-0">
                          <Link href={c.insight_id ? `/insight/${c.insight_id}` : "#"} className="group flex items-start justify-between gap-3 rounded-xl px-2 py-1.5 -mx-2 hover:bg-surface-2">
                            <span className="min-w-0">
                              <span className="block text-sm">{KIND_PT[c.change.kind] ?? c.change.kind}{c.change.key ? <span className="text-muted"> · {c.change.key.replace(/^https?:\/\/(www\.)?[^/]+/, "") || c.change.key}</span> : null}</span>
                              {c.headline ? <span className="block truncate text-xs text-muted">{stripRefs(c.headline)}</span> : null}
                            </span>
                            <span className={`num shrink-0 text-sm ${(c.change.changePct ?? 0) < 0 ? "text-bad" : "text-good"}`}>
                              {c.change.changePct === null ? `${c.change.positionDelta ?? ""} pos.` : `${c.change.changePct > 0 ? "+" : ""}${c.change.changePct}%`}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-muted">Nada relevante na última comparação.</p>
                  )}
                </div>
              </div>
            </section>
          ))}
        </div>
      </main>
    </>
  );
}
