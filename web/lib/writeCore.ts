/**
 * The write path to the agent, with its dependencies injected so it can be tested without a live agent, a database or
 * a network. lib/actions.ts (a "use server" file, which may only export server actions) builds the real dependencies.
 *
 * Contract: ok === true only when the agent answered 2xx AND said ok. Anything else is a failure and is never
 * reported as done. When the setting says the agent is OFF the request is not even made (`offline: true`): nothing
 * can have changed, and the principal is told why instead of getting a transport error. No retry, ever: an unclear
 * outcome could repeat an operation that actually happened.
 */
export type WriteResult = { ok: true; result?: unknown } | { ok: false; error: string; offline?: true };

export interface WriteDeps {
  /** Set only when the environment says the agent is explicitly off (ACTION_UNAVAILABLE_REASON). */
  unavailableReason?: string;
  agentUrl: string;
  token: string;
  fetchImpl: typeof fetch;
  refresh: () => void;
}

export function friendly(e: string): string {
  if (/expired/.test(e)) return "Esta proposta expirou e não pode mais ser aprovada.";
  if (/only AWAITING_APPROVAL|illegal/i.test(e)) return "Esta ação já foi decidida.";
  if (/importance/.test(e)) return "Use um valor entre 0 e 1.";
  return e;
}

export async function postWrite(name: string, body: Record<string, unknown>, d: WriteDeps): Promise<WriteResult> {
  if (d.unavailableReason) return { ok: false, error: d.unavailableReason, offline: true };
  try {
    const res = await d.fetchImpl(`${d.agentUrl}/write/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${d.token}` },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: unknown };
    if (!res.ok || !json.ok) return { ok: false, error: friendly(json.error ?? `erro ${res.status}`) };
    d.refresh();
    return { ok: true, result: json.result };
  } catch {
    return { ok: false, error: "A Wendy não respondeu. Verifique se o agente está rodando." };
  }
}
