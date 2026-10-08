import { Suspense } from "react";
import { MemoryRow } from "@/components/memory-row";
import { TopBar } from "@/components/top-bar";
import { WendySidebar } from "@/components/wendy-chat";
import { memories as getMemories, principal as getPrincipal, reasonerLabel, today as getToday, type MemoryItem } from "@/lib/wendy";

export default function Page() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl px-4 py-16 sm:px-6" aria-busy><div className="card h-96 animate-pulse" /></main>}>
      <Memory />
    </Suspense>
  );
}

const firstName = (n: string) => n.split(/\s+/)[0] ?? n;

function Group({ title, hint, items, tagFor }: { title: string; hint?: string; items: MemoryItem[]; tagFor?: (m: MemoryItem) => string | undefined }) {
  if (!items.length) return null;
  return (
    <section className="mt-12">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <span className="num text-sm text-faint">{items.length}</span>
        {hint ? <span className="text-sm text-muted">{hint}</span> : null}
      </div>
      <ul className="mt-4 grid gap-3">
        {items.map((m) => (
          <MemoryRow key={m.id} id={m.id} content={m.content} status={m.status} needsReview={m.freshness.needsReview} tag={tagFor?.(m)} about={m.full_name} />
        ))}
      </ul>
    </section>
  );
}

async function Memory() {
  const p = await getPrincipal();
  if (!p) return null;
  const [all, t] = await Promise.all([getMemories(p.id), getToday(p.id)]);
  const proposed = all.filter((m) => m.status === "PROPOSED");
  const active = all.filter((m) => m.status === "ACTIVE");
  const review = active.filter((m) => m.freshness.needsReview);
  const steady = active.filter((m) => !m.freshness.needsReview);
  const kind = (m: MemoryItem) => (m.kind === "PREFERENCE" ? "Preferência" : "Fato");

  return (
    <>
      <TopBar reasoner={reasonerLabel(t.insights ?? [])} />
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-10 sm:px-6 sm:pt-14">
        <p className="eyebrow">Memória da Wendy</p>
        <h1 className="mt-4 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
          O que a Wendy sabe
          <span className="block text-muted">sobre você, {firstName(p.display_name)}.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-2">
          Cada memória mostra de onde veio. A Wendy só usa o que você confirmou, e você pode fazê-la esquecer qualquer coisa a qualquer momento.
        </p>

        <Group title="Para confirmar" hint="nada daqui é usado até você confirmar" items={proposed} tagFor={kind} />
        <Group title="Isto ainda vale?" hint="memórias antigas perdem peso com o tempo" items={review} tagFor={kind} />
        <Group title="Confirmado" items={steady} tagFor={kind} />

        {!all.length ? (
          <div className="card mt-12 p-8 text-center">
            <p className="font-medium">A Wendy ainda não sabe nada sobre você.</p>
            <p className="mt-2 text-sm text-muted">Peça no chat: “Leia meu artigo na pasta sobre-mim para me conhecer melhor”.</p>
          </div>
        ) : null}
      </main>
      <WendySidebar suggestions={["Leia meu artigo na pasta sobre-mim para me conhecer melhor", "O que você sabe sobre mim?"]} />
    </>
  );
}
