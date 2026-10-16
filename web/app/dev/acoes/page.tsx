import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ACTIONS_OFF_NOTE_ID, ActionsOffNote, AgentAvailability } from "@/components/agent-availability";
import { ApprovalCard } from "@/components/approval";
import { TaskObject } from "@/components/concierge/task-object";
import { ExecutionCard } from "@/components/execution-card";
import { ImportanceControl } from "@/components/importance";
import { MemoryRow } from "@/components/memory-row";
import { TopBar } from "@/components/top-bar";
import { ACTION_OFF_REASON } from "@/lib/agentConfig";
import type { DetailAction, ExecutionView } from "@/lib/wendy";
import data from "../concierge/fixtures.json";

/**
 * DEV ONLY — every control that changes something through the agent, from FICTITIOUS ids, so its offline behaviour
 * can be checked without a live agent and without touching Wendy's data. Nothing here is read from the database, and
 * with ?agent=off the controls are disabled before anything can be sent. Without the parameter they are enabled
 * (as when availability is unknown): DO NOT click them there, they would try the real write path.
 * The ?agent= parameter only drives this fixture; the real pages take the setting from the server (lib/wendy.ts).
 */
const base = { skillId: "task-management", skillName: "Tarefas", version: "1.0.0", error: null, output: null, createdAt: "2026-10-10T12:00:00Z", completedAt: null, models: [], children: [] };
const EXECUTION: ExecutionView = {
  ...base,
  id: "fx-acoes-exec",
  status: "waiting_permission",
  steps: [
    { id: "s1", label: "Entendendo o pedido", status: "done" },
    { id: "s2", label: "Pedindo sua aprovação", status: "waiting" },
  ],
  approvals: [{ actionId: "00000000-0000-4000-8000-0000000000a1", tool: "tasks.create", label: "Criar tarefas", category: "WRITE", state: "AWAITING_APPROVAL", content: {}, items: ["Revisar a proposta (exemplo)"] }],
};
// The captured view's ids are replaced by fictional ones: nothing on this page may ever match a real record.
const CAPTURED = data.fixtures[1].view as unknown as ExecutionView;
const TASK: ExecutionView = { ...CAPTURED, id: "fx-acoes-task", approvals: CAPTURED.approvals.map((a) => ({ ...a, actionId: "00000000-0000-4000-8000-0000000000a2" })) };
const EMAIL: DetailAction = {
  id: "fx-acoes-email",
  action_type: "SEND_EMAIL",
  state: "AWAITING_APPROVAL",
  expires_at: null,
  rejection_reason: null,
  policy_decision: { mode: "REQUIRE_APPROVAL", rule: "external" },
  content: { to: ["exemplo@example.invalid"], subject: "Assunto (exemplo)", body: "Corpo da mensagem (exemplo)." },
  author: "wendy",
  execution: null,
};

async function Fixture({ searchParams }: { searchParams: Promise<{ agent?: string; theme?: string }> }) {
  const q = await searchParams;
  const off = q.agent === "off";
  return (
    <AgentAvailability actionReason={off ? ACTION_OFF_REASON : undefined}>
      {q.theme === "dark" ? <script dangerouslySetInnerHTML={{ __html: 'document.documentElement.dataset.theme="dark"' }} /> : null}
      <TopBar reasoner={null} />
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-10 sm:px-6" data-fixture-agent={off ? "off" : "unknown"}>
        <p className="eyebrow">Desenvolvimento · dados fictícios</p>
        <h1 className="display mt-3 text-4xl tracking-tight">Ações que dependem do agente</h1>
        <p className="mt-2 text-muted">{off ? "Com ?agent=off: os controles ficam desativados antes de qualquer envio." : "Sem o parâmetro: disponibilidade desconhecida; os controles estão ativos. Não clique."}</p>

        <section aria-label="Memória" className="mt-10">
          <h2 className="eyebrow mb-3">Memória (confirmar / esquecer)</h2>
          <ActionsOffNote id={ACTIONS_OFF_NOTE_ID} className="mb-3" />
          <ul className="grid gap-3">
            <MemoryRow id="fx-mem-1" content="Fato de exemplo para esquecer." status="ACTIVE" needsReview />
            <MemoryRow id="fx-mem-2" content="Proposta de exemplo para confirmar." status="PROPOSED" />
          </ul>
        </section>

        <section aria-label="Importância" className="mt-10">
          <h2 className="eyebrow mb-3">Importância de um site</h2>
          <ImportanceControl propertyId="fx-site" label="Site de exemplo" value={0.5} />
        </section>

        <section aria-label="Cartão de execução" className="mt-10">
          <h2 className="eyebrow mb-3">Cartão de execução (aprovar / recusar)</h2>
          <ExecutionCard initial={EXECUTION} />
        </section>

        <section aria-label="Tarefa" className="mt-10">
          <h2 className="eyebrow mb-3">Tarefa (aprovar e ligar / agora não / cancelar)</h2>
          <TaskObject initial={TASK} />
        </section>

        <section aria-label="Aprovação" className="mt-10">
          <h2 className="eyebrow mb-3">Aprovação detalhada (aprovar / editar / rejeitar)</h2>
          <ApprovalCard a={EMAIL} />
        </section>
      </main>
    </AgentAvailability>
  );
}

export default function Acoes({ searchParams }: { searchParams: Promise<{ agent?: string; theme?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense fallback={null}>
      <Fixture searchParams={searchParams} />
    </Suspense>
  );
}
