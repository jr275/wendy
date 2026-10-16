/**
 * WENDY_AGENT as seen by the processes that own the writes (the agent and the inspector). Same meaning as the web's
 * web/lib/agentConfig.ts (kept in step by tests/unit/agentWriteGuard.test.ts): the web is a separate package that cannot
 * import from here, and this one cannot import from there, so the 8-line parser exists twice and a parity test guards it.
 *
 *   off      the agent is explicitly switched off for this environment: nothing may RUN and nothing may be WRITTEN.
 *   on       NOT a proof of health. It only means nobody switched it off; behaves like unset.
 *   unset    availability unknown: nothing is claimed, normal behaviour (and normal errors) apply.
 *   invalid  anything else (a typo). Never read as "available" and never as "off"; the process logs a warning at start
 *            (without the value).
 *
 * This is a configuration declaration, not a health check. It is also separate from the other three questions a write
 * must answer: WHO is asking (bearer token / session + CSRF + origin), MAY they do it (the principal is fixed by the
 * server), and IS the request valid (zod, domain services). Availability is checked AFTER authentication so an
 * unauthenticated caller learns nothing, and BEFORE any validation, database access, model call or effect.
 */
export type AgentSetting = 'off' | 'on' | 'unset' | 'invalid';

export function parseAgentSetting(raw: string | undefined | null): AgentSetting {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return 'unset';
  if (v === 'off') return 'off';
  if (v === 'on') return 'on';
  return 'invalid';
}

export const AGENT_OFF_MESSAGE = 'O agente da Wendy está desligado neste ambiente. Nada foi executado nem alterado.';

/** The refusal sentence when this process was told the agent is off, otherwise undefined (available or not known). */
export function agentOffReason(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return parseAgentSetting(env.WENDY_AGENT) === 'off' ? AGENT_OFF_MESSAGE : undefined;
}

export type AgentRequestKind = 'run' | 'write';

/**
 * What the agent's HTTP server must refuse BEFORE reading the body, touching the database or calling a model:
 * a run (POST /agui, which persists the principal's message, runs skills and may call a model) and a write
 * (POST /write/*, which reaches the domain services). Anything else is not covered and returns null.
 */
export function gateAgentRequest(method: string | undefined, url: string | undefined, env: NodeJS.ProcessEnv = process.env): { kind: AgentRequestKind; message: string } | null {
  if (method !== 'POST' || !url) return null;
  const message = agentOffReason(env);
  if (!message) return null;
  if (url.startsWith('/agui')) return { kind: 'run', message };
  if (url.startsWith('/write/')) return { kind: 'write', message };
  return null;
}
