import Link from "next/link";
import { Suspense } from "react";
import { ApiDown } from "@/components/api-down";
import { MarketChart } from "@/components/market-chart";
import { TopBar } from "@/components/top-bar";
import { fmtChange, fmtDay, fmtPrice } from "@/lib/marketChart";
import { kindOf, nameOf } from "@/lib/marketSummary";
import { marketAssetFor, principalState, today as getToday, reasonerLabel } from "@/lib/wendy";

const KIND: Record<string, string> = { MOVE_OUTLIER: "Variação fora do comum", VOLUME_SPIKE: "Volume muito acima do normal", RANGE_EXPANSION: "Oscilação maior que a média" };

export default function Page({ params }: { params: Promise<{ symbol: string }> }) {
  return (
    <Suspense fallback={<main className="mx-auto max-w-4xl px-4 py-16 sm:px-6" aria-busy><div className="card h-80 animate-pulse" /></main>}>
      <Asset params={params} />
    </Suspense>
  );
}

async function Asset({ params }: { params: Promise<{ symbol: string }> }) {
  const symbol = decodeURIComponent((await params).symbol).toUpperCase();
  const st = await principalState();
  if (st.status === "down") return <ApiDown />;
  const p = st.status === "ok" ? st.principal : null;
  const today = p ? await getToday(p.id).catch(() => null) : null;
  const a = p ? await marketAssetFor(p.id, symbol) : null;
  const kind = a ? kindOf(a.symbol, a.market) : "B3";
  return (
    <>
      <TopBar reasoner={today ? reasonerLabel(today.insights ?? []) : null} />
      <main className="mx-auto max-w-4xl px-4 pb-24 pt-10 sm:px-6">
        <Link href="/mercado" className="inline-flex min-h-11 items-center text-sm text-muted hover:text-ink lg:min-h-8">
          ← Mercado
        </Link>
        {!a ? (
          <div className="card mt-6 px-6 py-10 text-center">
            <p className="font-semibold">Não encontrei {symbol}</p>
            <p className="mt-1 text-sm text-muted">Esse ativo não está na sua lista, ou não consegui ler agora. Você pode adicioná-lo na página do Mercado.</p>
          </div>
        ) : (
          <>
            <p className="eyebrow mt-2">{a.market === "B3" ? "B3" : "EUA"}{a.role === "reference" ? " · referência" : ""}</p>
            <h1 className="display mt-2 text-4xl tracking-tight sm:text-5xl">{nameOf(a.symbol)}</h1>
            {a.stats ? (
              <p className="num mt-2 text-xl">
                {fmtPrice(a.stats.lastClose, kind)}{" "}
                <span className={`text-base ${a.stats.changePct === null ? "text-muted" : a.stats.changePct > 0 ? "text-good" : a.stats.changePct < 0 ? "text-bad" : "text-muted"}`}>
                  {a.stats.changePct !== null && a.stats.changePct !== 0 ? (a.stats.changePct > 0 ? "▲ " : "▼ ") : ""}
                  {fmtChange(a.stats.changePct)}
                </span>{" "}
                <span className="text-sm text-muted">· fechamento de {fmtDay(a.stats.asOf)} · máx {fmtPrice(a.stats.high, kind)} · mín {fmtPrice(a.stats.low, kind)} em {a.stats.days} pregões</span>
              </p>
            ) : null}
            {!a.active && a.role === "asset" ? <p className="mt-2 text-sm text-warn">Este ativo não está mais na sua lista, e o histórico não é atualizado.</p> : null}
            <div className="card mt-6 px-3 py-4 sm:px-5">
              <MarketChart symbol={a.symbol} kind={kind} candles={a.candles} alerts={a.alerts.map((x) => ({ day: x.day, kind: x.kind }))} />
            </div>
            <p className="mt-2 text-sm text-faint">Fonte: brapi.dev. {a.note}</p>

            <section className="mt-10" aria-labelledby="h-obs">
              <h2 id="h-obs" className="eyebrow">
                Observações do monitor (60 dias)
              </h2>
              {a.alerts.length ? (
                <ul className="card mt-3 divide-y divide-line-2 overflow-hidden">
                  {a.alerts.map((x) => (
                    <li key={x.id} className="px-4 py-3">
                      <span className="font-medium">
                        Pregão de {fmtDay(x.day)} <span className="text-sm font-normal text-muted">· {KIND[x.kind] ?? x.kind}</span>
                      </span>
                      <span className="block text-sm text-ink-2">{x.explanation}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-muted">Nenhuma observação para este ativo nos últimos 60 dias.</p>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}
