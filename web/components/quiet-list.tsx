import Link from "next/link";
import { anatomyOf } from "@/lib/proactive";
import type { InsightCard } from "@/lib/wendy";

/**
 * "Registrados sem interromper": what Wendy noticed but judged below the line worth interrupting you
 * for. Collapsed by default (progressive disclosure); each entry opens the insight with its evidence.
 * Same anatomy as a surfaced finding — origin, why it appeared, what action exists — all from her records.
 */
export function QuietList({ items, total, timeZone }: { items: InsightCard[]; total: number; timeZone: string }) {
  if (!items.length) return null;
  return (
    <details className="group mt-6">
      <summary className="flex min-h-6 cursor-pointer list-none items-center gap-2 rounded text-sm text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-faint transition-transform duration-[var(--dur-1)] group-open:rotate-90">
          ›
        </span>
        <span>
          Registrados sem interromper <span className="num text-muted">{total}</span>
        </span>
      </summary>
      <p className="mt-2 text-sm text-muted">A Wendy percebeu estas coisas, mas julgou que não valiam uma interrupção. Estão aqui para você consultar.</p>
      <ul className="card mt-3 divide-y divide-line-2 overflow-hidden">
        {items.map((i) => {
          const a = anatomyOf(i);
          return (
            <li key={i.id}>
              <Link href={`/insight/${i.id}`} className="block px-5 py-4 transition-colors duration-[var(--dur-1)] hover:bg-surface-2">
                <span className="flex items-baseline justify-between gap-4">
                  <span className="font-medium">{a.detected}</span>
                  <span className="num shrink-0 text-xs text-muted">{new Date(i.created_at).toLocaleDateString("pt-BR", { timeZone, day: "2-digit", month: "short" })}</span>
                </span>
                <span className="mt-1 block text-sm text-ink-2">
                  {a.origin} · {a.action.text}
                </span>
                {a.whyShown ? <span className="mt-0.5 block text-sm text-muted">{a.whyShown}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
      {total > items.length ? <p className="mt-2 text-sm text-muted">Mostrando os {items.length} mais recentes de {total}.</p> : null}
    </details>
  );
}
