import { notFound } from "next/navigation";
import { Suspense } from "react";
import { TaskObject } from "@/components/concierge/task-object";
import { WendyPresence } from "@/components/concierge/presence";
import { TopBar } from "@/components/top-bar";
import type { PresenceState } from "@/lib/concierge";
import type { ExecutionView } from "@/lib/wendy";
import data from "./fixtures.json";

/**
 * DEV ONLY — every state of the concierge interface, rendered from REAL runtime views captured
 * against the simulated line (npm run concierge:fixtures). Read-only: nothing here acts.
 */
const PRESENCE: { state: PresenceState; label: string }[] = [
  { state: "idle", label: "Em repouso" },
  { state: "listening", label: "Ouvindo você" },
  { state: "thinking", label: "Pensando" },
  { state: "planning", label: "Planejando" },
  { state: "awaiting", label: "Aguardando você" },
  { state: "waiting", label: "Esperando" },
  { state: "calling", label: "Ligando" },
  { state: "connected", label: "Em ligação" },
  { state: "attention", label: "Atenção" },
  { state: "done", label: "Concluído" },
  { state: "error", label: "Não concluído" },
];

/** Dev QA: ?theme=dark renders the gallery in the dark theme without touching the saved preference. */
async function ThemeOverride({ searchParams }: { searchParams: Promise<{ theme?: string }> }) {
  return (await searchParams).theme === "dark" ? <script dangerouslySetInnerHTML={{ __html: 'document.documentElement.dataset.theme="dark"' }} /> : null;
}

export default function ConciergeGallery({ searchParams }: { searchParams: Promise<{ theme?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const fixtures = (data as { fixtures: { label: string; view: ExecutionView }[] }).fixtures;
  return (
    <>
      <Suspense fallback={null}>
        <ThemeOverride searchParams={searchParams} />
      </Suspense>
      <TopBar reasoner={null} />
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-10 sm:px-6">
        <p className="eyebrow">Desenvolvimento · dados de simulação</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Concierge — estados</h1>
        <p className="mt-2 text-muted">Cada cartão abaixo é um run real da Wendy contra a linha simulada. Nada aqui executa ações.</p>

        <section aria-label="Presença" className="mt-10">
          <h2 className="eyebrow mb-4">Presença</h2>
          <ul className="card grid grid-cols-3 gap-y-6 p-6 sm:grid-cols-4">
            {PRESENCE.map((p) => (
              <li key={p.state} className="flex flex-col items-center gap-2 text-center text-xs text-muted">
                <WendyPresence state={p.state} size="md" />
                {p.label}
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Tarefas" className="mt-12 grid gap-10">
          {fixtures.map((f) => (
            <div key={f.label}>
              <h2 className="eyebrow mb-3">{f.label}</h2>
              <TaskObject initial={f.view} live={false} interactive={false} />
            </div>
          ))}
        </section>
      </main>
    </>
  );
}
