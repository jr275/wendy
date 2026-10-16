import type { ReviewItemView, ReviewView } from "@/lib/wendy";

/**
 * The weekly review, as the server computed it (src/review/weekly.ts). Presentational only: it shows what it is given and the rule that picked
 * the "next" item. Nothing here is inferred; an empty review says it is empty.
 */
const KIND: Record<ReviewItemView["kind"], string> = { task: "Tarefa", commitment: "Compromisso", meeting: "Reunião", approval: "Aprovação" };

function when(at: string | null, tz: string): string {
  if (!at) return "";
  const d = new Date(at);
  return `${d.toLocaleDateString("pt-BR", { timeZone: tz, weekday: "short", day: "numeric", month: "short" })} · ${d.toLocaleTimeString("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" })}`;
}
const dayLabel = (day: string, tz: string) => {
  const s = new Date(`${day}T12:00:00Z`).toLocaleDateString("pt-BR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
  void tz;
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const dayOf = (at: string, tz: string) => new Date(at).toLocaleDateString("en-CA", { timeZone: tz });

function Row({ i, tz, tone = "" }: { i: ReviewItemView; tz: string; tone?: string }) {
  return (
    <li className="flex items-baseline gap-3 px-5 py-3">
      <span className="w-24 shrink-0 text-micro uppercase tracking-wide text-muted">{KIND[i.kind]}</span>
      <span className="min-w-0 flex-1">
        <span className="block">{i.title}</span>
        {i.at ? <span className={`num mt-0.5 block text-sm ${tone || "text-muted"}`}>{when(i.at, tz)}</span> : null}
      </span>
    </li>
  );
}

function Block({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="eyebrow">{title}</h2>
        {hint ? <span className="text-sm text-faint">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function WeekReview({ review, timeZone }: { review: ReviewView; timeZone: string }) {
  const days = [...new Set(review.upcoming.map((i) => dayOf(i.at!, timeZone)))];
  const busy = new Map(review.load.map((d) => [d.day, d]));
  return (
    <div>
      {review.next ? (
        <section aria-label="Próxima ação" className="card border-accent/40 p-5">
          <p className="eyebrow">Comece por aqui</p>
          <p className="mt-2 text-lead font-medium">{review.next.item.title}</p>
          <p className="mt-2 text-sm text-muted">
            {KIND[review.next.item.kind]}
            {review.next.item.at ? ` · ${when(review.next.item.at, timeZone)}` : ""}. <span className="text-faint">Regra: {review.next.rule}</span>
          </p>
        </section>
      ) : (
        <section aria-label="Próxima ação" className="card p-5">
          <p className="font-medium">{review.empty ? "Nada pendente nem marcado para os próximos 7 dias." : "Nada com data para os próximos 7 dias."}</p>
          <p className="mt-1 text-sm text-muted">A Wendy só mostra o que está nos seus registros; nenhuma sugestão foi inventada.</p>
        </section>
      )}

      {review.waitingOnYou.length ? (
        <Block title="Esperando você" hint="paradas até você aprovar ou recusar">
          <ul className="card divide-y divide-line-2 overflow-hidden">{review.waitingOnYou.map((i) => <Row key={`${i.kind}-${i.id}`} i={i} tz={timeZone} />)}</ul>
        </Block>
      ) : null}

      {review.overdue.length ? (
        <Block title="Vencido" hint={`${review.overdue.length} ${review.overdue.length === 1 ? "item passou" : "itens passaram"} do prazo`}>
          <ul className="card divide-y divide-line-2 overflow-hidden">{review.overdue.map((i) => <Row key={`${i.kind}-${i.id}`} i={i} tz={timeZone} tone="text-bad" />)}</ul>
        </Block>
      ) : null}

      {days.length ? (
        <Block title={`Próximos ${review.windowDays} dias`}>
          <div className="grid gap-4">
            {days.map((d) => {
              const rows = review.upcoming.filter((i) => dayOf(i.at!, timeZone) === d);
              const load = busy.get(d);
              return (
                <div key={d}>
                  <p className="mb-1.5 flex flex-wrap items-center gap-2 text-sm font-medium">
                    {dayLabel(d, timeZone)}
                    {load?.busy ? (
                      <span className="rounded-full bg-warn-soft px-2 py-0.5 text-micro font-normal text-warn" title="Regra simples: 4 ou mais itens com data no mesmo dia">
                        dia cheio · {load.count} itens
                      </span>
                    ) : null}
                  </p>
                  <ul className="card divide-y divide-line-2 overflow-hidden">{rows.map((i) => <Row key={`${i.kind}-${i.id}`} i={i} tz={timeZone} />)}</ul>
                </div>
              );
            })}
          </div>
        </Block>
      ) : null}

      {review.undated.length ? (
        <Block title="Sem data" hint="abertas, sem prazo: a Wendy não escolhe entre elas">
          <ul className="card divide-y divide-line-2 overflow-hidden">{review.undated.map((i) => <Row key={`${i.kind}-${i.id}`} i={i} tz={timeZone} />)}</ul>
        </Block>
      ) : null}

      <Block title="Fechado na última semana">
        <p className="text-muted">
          {review.closedLastWeek.tasks + review.closedLastWeek.commitments === 0
            ? "Nada foi marcado como concluído nos últimos 7 dias."
            : `${review.closedLastWeek.tasks} ${review.closedLastWeek.tasks === 1 ? "tarefa" : "tarefas"} e ${review.closedLastWeek.commitments} ${review.closedLastWeek.commitments === 1 ? "compromisso" : "compromissos"} concluídos.`}
        </p>
      </Block>
    </div>
  );
}
