import Link from "next/link";
import { Suspense } from "react";
import { ApiDown } from "@/components/api-down";
import { TopBar } from "@/components/top-bar";
import { dateLong } from "@/lib/format";
import { briefingPreviewFor, principalState, today as getToday, reasonerLabel, type BriefingItem, type BriefingSection } from "@/lib/wendy";

const PERIODS = [7, 14, 30];
const day = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });

export default function Page({ searchParams }: { searchParams: Promise<{ dias?: string }> }) {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl px-4 py-16 sm:px-6" aria-busy><div className="card h-64 animate-pulse" /></main>}>
      <Briefing searchParams={searchParams} />
    </Suspense>
  );
}

function Item({ i }: { i: BriefingItem }) {
  return (
    <li className="px-5 py-4">
      <a href={i.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-medium text-ink underline decoration-line underline-offset-4 hover:decoration-accent lg:min-h-0">
        {i.title}
      </a>
      <span className="mt-0.5 block text-sm text-muted">
        {i.source} · {day(i.publishedAt)}
        {i.origin === "press" ? " · imprensa (não é fonte oficial)" : ""}
      </span>
      {i.summary ? (
        <span className="mt-2 block text-sm text-ink-2">
          <span className="text-micro uppercase tracking-wide text-faint">Resumo da fonte · </span>
          {i.summary}
        </span>
      ) : null}
      <span className="mt-1 block text-sm text-faint">Relevância: {i.relevance}</span>
    </li>
  );
}

function Section({ n, s }: { n: number; s: BriefingSection }) {
  return (
    <section className="mt-8" aria-labelledby={`h-${s.id}`}>
      <h2 id={`h-${s.id}`} className="eyebrow">
        {n}. {s.title}
      </h2>
      <p className="text-sm text-faint">{s.scope}</p>
      {s.unavailable ? (
        <p className="card mt-3 px-5 py-4 text-muted">{s.unavailable}</p>
      ) : s.items.length ? (
        <ul className="card mt-3 divide-y divide-line-2 overflow-hidden">{s.items.map((i) => <Item key={i.url} i={i} />)}</ul>
      ) : (
        <p className="mt-3 text-muted">{s.empty}.</p>
      )}
    </section>
  );
}

async function Briefing({ searchParams }: { searchParams: Promise<{ dias?: string }> }) {
  const q = Number((await searchParams).dias);
  const days = PERIODS.includes(q) ? q : 7;
  const st = await principalState();
  if (st.status === "down") return <ApiDown />;
  const p = st.status === "ok" ? st.principal : null;
  const today = p ? await getToday(p.id).catch(() => null) : null;
  const b = await briefingPreviewFor(days);
  return (
    <>
      <TopBar reasoner={today ? reasonerLabel(today.insights ?? []) : null} />
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-10 sm:px-6">
        <Link href="/" className="inline-flex min-h-11 items-center text-sm text-muted hover:text-ink lg:min-h-8">
          ← Hoje
        </Link>
        <p className="eyebrow mt-2">{p ? dateLong(new Date(), p.timezone) : ""}</p>
        <h1 className="display mt-2 text-4xl tracking-tight sm:text-5xl">Wendy Intelligence Briefing</h1>
        <p className="mt-2 max-w-2xl text-muted">Prévia dentro da Wendy. Nada é enviado a ninguém: não há destinatário nem envio configurado. Os resumos são das próprias fontes; a Wendy não escreve notícia.</p>
        <nav className="mt-4 flex flex-wrap gap-2" aria-label="Período coberto">
          {PERIODS.map((d) => (
            <Link key={d} href={`/briefing?dias=${d}`} aria-current={d === days ? "page" : undefined} className={`inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium lg:min-h-9 ${d === days ? "border-accent bg-surface-2" : "border-line hover:bg-surface-2"}`}>
              {d} dias
            </Link>
          ))}
        </nav>
        {!b ? (
          <div className="card mt-8 px-6 py-10 text-center">
            <p className="font-semibold">Não consegui montar o briefing agora</p>
            <p className="mt-1 text-sm text-muted">A Wendy não mostra notícia que não conseguiu ler. Tente de novo em instantes.</p>
          </div>
        ) : (
          <>
            <p className="mt-4 text-sm text-faint">
              Período coberto: {day(b.period.from)} a {day(b.period.to)} ({b.period.days} dias).
            </p>
            <section className="mt-8" aria-labelledby="h-resumo">
              <h2 id="h-resumo" className="eyebrow">
                2. Resumo executivo
              </h2>
              {b.highlights.length ? <ul className="card mt-3 divide-y divide-line-2 overflow-hidden">{b.highlights.map((i) => <Item key={i.url} i={i} />)}</ul> : <p className="mt-3 text-muted">Nenhuma novidade relevante identificada no período.</p>}
            </section>
            {b.sections.map((s, idx) => (
              <Section key={s.id} n={3 + idx} s={s} />
            ))}
            <section className="mt-8" aria-labelledby="h-atencao">
              <h2 id="h-atencao" className="eyebrow">
                9. O que merece atenção
              </h2>
              <p className="text-sm text-faint">{b.attention.label}</p>
              <ul className="mt-3 space-y-1">{b.attention.lines.map((l) => <li key={l}>{l}</li>)}</ul>
            </section>
            <section className="mt-8" aria-labelledby="h-fontes">
              <h2 id="h-fontes" className="eyebrow">
                10. Fontes consultadas
              </h2>
              <ul className="mt-3 space-y-1 text-sm">
                {b.sources.map((s) => (
                  <li key={s.name}>
                    {s.name} — {s.status === "lida" ? `lida (${s.items} itens no feed)` : "indisponível"}
                  </li>
                ))}
              </ul>
              {b.notes.map((n) => (
                <p key={n} className="mt-2 text-sm text-faint">{n}</p>
              ))}
            </section>
          </>
        )}
      </main>
    </>
  );
}
