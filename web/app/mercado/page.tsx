import Link from "next/link";
import { Suspense } from "react";
import { ApiDown } from "@/components/api-down";
import { MarketWatchlist } from "@/components/market-watchlist";
import { Sparkline } from "@/components/market-sparkline";
import { TopBar } from "@/components/top-bar";
import { dateLong } from "@/lib/format";
import { fmtChange, fmtDay, fmtPrice } from "@/lib/marketChart";
import { kindOf, nameOf, summarizeMarket } from "@/lib/marketSummary";
import { ACTION_UNAVAILABLE_REASON, marketOverviewFor, principalState, today as getToday, reasonerLabel, type MarketQuote } from "@/lib/wendy";

const KIND: Record<string, string> = { MOVE_OUTLIER: "Variação fora do comum", VOLUME_SPIKE: "Volume muito acima do normal", RANGE_EXPANSION: "Oscilação maior que a média" };
const tone = (p: number | null) => (p === null ? "text-muted" : p > 0 ? "text-good" : p < 0 ? "text-bad" : "text-muted");
const arrow = (p: number | null) => (p === null ? "" : p > 0 ? "▲ " : p < 0 ? "▼ " : "");

export default function Page() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-4xl px-4 py-16 sm:px-6" aria-busy><div className="card h-64 animate-pulse" /></main>}>
      <Market />
    </Suspense>
  );
}

function QuoteLine({ q }: { q: MarketQuote }) {
  return (
    <li>
      <Link href={`/mercado/${encodeURIComponent(q.symbol)}`} className="flex min-h-11 items-center justify-between gap-3 px-4 py-2 hover:bg-surface-2">
        <span className="font-medium">{q.symbol}</span>
        <span className="num text-sm">
          {fmtPrice(q.lastClose, kindOf(q.symbol, q.market))} <span className={`ml-2 ${tone(q.changePct)}`}>{arrow(q.changePct)}{fmtChange(q.changePct)}</span>
        </span>
      </Link>
    </li>
  );
}

