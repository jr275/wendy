import Link from "next/link";
import { Suspense } from "react";
import { ApiDown } from "@/components/api-down";
import { TopBar } from "@/components/top-bar";
import { WeekReview } from "@/components/week-review";
import { dateLong } from "@/lib/format";
import { principalState, reasonerLabel, today as getToday, weeklyReviewFor } from "@/lib/wendy";

export default function Page() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl px-4 py-16 sm:px-6" aria-busy><div className="card h-64 animate-pulse" /></main>}>
      <Week />
    </Suspense>
  );
}

async function Week() {
  const st = await principalState();
  if (st.status === "down") return <ApiDown />;
  const p = st.status === "ok" ? st.principal : null;
  const today = p ? await getToday(p.id).catch(() => null) : null;
  const reasoner = today ? reasonerLabel(today.insights ?? []) : null;
  const review = p ? await weeklyReviewFor(p.id) : null;
  return (
    <>
      <TopBar reasoner={reasoner} />
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-10 sm:px-6">
        <Link href="/" className="inline-flex min-h-11 items-center text-sm text-muted hover:text-ink lg:min-h-8">
          ← Hoje
        </Link>
        <p className="eyebrow mt-2">{p ? dateLong(new Date(), p.timezone) : ""}</p>
        <h1 className="display mt-2 text-4xl tracking-tight sm:text-5xl">Revisão da semana</h1>
        <p className="mt-2 text-muted">Uma leitura dos seus registros: tarefas, compromissos, reuniões e o que espera você. Sem palpites.</p>
        <div className="mt-8">
          {p && review ? (
            <WeekReview review={review} timeZone={p.timezone} />
          ) : (
            <div className="card px-6 py-10 text-center">
              <p className="font-semibold">Não consegui ler a revisão agora</p>
              <p className="mt-1 text-sm text-muted">A Wendy não mostra uma revisão que não conseguiu ler. Tente de novo em instantes.</p>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
