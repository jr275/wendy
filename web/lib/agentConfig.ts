/**
 * WENDY_AGENT: whether this environment has the agent explicitly switched off. Pure (no process.env here):
 * lib/wendy.ts, which is server-only, reads the variable and calls this.
 *
 *   off      the agent was disabled on purpose for this environment: the UI says so BEFORE any send.
 *   on       NOT a proof of availability. It only means nobody disabled it; the web cannot know the process is up
 *            (there is no health signal), so it behaves exactly like "unset".
 *   unset    availability is unknown: nothing is claimed either way, and the normal error handling applies.
 *   invalid  anything else (a typo such as "ofline" or "0"): never read as "available" and never as "off".
 *            It behaves like "unset", and the server logs a warning so the mistake is noticed.
 */
export type AgentSetting = "off" | "on" | "unset" | "invalid";

export function parseAgentSetting(raw: string | undefined | null): AgentSetting {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return "unset";
  if (v === "off") return "off";
  if (v === "on") return "on";
  return "invalid";
}

export const AGENT_OFF_REASON = "O agente da Wendy está desligado neste ambiente. O histórico continua aqui, mas nenhuma mensagem é enviada.";
export const DEMO_REASON = "Modo demonstração: só a interface. A Wendy não responde aqui e nenhuma mensagem é enviada.";

/** The one sentence shown before any send, or undefined when nothing is KNOWN to prevent processing. */
export function unavailableReason(s: { demo: boolean; setting: AgentSetting }): string | undefined {
  if (s.demo) return DEMO_REASON;
  if (s.setting === "off") return AGENT_OFF_REASON;
  return undefined;
}

export const ACTION_OFF_REASON = "Ações que mudam algo precisam do agente da Wendy, que está desligado neste ambiente.";

/**
 * Why actions that change something through the agent (approve, reject, cancel, confirm or forget a memory, set
 * importance) cannot run, or undefined. Only an explicit "off" says so. Demo mode alone is unchanged on purpose: it has
 * no records to act on and its semantics stay as before. "on", unset and invalid claim nothing (availability unknown).
 */
export function actionUnavailableReason(s: { setting: AgentSetting }): string | undefined {
  return s.setting === "off" ? ACTION_OFF_REASON : undefined;
}
