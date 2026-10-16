"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addMarketAsset, removeMarketAsset } from "@/lib/actions";
import { fmtChange, fmtDay, fmtPrice } from "@/lib/marketChart";
import { kindOf } from "@/lib/marketSummary";
import type { MarketOverview } from "@/lib/wendy";

const SOURCE: Record<string, string> = { liquidity: "entre as maiores da B3", config: "da sua configuração", user: "adicionado por você" };

/**
 * The list the monitor follows. Adding an asset checks it with one request to the data provider; removing one is permanent (it stays out after
 * the weekly refresh). Nothing here buys, sells or messages anyone: it only chooses what is watched.
 */
export function MarketWatchlist({ overview, canWrite }: { overview: MarketOverview; canWrite: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const assets = overview.watchlist.filter((w) => w.role === "asset" && w.active && !w.excluded);
  const removed = overview.watchlist.filter((w) => w.excluded);
  const b = overview.budget;

  const run = (fn: () => ReturnType<typeof addMarketAsset>, okText: string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error });
      if (r.ok) {
        setCode("");
        router.refresh();
      }
    });

  return (
    <div>
      <p className="text-sm text-muted">
        Acompanhando {assets.length} {assets.length === 1 ? "ativo" : "ativos"}: cada verificação usa {b.perSweep} consultas à brapi, cerca de {b.perMonthEstimate.toLocaleString("pt-BR")} por mês de {b.monthlyQuota.toLocaleString("pt-BR")} do plano gratuito. O limite é {b.maxAssets - 2} ativos.
      </p>
      {canWrite ? (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) run(() => addMarketAsset(code), "Ativo adicionado. O histórico já foi guardado.");
          }}
        >
          <label htmlFor="market-add" className="sr-only">
            Código do ativo
          </label>
          <input id="market-add" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Código (PETR4, AAPL…)" maxLength={12} autoComplete="off" className="min-h-11 w-48 rounded-md border border-line bg-surface px-3 text-sm lg:min-h-9" />
          <button type="submit" disabled={pending || !code.trim()} className="inline-flex min-h-11 items-center rounded-md border border-line px-4 text-sm font-medium hover:bg-surface-2 disabled:opacity-60 lg:min-h-9">
            {pending ? "Consultando…" : "Adicionar"}
          </button>
          <span role="status" className={`text-sm ${msg?.ok ? "text-good" : "text-bad"}`}>
            {msg?.text}
          </span>
        </form>
      ) : (
        <p className="mt-3 text-sm text-faint">Editar a lista fica disponível só quando a Wendy está ligada neste computador.</p>
      )}

      <ul className="card mt-4 divide-y divide-line-2 overflow-hidden">
        {assets.map((w) => (
          <li key={w.symbol} className="flex items-center gap-3 px-4 py-2">
            <Link href={`/mercado/${encodeURIComponent(w.symbol)}`} className="inline-flex min-h-11 min-w-0 flex-1 flex-col justify-center lg:min-h-9">
              <span className="font-medium">
                {w.symbol} <span className="text-xs font-normal text-faint">{w.market === "B3" ? "B3" : "EUA"} · {SOURCE[w.source] ?? w.source}</span>
              </span>
              <span className="num text-sm text-muted">{w.lastClose !== null ? `${fmtPrice(w.lastClose, kindOf(w.symbol, w.market))} · ${fmtChange(w.changePct)}${w.asOf ? ` · ${fmtDay(w.asOf)}` : ""}` : "sem histórico ainda"}</span>
            </Link>
            {canWrite ? (
              <button type="button" disabled={pending} onClick={() => run(() => removeMarketAsset(w.symbol), `${w.symbol} removido da lista.`)} aria-label={`Remover ${w.symbol} da lista`} className="inline-flex min-h-11 items-center rounded-md px-3 text-sm text-muted hover:bg-surface-2 hover:text-bad disabled:opacity-60 lg:min-h-9">
                Remover
              </button>
            ) : null}
          </li>
        ))}
        {!assets.length ? <li className="px-4 py-6 text-muted">Nenhum ativo na lista.</li> : null}
      </ul>

      {removed.length ? (
        <details className="mt-3">
          <summary className="min-h-11 cursor-pointer text-sm text-muted lg:min-h-8">Removidos por você ({removed.length})</summary>
          <ul className="mt-2 flex flex-wrap gap-2">
            {removed.map((w) => (
              <li key={w.symbol}>
                {canWrite ? (
                  <button type="button" disabled={pending} onClick={() => run(() => addMarketAsset(w.symbol), `${w.symbol} voltou para a lista.`)} className="inline-flex min-h-11 items-center rounded-full border border-line px-3 text-sm hover:bg-surface-2 disabled:opacity-60 lg:min-h-8">
                    {w.symbol} · restaurar
                  </button>
                ) : (
                  <span className="text-sm text-muted">{w.symbol}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
