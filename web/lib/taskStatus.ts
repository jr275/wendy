/**
 * One vocabulary for "where is this task", shared by every surface that shows a run.
 *
 * It is a PRESENTATION of the runtime's real status (skill_executions.status: queued, running,
 * waiting_permission, waiting_child, completed, failed, cancelled — src/skills/runtime.ts), never a
 * new backend state. What the runtime does not expose is not shown: there is no "blocked" and no
 * "retrying" (a step's retries are internal), so neither exists here.
 *
 *   queued               → queued
 *   running, waiting_child → running           (a run waiting on its own sub-run is still working)
 *   waiting_permission   → waiting_for_approval only while an approval is really awaiting the
 *                          principal (here or in a child run); once it is decided the run is
 *                          working again, and saying "needs you" would be false
 *   completed / failed / cancelled → the same
 */
import type { ExecutionView } from "./wendy";

export type TaskPhase = "queued" | "running" | "waiting_for_approval" | "completed" | "failed" | "cancelled";

export const PHASE_LABEL: Record<TaskPhase, string> = {
  queued: "Na fila",
  running: "Trabalhando",
  waiting_for_approval: "Precisa de você",
  completed: "Concluída",
  failed: "Não concluída",
  cancelled: "Cancelada",
};

/** Words for assistive technology and tooltips: what the phase means, not just its name. */
export const PHASE_MEANING: Record<TaskPhase, string> = {
  queued: "Aguardando a vez de começar",
  running: "A Wendy está executando",
  waiting_for_approval: "Parada até você aprovar ou recusar",
  completed: "Terminou",
  failed: "Parou sem concluir",
  cancelled: "Você cancelou antes de terminar",
};

/** The only fields the mapping reads (an ExecutionView fits; so does a plain object in a test). */
export interface PhaseInput {
  status: ExecutionView["status"];
  approvals: { state: string }[];
  children: PhaseInput[];
}

/** True while an approval of this run, or of any child run, is awaiting the principal. */
export function awaitingApproval(v: PhaseInput): boolean {
  return v.approvals.some((a) => a.state === "AWAITING_APPROVAL") || v.children.some(awaitingApproval);
}

export function taskPhase(v: PhaseInput): TaskPhase {
  switch (v.status) {
    case "completed":
    case "failed":
    case "cancelled":
      return v.status;
    case "queued":
      return "queued";
    default:
      // running | waiting_child | waiting_permission
      return awaitingApproval(v) ? "waiting_for_approval" : "running";
  }
}

export const isFinished = (p: TaskPhase): boolean => p === "completed" || p === "failed" || p === "cancelled";
