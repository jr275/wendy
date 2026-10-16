import Link from "next/link";
import { EVENT_LABEL, stripRefs } from "@/lib/format";
import { anatomyOf, NATURE_LABEL } from "@/lib/proactive";
import type { InsightCard } from "@/lib/wendy";

/**
 * A finding Wendy raised: what she detected, where it came from, why it appeared and what action
 * exists (and of what nature) — every line from her own records (lib/proactive.ts).
 */
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

export function InsightTile({ i, n }: { i: InsightCard; n: number }) {
  const a = anatomyOf(i);
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
      {i.narrative ? <p className="mt-2 line-clamp-3 text-body leading-relaxed text-ink-2">{stripRefs(i.narrative)}</p> : null}
      <dl className="mt-4 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[7.5rem_1fr]">
        <dt className="eyebrow pt-0.5">Origem</dt>
        <dd className="text-ink-2">{a.origin}</dd>
        {a.whyShown ? (
          <>
            <dt className="eyebrow pt-0.5">Por que apareceu</dt>
            <dd className="text-ink-2">{a.whyShown}</dd>
          </>
        ) : null}
        <dt className="eyebrow pt-0.5">{NATURE_LABEL[a.action.nature]}</dt>
        <dd className={a.action.nature === "suggestion" ? "font-medium text-warn" : "text-ink-2"}>{a.action.text}</dd>
      </dl>
      <p className="mt-3 text-sm text-muted">
        {(i.claims ?? []).length} afirmações validadas · ver evidências <span aria-hidden>→</span>
      </p>
    </Link>
  );
}

