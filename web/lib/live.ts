"use server";
import { execution, principal, type ExecutionView } from "./wendy";

/** Latest state of a skill run, for the chat card while it works (read-only). */
export async function fetchExecution(id: string): Promise<ExecutionView | null> {
  const p = await principal();
  return p ? execution(id, p.id) : null;
}

