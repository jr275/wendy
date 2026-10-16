import { notFound } from "next/navigation";
import { Suspense } from "react";
import { TopBar } from "@/components/top-bar";
import { WeekReview } from "@/components/week-review";
import type { ReviewView } from "@/lib/wendy";

/**
 * DEV ONLY — the weekly review from FICTITIOUS data (nothing is read from Wendy). Two reviews: a full one (an approval waiting, overdue items,
 * a full day, undated tasks) and an empty one, which must say it is empty and invent nothing.
 */
const h = (n: number) => new Date(Date.parse("2026-10-15T15:00:00.000Z") + n * 3_600_000).toISOString();
const FULL: ReviewView = {
  generatedAt: h(0),
  windowDays: 7,
  waitingOnYou: [{ kind: "approval", id: "ap1", title: "tasks.create: revisar a proposta (exemplo)", at: null }],
  overdue: [
    { kind: "task", id: "o1", title: "Enviar o contrato à Maria (exemplo)", at: h(-50) },
    { kind: "commitment", id: "o2", title: "Ligar para o contador (exemplo)", at: h(-5) },
  ],
  upcoming: [
    { kind: "meeting", id: "u1", title: "Reunião com o time (exemplo)", at: h(2) },
    { kind: "task", id: "u2", title: "Revisar a proposta (exemplo)", at: h(3) },
    { kind: "task", id: "u3", title: "Fechar o orçamento (exemplo)", at: h(4) },
    { kind: "commitment", id: "u4", title: "Responder o cliente (exemplo)", at: h(5) },
    { kind: "meeting", id: "u5", title: "Almoço com a Ana (exemplo)", at: h(30) },
  ],
  undated: [{ kind: "task", id: "n1", title: "Organizar as fotos da viagem (exemplo)", at: null }],
  load: [{ day: "2026-10-15", count: 4, busy: true }, { day: "2026-10-16", count: 1, busy: false }],
  closedLastWeek: { tasks: 2, commitments: 1 },
  next: { item: { kind: "approval", id: "ap1", title: "tasks.create: revisar a proposta (exemplo)", at: null }, rule: "Primeiro o que está parado esperando a sua aprovação." },
  empty: false,
};
const EMPTY: ReviewView = { generatedAt: h(0), windowDays: 7, overdue: [], upcoming: [], undated: [], waitingOnYou: [], load: [], closedLastWeek: { tasks: 0, commitments: 0 }, next: null, empty: true };

async function ThemeOverride({ searchParams }: { searchParams: Promise<{ theme?: string }> }) {
  return (await searchParams).theme === "dark" ? <script dangerouslySetInnerHTML={{ __html: 'document.documentElement.dataset.theme="dark"' }} /> : null;
}

export default function WeekFixtures({ searchParams }: { searchParams: Promise<{ theme?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <>
      <Suspense fallback={null}>
        <ThemeOverride searchParams={searchParams} />
      </Suspense>
      <TopBar reasoner={null} />
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-10 sm:px-6">
        <p className="eyebrow">Desenvolvimento · dados fictícios</p>
        <h1 className="display mt-3 text-4xl tracking-tight">Revisão da semana</h1>
        <h2 className="eyebrow mt-10">1 · Revisão cheia</h2>
        <div className="mt-3"><WeekReview review={FULL} timeZone="America/Sao_Paulo" /></div>
        <h2 className="eyebrow mt-16">2 · Revisão vazia (não inventa nada)</h2>
        <div className="mt-3"><WeekReview review={EMPTY} timeZone="America/Sao_Paulo" /></div>
      </main>
    </>
  );
}
