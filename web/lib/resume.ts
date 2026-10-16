/**
 * "Continuar de onde parou": what each past question gets next to it, taken ONLY from the runtime.
 *
 * A question shows a task state when the server linked it to the task it started (`runId`, from skill_executions.trigger.messageId) AND that
 * task is among the runs the page has. Nothing is inferred from the text, and a question with no linked task shows no state: an invented
 * "done" would be worse than nothing. The state words are the same as everywhere else (lib/taskStatus.ts).
 */
import { taskPhase, type PhaseInput, type TaskPhase } from "./taskStatus";
import type { PastQuestion } from "./wendy";

export interface ResumeEntry {
  question: PastQuestion;
  /** The linked task's state, or null: no task, or one this page does not have. */
  phase: TaskPhase | null;
  /** The linked task (to jump to its card), only when there is a state. */
  runId: string | null;
}

export function resumeEntries(questions: PastQuestion[], runs: (PhaseInput & { id: string })[]): ResumeEntry[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  return questions.map((question) => {
    const run = question.runId ? byId.get(question.runId) : undefined;
    return { question, phase: run ? taskPhase(run) : null, runId: run ? run.id : null };
  });
}

/** What is still open among these entries (not finished): shown as one honest sentence above the list. */
export function openCount(entries: ResumeEntry[]): number {
  return entries.filter((e) => e.phase === "queued" || e.phase === "running" || e.phase === "waiting_for_approval").length;
}

/** How many of them are waiting for the principal specifically. */
export function waitingCount(entries: ResumeEntry[]): number {
  return entries.filter((e) => e.phase === "waiting_for_approval").length;
}

export const HIDDEN_TEXT = "Mensagem ocultada";
