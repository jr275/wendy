import type { MarketView } from "@/lib/wendy";

/**
 * "Mercado": statistical observations about assets Wendy watches (B3's most traded and a list of US tech companies). It is MONITORING: it says
 * what is unusual compared with recent days, with the numbers. It never says to buy or sell, never gives a target or a probability, and the
 * data is delayed. Wendy places no orders.
 */
const KIND: Record<string, string> = { MOVE_OUTLIER: "Variação fora do comum", VOLUME_SPIKE: "Volume muito acima do normal", RANGE_EXPANSION: "Oscilação maior que a média" };
const day = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", timeZone: "UTC" });

export function MarketWatch({ market }: { market: MarketView | null }) {
  if (!market) return <p className="text-muted">Não consegui ler o monitor de mercado agora.</p>;
  const bySymbol = new Map<string, MarketView["alerts"]>();
  for (const a of market.alerts) bySymbol.set(a.symbol, [...(bySymbol.get(a.symbol) ?? []), a]);
  return (
    <div>
      <p className="text-sm text-muted">
        {market.routine ? (market.routine.enabled ? `Verificação automática nos dias úteis às ${market.routine.localTime}, depois do fechamento da B3, com o Mac ligado.` : "Verificação automática desativada.") : "Monitor ainda não ativado."}
        {market.lastRun ? ` Última verificação: ${market.lastRun.date}${market.lastRun.status === "FAILED" ? " (falhou)" : ""}.` : ""} Informações com atraso, só para acompanhamento: não é recomendação de compra ou venda.
      </p>
      {market.alerts.length ? (
        <ul className="card mt-3 divide-y divide-line-2 overflow-hidden">
          {[...bySymbol.entries()].map(([symbol, list]) => (
            <li key={symbol} className="px-5 py-4">
              <span className="font-medium">{symbol}</span>
              <span className="ml-2 text-sm text-muted">pregão de {day(list[0]!.observedAt)}</span>
              <ul className="mt-1 space-y-1">
                {list.map((a) => (
                  <li key={a.id} className="text-sm text-ink-2">
                    <span className="text-micro uppercase tracking-wide text-faint">{KIND[a.kind] ?? a.kind} · </span>
                    {a.explanation}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-muted">Nada fora do comum nos últimos 7 dias.</p>
      )}
      {market.symbolsWithAlerts > bySymbol.size ? <p className="mt-2 text-sm text-faint">Mostrando os {bySymbol.size} casos mais fortes de {market.symbolsWithAlerts} ativos com observações nos últimos 7 dias.</p> : null}
    </div>
  );
}
