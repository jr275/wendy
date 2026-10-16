"use server";
import { refresh } from "next/cache";
import { ACTION_UNAVAILABLE_REASON } from "./wendy";
import { postWrite, type WriteResult } from "./writeCore";

/**
 * Writes from the UI. Server Actions (same-origin, checked by Next) → Wendy's domain services, server to
 * server with the agent token. The principal is decided by Wendy, never sent from the browser.
 */
const AGENT = (process.env.WENDY_AGUI_URL ?? "http://127.0.0.1:3458/agui").replace(/\/agui$/, "");

export type { WriteResult } from "./writeCore";

/** The one door to the agent's write API. When the environment says the agent is off, this refuses before any request. */
const write = (name: string, body: Record<string, unknown>): Promise<WriteResult> =>
  postWrite(name, body, { unavailableReason: ACTION_UNAVAILABLE_REASON, agentUrl: AGENT, token: process.env.WENDY_AGENT_TOKEN ?? "", fetchImpl: fetch, refresh });

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

export async function markDigestRead(itemId: string) {
  return write("digest/read", { itemId });
}
/** Runs the reading digest now (public RSS feeds). Wendy keeps to one finished run per day, so a second press says so. */
export async function refreshDigest(): Promise<WriteResult> {
  const r = await write("digest/refresh", {});
  if (!r.ok) return r;
  const out = (r.result as { outcome?: string; detail?: string } | undefined) ?? {};
  if (out.outcome === "no_routine") return { ok: false, error: "A rotina de leituras ainda não está ativada." };
  if (out.outcome === "skipped") return { ok: false, error: out.detail === "done" ? "As leituras de hoje já foram buscadas. Amanhã vêm as novas." : "Já há uma busca em andamento ou em pausa." };
  if (out.outcome === "failed") return { ok: false, error: "Não consegui buscar agora. Tento de novo mais tarde." };
  return r;
}

/** Adds an asset to the market monitor's list (checked with one request to the data provider). It only watches: no order, no message. */
export async function addMarketAsset(symbol: string): Promise<WriteResult> {
  return write("market/add", { symbol });
}
export async function removeMarketAsset(symbol: string): Promise<WriteResult> {
  return write("market/remove", { symbol });
}
