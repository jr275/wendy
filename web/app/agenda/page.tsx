import Link from "next/link";
import { Suspense } from "react";
import { ApiDown } from "@/components/api-down";
import { TopBar } from "@/components/top-bar";
import { dateLong } from "@/lib/format";
import { agendaFor, principalState, today as getToday, reasonerLabel, type AgendaDay } from "@/lib/wendy";

const PERIODS = [7, 14, 30];

export default function Page({ searchParams }: { searchParams: Promise<{ dias?: string }> }) {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl px-4 py-16 sm:px-6" aria-busy><div className="card h-64 animate-pulse" /></main>}>
      <Agenda searchParams={searchParams} />
    </Suspense>
  );
}

async function Agenda({ searchParams }: { searchParams: Promise<{ dias?: string }> }) {
  const q = Number((await searchParams).dias);
  const days = PERIODS.includes(q) ? q : 7;
  const st = await principalState();
  if (st.status === "down") return <ApiDown />;
  const p = st.status === "ok" ? st.principal : null;
  const today = p ? await getToday(p.id).catch(() => null) : null;
  const a = p ? await agendaFor(p.id, days) : null;
  const tz = a?.timeZone ?? "America/Sao_Paulo";
  const hm = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  const dayLabel = (d: AgendaDay) => new Date(`${d.day}T12:00:00Z`).toLocaleDateString("pt-BR", { timeZone: "UTC", weekday: "long", day: "2-digit", month: "long" });
  const quiet = a ? a.days.every((d) => !d.meetings.length) : false;
  return (
    <>
      <TopBar reasoner={today ? reasonerLabel(today.insights ?? []) : null} />
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-10 sm:px-6">
        <Link href="/" className="inline-flex min-h-11 items-center text-sm text-muted hover:text-ink lg:min-h-8">
          ← Hoje
        </Link>
        <p className="eyebrow mt-2">{p ? dateLong(new Date(), p.timezone) : ""}</p>
        <h1 className="display mt-2 text-4xl tracking-tight sm:text-5xl">Agenda</h1>
        <p className="mt-2 max-w-2xl text-muted">Uma leitura da sua agenda: conflitos, falta de pausa, dias pesados e horários livres que dá para proteger. A Wendy só sugere: não aceita, recusa, remarca nem cancela nada, e não escreve na agenda do Google.</p>
        <nav className="mt-4 flex flex-wrap gap-2" aria-label="Período">
          {PERIODS.map((d) => (
            <Link key={d} href={`/agenda?dias=${d}`} aria-current={d === days ? "page" : undefined} className={`inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium lg:min-h-9 ${d === days ? "border-accent bg-surface-2" : "border-line hover:bg-surface-2"}`}>
              {d} dias
            </Link>
          ))}
        </nav>
        {!a ? (
          <div className="card mt-8 px-6 py-10 text-center">
            <p className="font-semibold">Não consegui ler a agenda agora</p>
            <p className="mt-1 text-sm text-muted">A Wendy não mostra horários que não conseguiu ler. Tente de novo em instantes.</p>
          </div>
        ) : (
          <>
            <p className="mt-6 text-sm text-ink-2" role="status">
              {a.summary.meetings} {a.summary.meetings === 1 ? "compromisso" : "compromissos"} · {a.summary.conflicts} {a.summary.conflicts === 1 ? "conflito" : "conflitos"} · {a.summary.noBreakRuns} {a.summary.noBreakRuns === 1 ? "sequência sem pausa" : "sequências sem pausa"} · {a.summary.overloadedDays} {a.summary.overloadedDays === 1 ? "dia pesado" : "dias pesados"} · {a.summary.focusBlocks} {a.summary.focusBlocks === 1 ? "bloco de foco sugerido" : "blocos de foco sugeridos"}
            </p>
            {quiet ? <p className="mt-2 text-muted">Não há compromissos nesse período. Os horários livres abaixo são só sugestões.</p> : null}
            <ul className="mt-6 space-y-4">
              {a.days.map((d) => (
                <li key={d.day} className="card px-5 py-4">
                  <h2 className="font-semibold capitalize">{dayLabel(d)}</h2>
                  {!d.workingDay ? <p className="text-sm text-faint">Fora dos dias de trabalho.</p> : null}
                  {d.meetings.length ? (
                    <ul className="mt-2 space-y-1 text-sm">
                      {d.meetings.map((m) => (
                        <li key={m.id}>
                          <span className="num text-muted">{hm(m.start)}–{hm(m.end)}</span> {m.title}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-sm text-muted">Sem compromissos.</p>
                  )}
                  {d.conflicts.map((c) => (
                    <p key={`${c.a.id}-${c.b.id}`} className="mt-2 text-sm text-bad">
                      Conflito: “{c.a.title}” e “{c.b.title}” se sobrepõem por {c.overlapMinutes} min.
                    </p>
                  ))}
                  {d.noBreak.map((n) => (
                    <p key={n.meetingIds.join("-")} className="mt-2 text-sm text-ink-2">
                      Sem pausa: {n.count} reuniões seguidas, {Math.floor(n.totalMinutes / 60)} h {n.totalMinutes % 60} min.
                    </p>
                  ))}
                  {d.overloaded ? (
                    <p className="mt-2 text-sm text-ink-2">
                      Dia pesado: {Math.floor(d.overloaded.minutes / 60)} h {d.overloaded.minutes % 60} min de reunião (o limite é {d.overloaded.limit / 60} h).
                    </p>
                  ) : null}
                  {d.focus.map((f) => (
                    <p key={f.start} className="mt-2 text-sm text-accent-ink">
                      Sugestão de foco: {hm(f.start)}–{hm(f.end)} ({f.minutes} min livres).
                    </p>
                  ))}
                </li>
              ))}
            </ul>
            <section className="mt-8" aria-labelledby="h-lembretes">
              <h2 id="h-lembretes" className="eyebrow">
                Lembretes em camadas
              </h2>
              {a.reminders.length ? (
                <ul className="mt-3 space-y-1 text-sm">
                  {a.reminders.slice(0, 20).map((r) => (
                    <li key={`${r.meetingId}-${r.label}`}>
                      <span className="num text-muted">{new Date(r.at).toLocaleString("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span> · {r.label}: {r.title}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-muted">Nenhum lembrete pendente: não há compromissos à frente.</p>
              )}
              <p className="mt-3 text-sm text-faint">{a.departure}</p>
            </section>
            <section className="mt-8" aria-labelledby="h-regras">
              <h2 id="h-regras" className="eyebrow">
                Regras usadas
              </h2>
              <ul className="mt-3 space-y-1 text-sm text-muted">
                {a.rules.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </section>
          </>
        )}
      </main>
    </>
  );
}
