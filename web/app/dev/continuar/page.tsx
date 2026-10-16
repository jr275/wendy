import { notFound } from "next/navigation";
import { Suspense } from "react";
import { History } from "@/components/concierge/history";
import { TopBar } from "@/components/top-bar";
import { WorkspaceProvider } from "@/components/workspace-context";
import type { ExecutionView, PastQuestion } from "@/lib/wendy";

/**
 * DEV ONLY — "Continuar de onde parou" with each task state, from FICTITIOUS data (nothing here is read from Wendy). Each question is
 * linked to a made-up run by id, exactly as the server links a real message to the task it started; the questions with no link show no state.
 */
const base = { skillId: "task-management", skillName: "Tarefas", version: "1.0.0", error: null, output: null, createdAt: "2026-10-15T12:00:00Z", completedAt: null, models: [] as string[], children: [] as ExecutionView[], steps: [] as ExecutionView["steps"] };
const ask: ExecutionView["approvals"][number] = { actionId: "00000000-0000-4000-8000-000000000001", tool: "tasks.create", label: "Criar tarefas", category: "WRITE", state: "AWAITING_APPROVAL", content: {}, items: ["Revisar a proposta (exemplo)"] };

const RUNS: ExecutionView[] = [
  { ...base, id: "run-wait", status: "waiting_permission", approvals: [ask] },
  { ...base, id: "run-go", status: "running", approvals: [] },
  { ...base, id: "run-q", status: "queued", approvals: [] },
  { ...base, id: "run-ok", status: "completed", completedAt: "2026-10-15T12:01:00Z", approvals: [] },
  { ...base, id: "run-bad", status: "failed", approvals: [] },
  { ...base, id: "run-no", status: "cancelled", approvals: [] },
];

const at = (h: number, m: number) => `2026-10-15T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const QUESTIONS: PastQuestion[] = [
  { id: "m1", text: "Cria uma tarefa para revisar a proposta (exemplo)", at: at(15, 30), runId: "run-wait" },
  { id: "m2", text: "Organiza a viagem de sexta (exemplo)", at: at(15, 10), runId: "run-go" },
  { id: "m3", text: "Lembra de ligar para o contador (exemplo)", at: at(14, 50), runId: "run-q" },
  { id: "m4", text: "Marca uma reunião com a Maria (exemplo)", at: at(14, 20), runId: "run-ok" },
  { id: "m5", text: "Reserva uma mesa para sábado (exemplo)", at: at(13, 40), runId: "run-bad" },
  { id: "m6", text: "Cancela aquele pedido (exemplo)", at: at(13, 5), runId: "run-no" },
  { id: "m7", text: "Qual é o meu compromisso de amanhã? (exemplo, só pergunta: sem tarefa, sem estado)", at: at(12, 30) },
  { id: "m8", text: "Uma tarefa que esta página não tem (exemplo: também sem estado)", at: at(12, 0), runId: "run-gone" },
];

async function ThemeOverride({ searchParams }: { searchParams: Promise<{ theme?: string }> }) {
  return (await searchParams).theme === "dark" ? <script dangerouslySetInnerHTML={{ __html: 'document.documentElement.dataset.theme="dark"' }} /> : null;
}

export default function ContinuarFixtures({ searchParams }: { searchParams: Promise<{ theme?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <>
      <Suspense fallback={null}>
        <ThemeOverride searchParams={searchParams} />
      </Suspense>
      <TopBar reasoner={null} />
      <WorkspaceProvider>
        <main className="pb-24 pt-6">
          <p className="mx-auto max-w-3xl px-4 eyebrow sm:px-6">Desenvolvimento · dados fictícios</p>
          <History questions={QUESTIONS} runs={RUNS} timeZone="America/Sao_Paulo" now="2026-10-15T16:00:00.000Z" />
        </main>
      </WorkspaceProvider>
    </>
  );
}
