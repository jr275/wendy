import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Now, type AttentionItem } from "@/components/concierge/now";
import { InsightTile } from "@/components/insight-tile";
import { ExecutionCard } from "@/components/execution-card";
import { TaskStatus } from "@/components/task-status";
import { TopBar } from "@/components/top-bar";
import { PHASE_LABEL, PHASE_MEANING, taskPhase, type TaskPhase } from "@/lib/taskStatus";
import type { ExecutionView, InsightCard } from "@/lib/wendy";

/**
 * DEV ONLY — the unified task states and the "Agora" block, from FICTITIOUS data (nothing here is
 * read from Wendy, and the buttons act on ids that do not exist). The state words come from the
 * real runtime's statuses (web/lib/taskStatus.ts); there is no "blocked" or "retrying" because the
 * runtime has neither.
 */
const base = { skillId: "task-management", skillName: "Tarefas", version: "1.0.0", error: null, output: null, createdAt: "2026-10-10T12:00:00Z", completedAt: null, models: [] as string[], children: [] as ExecutionView[] };
const steps = (a: ExecutionView["steps"][number]["status"][]): ExecutionView["steps"] => ["Entendendo o pedido", "Pedindo sua aprovação", "Aplicando nas suas tarefas"].map((label, i) => ({ id: `s${i}`, label, status: a[i]! }));
const ask: ExecutionView["approvals"][number] = { actionId: "00000000-0000-4000-8000-000000000001", tool: "tasks.create", label: "Criar tarefas", category: "WRITE", state: "AWAITING_APPROVAL", content: {}, items: ["Revisar a proposta (exemplo)", "Ligar para o contador (exemplo)"] };

const FIXTURES: { label: string; view: ExecutionView }[] = [
  { label: "Esperando você (aprovação de verdade pendente)", view: { ...base, id: "fx-1", status: "waiting_permission", steps: steps(["done", "waiting", "pending"]), approvals: [ask] } },
  { label: "Trabalhando", view: { ...base, id: "fx-2", status: "running", steps: steps(["done", "done", "running"]), approvals: [] } },
  { label: "Concluída", view: { ...base, id: "fx-3", status: "completed", completedAt: "2026-10-10T12:01:00Z", steps: steps(["done", "done", "done"]), approvals: [], output: { operation: "create", status: "done", tasks: [{ title: "Revisar a proposta (exemplo)" }] } } },
  { label: "Não concluída", view: { ...base, id: "fx-4", status: "failed", error: { code: "TIMEOUT", message: "A etapa demorou mais do que o limite.", step: "s2", retryable: true }, steps: steps(["done", "done", "failed"]), approvals: [] } },
];

const NOW_ITEMS: AttentionItem[] = [
  { key: "1", tone: "warn", title: "Tarefas: Criar tarefas aguardando você", detail: "Revisar a proposta (exemplo) · Ligar para o contador (exemplo)", href: "#" },
  { key: "2", tone: "warn", title: "Confirmar compromisso com Maria (exemplo)", detail: "Enviar o contrato até sexta", href: "#" },
  { key: "3", tone: "info", title: "3 memórias para confirmar", detail: "A Wendy anotou coisas sobre você; confirme o que estiver certo.", href: "#" },
];

const tile = (over: Partial<InsightCard>): InsightCard => ({ id: "fx", status: "SURFACED", headline: null, narrative: null, created_at: "2026-10-10T12:00:00Z", score: 0.82, event_type: "COMMITMENT_DUE", test_double: false, other_model: null, claims: [], explanation: null, cited: [], actions: [], ...over });
const INSIGHTS: InsightCard[] = [
  tile({ headline: "Você combinou enviar o contrato à Maria até sexta (exemplo)", narrative: "O prazo vence em 2 dias e não há registro de envio.", explanation: ["Pontuação 0.82 (limiar 0.5) — apareceu na sua tela."], cited: [{ handle: "C1", kind: "commitment", id: "a" }, { handle: "M1", kind: "message", id: "b" }], actions: [{ id: "x", type: "SEND_EMAIL", state: "AWAITING_APPROVAL" }] }),
  tile({ headline: "Aniversário do João Silva em 3 dias (exemplo)", event_type: "PERSON_DATE_APPROACHING", cited: [{ handle: "P1", kind: "person", id: "a" }], explanation: ["Pontuação 0.61 (limiar 0.5) — apareceu na sua tela."], actions: [] }),
  tile({ headline: "Briefing da reunião de amanhã preparado (exemplo)", event_type: "EMAIL_RECEIVED", cited: [{ handle: "MT1", kind: "meeting", id: "a" }], explanation: ["Pontuação 0.7 (limiar 0.5) — apareceu na sua tela."], actions: [{ id: "y", type: "PREPARE_BRIEFING", state: "VERIFIED" }] }),
];

async function ThemeOverride({ searchParams }: { searchParams: Promise<{ theme?: string }> }) {
  return (await searchParams).theme === "dark" ? <script dangerouslySetInnerHTML={{ __html: 'document.documentElement.dataset.theme="dark"' }} /> : null;
}

export default function TaskStates({ searchParams }: { searchParams: Promise<{ theme?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const phases = Object.keys(PHASE_LABEL) as TaskPhase[];
  return (
    <>
      <Suspense fallback={null}>
        <ThemeOverride searchParams={searchParams} />
      </Suspense>
      <TopBar reasoner={null} />
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-10 sm:px-6">
        <p className="eyebrow">Desenvolvimento · dados fictícios</p>
        <h1 className="display mt-3 text-4xl tracking-tight">Estados de tarefa e “Agora”</h1>
        <p className="mt-2 text-muted">Uma só linguagem para o estado de uma tarefa: sempre ícone e palavras, nunca só cor. Os seis estados espelham o que o runtime realmente tem.</p>

        <section aria-label="Estados" className="mt-10">
          <h2 className="eyebrow mb-3">Os seis estados</h2>
          <ul className="card divide-y divide-line-2 overflow-hidden">
            {phases.map((p) => (
              <li key={p} className="flex items-center gap-4 px-5 py-3">
                <span className="w-40 shrink-0">
                  <TaskStatus phase={p} />
                </span>
                <span className="text-sm text-ink-2">{PHASE_MEANING[p]}</span>
              </li>
            ))}
          </ul>
        </section>

        <Now items={NOW_ITEMS} />

        <section aria-label="Sugestões" className="mt-12">
          <h2 className="eyebrow mb-3">Sugestões proativas: sugestão, feito e só informação (fictício)</h2>
          <div className="grid gap-4">
            {INSIGHTS.map((i, n) => (
              <InsightTile key={n} i={i} n={n + 1} />
            ))}
          </div>
        </section>

        <section aria-label="Cartões" className="mt-12 grid gap-8">
          {FIXTURES.map((f) => (
            <div key={f.view.id}>
              <p className="eyebrow mb-2">
                {f.label} · fase calculada: {PHASE_LABEL[taskPhase(f.view)]}
              </p>
              <ExecutionCard initial={f.view} />
            </div>
          ))}
        </section>
      </main>
    </>
  );
}
