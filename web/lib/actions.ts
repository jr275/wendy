"use server";
import { refresh } from "next/cache";

/**
 * Writes from the UI. Server Actions (same-origin, checked by Next) → Wendy's domain services, server to
 * server with the agent token. The principal is decided by Wendy, never sent from the browser.
 */
const AGENT = (process.env.WENDY_AGUI_URL ?? "http://127.0.0.1:3458/agui").replace(/\/agui$/, "");

export type WriteResult = { ok: true; result?: unknown } | { ok: false; error: string };

async function write(name: string, body: Record<string, unknown>): Promise<WriteResult> {
  try {
    const res = await fetch(`${AGENT}/write/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.WENDY_AGENT_TOKEN ?? ""}` },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: unknown };
    if (!res.ok || !json.ok) return { ok: false, error: friendly(json.error ?? `erro ${res.status}`) };
    refresh();
    return { ok: true, result: json.result };
  } catch {
    return { ok: false, error: "A Wendy não respondeu. Verifique se o agente está rodando." };
  }
}

function friendly(e: string): string {
  if (/expired/.test(e)) return "Esta proposta expirou e não pode mais ser aprovada.";
  if (/only AWAITING_APPROVAL|illegal/i.test(e)) return "Esta ação já foi decidida.";
  if (/importance/.test(e)) return "Use um valor entre 0 e 1.";
  return e;
}

export async function approveAction(actionId: string, edits?: { subject?: string; body?: string }) {
  return write("action/approve", { actionId, ...(edits ? { edits } : {}) });
}
export async function rejectAction(actionId: string, reason: string | null) {
  return write("action/reject", { actionId, reason });
}
export async function setSiteImportance(propertyId: string, importance: number | null) {
  return write("site/importance", { propertyId, importance });
}
export async function confirmMemory(memoryId: string) {
  return write("memory/confirm", { memoryId });
}
export async function retractMemory(memoryId: string, reason: string | null) {
  return write("memory/retract", { memoryId, reason });
}

/**
 * Cancels a run the principal started. Wendy decides what may stop: waiting approvals die with the
 * run; an approved effect (a call already placed) is never cancelled — the result says so.
 */
export async function cancelExecution(executionId: string): Promise<WriteResult> {
  const r = await write("execution/cancel", { executionId, reason: "cancelado por você" });
  if (!r.ok) return r;
  const status = (r.result as { status?: string } | undefined)?.status;
  if (status === "not_cancellable") return { ok: false, error: "Esta ligação já foi aprovada e está em andamento; não dá para cancelar daqui." };
  if (status === "not_found") return { ok: false, error: "Não encontrei esta tarefa." };
  return r;
}