async function Market() {
  const st = await principalState();
  if (st.status === "down") return <ApiDown />;
  const p = st.status === "ok" ? st.principal : null;
  const today = p ? await getToday(p.id).catch(() => null) : null;
  const o = p ? await marketOverviewFor(p.id) : null;
  const summary = o ? summarizeMarket(o) : "";
  return (
    <>
      <TopBar reasoner={today ? reasonerLabel(today.insights ?? []) : null} />
      <main className="mx-auto max-w-4xl px-4 pb-24 pt-10 sm:px-6">
        <Link href="/" className="inline-flex min-h-11 items-center text-sm text-muted hover:text-ink lg:min-h-8">
          ← Hoje
        </Link>
        <p className="eyebrow mt-2">{p ? dateLong(new Date(), p.timezone) : ""}</p>
        <h1 className="display mt-2 text-4xl tracking-tight sm:text-5xl">Mercado</h1>
        <p className="mt-2 max-w-2xl text-muted">O que a Wendy acompanha na B3 e nas techs americanas. É só acompanhamento: sem recomendação, sem previsão, sem ordens. Os dados têm atraso e cada número mostra o dia a que se refere.</p>

        {!o ? (
          <div className="card mt-8 px-6 py-10 text-center">
            <p className="font-semibold">Não consegui ler o mercado agora</p>
            <p className="mt-1 text-sm text-muted">A Wendy não mostra dados que não conseguiu ler. Tente de novo em instantes.</p>
          </div>
        ) : (
          <>
            <section className="mt-8" aria-labelledby="h-panorama">
              <h2 id="h-panorama" className="eyebrow">
                Panorama{o.asOf ? ` · pregão de ${fmtDay(o.asOf)}` : ""}
              </h2>
              {o.references.length ? (
                <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                  {o.references.map((q) => (
                    <li key={q.symbol}>
                      <Link href={`/mercado/${encodeURIComponent(q.symbol)}`} className="card flex min-h-11 items-center justify-between gap-3 px-5 py-4 hover:bg-surface-2">
                        <span>
                          <span className="block text-sm text-muted">{nameOf(q.symbol)}</span>
                          <span className="num mt-1 block text-2xl font-semibold">{fmtPrice(q.lastClose, kindOf(q.symbol, q.market))}</span>
                          <span className={`num block text-sm ${tone(q.changePct)}`}>
                            {arrow(q.changePct)}
                            {fmtChange(q.changePct)} <span className="text-faint">· {fmtDay(q.asOf)}</span>
                          </span>
                        </span>
                        <Sparkline values={q.spark ?? []} up={q.changePct === null ? null : q.changePct >= 0} />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-muted">Ainda não há histórico das referências. Aparece depois da próxima verificação (dias úteis, {o.routine?.localTime ?? "18:30"}).</p>
              )}
              {summary ? <p className="mt-4 max-w-2xl text-ink-2">{summary}</p> : null}
              <p className="mt-2 text-sm text-faint">Fonte: brapi.dev. {o.note} O dólar não aparece porque o plano gratuito da fonte não inclui câmbio.</p>
            </section>

            <section className="mt-10 grid gap-6 sm:grid-cols-2" aria-label="Maiores movimentos">
              <div>
                <h2 className="eyebrow">Maiores altas</h2>
                {o.gainers.length ? <ul className="card mt-3 divide-y divide-line-2 overflow-hidden">{o.gainers.map((q) => <QuoteLine key={q.symbol} q={q} />)}</ul> : <p className="mt-3 text-muted">Sem dados ainda.</p>}
              </div>
              <div>
                <h2 className="eyebrow">Maiores quedas</h2>
                {o.losers.length ? <ul className="card mt-3 divide-y divide-line-2 overflow-hidden">{o.losers.map((q) => <QuoteLine key={q.symbol} q={q} />)}</ul> : <p className="mt-3 text-muted">Sem dados ainda.</p>}
              </div>
              <p className="text-sm text-faint sm:col-span-2">Entre os ativos da sua lista, ignorando os de volume muito baixo (neles qualquer movimento parece grande).</p>
            </section>

            <section className="mt-10" aria-labelledby="h-obs">
              <h2 id="h-obs" className="eyebrow">
                Observações dos últimos 30 dias
              </h2>
              <p className="mt-1 text-sm text-muted">O monitor registra o que foge do padrão recente de cada ativo. Uma observação não diz por que aconteceu nem o que fazer.</p>
              {o.alerts.length ? (
                <ul className="card mt-3 divide-y divide-line-2 overflow-hidden">
                  {o.alerts.map((a) => (
                    <li key={a.id} className="px-4 py-3">
                      <Link href={`/mercado/${encodeURIComponent(a.symbol)}`} className="inline-flex min-h-11 flex-col justify-center lg:min-h-8">
                        <span className="font-medium">
                          {a.symbol} <span className="text-sm font-normal text-muted">· pregão de {fmtDay(a.day)} · {KIND[a.kind] ?? a.kind}</span>
                        </span>
                        <span className="text-sm text-ink-2">{a.explanation}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-muted">Nada fora do comum nos últimos 30 dias.</p>
              )}
            </section>

            <section className="mt-10" aria-labelledby="h-lista">
              <h2 id="h-lista" className="eyebrow">
                Sua lista
              </h2>
              <div className="mt-3">
                <MarketWatchlist overview={o} canWrite={!ACTION_UNAVAILABLE_REASON} />
              </div>
            </section>
            <p className="mt-10 text-sm text-faint">
              {o.routine ? `Verificação automática nos dias úteis às ${o.routine.localTime}, depois do fechamento da B3, com o Mac ligado.` : "Verificação automática ainda não ativada."}
              {o.lastRun ? ` Última: ${fmtDay(o.lastRun.date)}${o.lastRun.status === "FAILED" ? " (falhou)" : ""}.` : ""}
            </p>
          </>
        )}
      </main>
    </>
  );
}
