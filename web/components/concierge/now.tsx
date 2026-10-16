import Link from "next/link";

/**
 * "Agora": what is waiting for the principal, at the top of Hoje (it used to live far below the
 * fold, and an approval on a phone was invisible). Only real things — an approval a run or an
 * action is stopped on, a commitment or a memory to confirm — each linking to the exact place to
 * decide. Shown only when there is something; an empty "nothing to do" widget is noise.
 */
export interface AttentionItem {
  key: string;
  tone: "warn" | "info";
  title: string;
  detail: string;
  href: string;
}

const SHOWN = 4;

export function Now({ items, className = "mt-10" }: { items: AttentionItem[]; className?: string }) {
  if (!items.length) return null;
  const shown = items.slice(0, SHOWN);
  const rest = items.length - shown.length;
  return (
    <section aria-label="Agora" className={`${className} w-full text-left`}>
      <h2 className="eyebrow mb-3">
        Agora · {items.length} {items.length === 1 ? "coisa pede" : "coisas pedem"} você
      </h2>
      <ul className="card divide-y divide-line-2 overflow-hidden">
        {shown.map((n) => (
          <li key={n.key}>
            <Link href={n.href} className="flex items-start gap-4 px-5 py-4 transition-colors duration-[var(--dur-1)] hover:bg-surface-2">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.tone === "warn" ? "bg-warn" : "bg-info"}`} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{n.title}</span>
                {n.detail ? <span className="mt-0.5 block truncate text-sm text-muted">{n.detail}</span> : null}
              </span>
              <span className="text-faint" aria-hidden>
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {rest > 0 ? <p className="mt-2 text-sm text-muted">e mais {rest} abaixo, em “Hoje”.</p> : null}
    </section>
  );
}
