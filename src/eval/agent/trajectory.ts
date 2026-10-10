/**
 * Trajectory: the observable record of one trial, DERIVED from what Wendy already stores — no second
 * event store:
 *   chat_messages          → messages
 *   skill_executions       → runs, final result, errors
 *   skill_execution_events → tool calls / results, policy decisions, call events, mandate / phone events
 *   actions + versions + transitions + executions → external actions, approvals, state transitions
 *   model_calls            → which model served each reasoning step (no hidden reasoning is stored
 *                            anywhere: model calls keep structured output only)
 *   audit_blocks           → ledger entries for the principal
 * plus the environment's initial / final state and the user simulator's moves (the evaluation's own
 * inputs, which Wendy never sees as such).
 */
import type { Queryable } from '../../db/db.js';
import type { UserMove } from './simulator.js';

export interface TrajectoryEvent {
  executionId: string;
  seq: number;
  type: string;
  name: string | null;
  data: Record<string, unknown>;
  at: string;
}

export interface Trajectory {
  id: string;
  taskId: string;
  trialId: string;
  principalId: string;
  initialState: unknown;
  finalState: unknown;
  userMoves: UserMove[];
  messages: { role: string; text: string | null; tool?: string }[];
  runs: { id: string; skillId: string; status: string; output: unknown; error: unknown; trigger: Record<string, unknown> }[];
  toolCalls: { executionId: string; seq: number; tool: string; input: unknown }[];
  toolResults: { executionId: string; seq: number; tool: string; ok: boolean; output?: unknown; error?: unknown }[];
  policyDecisions: { executionId: string; seq: number; kind: string; data: Record<string, unknown> }[];
  approvals: { actionId: string; tool: string; decision: string; actor: string; reason: string | null; at: string }[];
  externalActions: { actionId: string; tool: string; state: string; category: string; content: Record<string, unknown>; executed: boolean; idempotencyKey: string | null }[];
  stateTransitions: { subject: 'action' | 'call'; id: string; from: string | null; to: string; actor?: string; at: string }[];
  events: TrajectoryEvent[];
  modelCalls: { id: string; purpose: string; model: string }[];
  audit: { seq: number; eventType: string; subjectId: string; at: string; cost?: number }[];
  finalResult: { runStatus: string | null; outcome: string | null; summary: string | null; facts: { key: string; value: string }[]; nextActions: string[] } | null;
  errors: { executionId: string; error: unknown }[];
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : d);
const parse = (v: unknown) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

export async function reconstructTrajectory(
  q: Queryable,
  ids: { id: string; taskId: string; trialId: string; principalId: string },
  extra: { initialState: unknown; finalState: unknown; userMoves: UserMove[]; categoryOf: (tool: string) => string },
): Promise<Trajectory> {
  const pid = ids.principalId;
  const runs = (
    await q.query<{ id: string; skill_id: string; status: string; output: unknown; error: unknown; trigger: Record<string, unknown> }>(
      `SELECT id, skill_id, status, output, error, trigger FROM skill_executions WHERE principal_id = $1 ORDER BY created_at, id`,
      [pid],
    )
  ).rows;
  const runIds = runs.map((r) => r.id);
  const events: TrajectoryEvent[] = (
    await q.query<{ execution_id: string; seq: number; type: string; name: string | null; data: Record<string, unknown>; at: Date }>(
      `SELECT execution_id, seq, type, name, data, at FROM skill_execution_events WHERE execution_id = ANY($1::uuid[]) ORDER BY at, id`,
      [runIds],
    )
  ).rows.map((e) => ({ executionId: e.execution_id, seq: e.seq, type: e.type, name: e.name, data: e.data, at: iso(e.at) }));

  const messages = (
    await q.query<{ role: string; content: string | null; tool_calls: { function: { name: string } }[] | null }>(`SELECT role, content, tool_calls FROM chat_messages WHERE principal_id = $1 ORDER BY seq`, [pid])
  ).rows
    .filter((m) => m.role !== 'tool')
    .map((m) => (m.tool_calls?.length ? { role: m.role, text: null, tool: m.tool_calls[0]!.function.name } : { role: m.role, text: m.content }));

  const actions = (
    await q.query<{ id: string; action_type: string; state: string; content: Record<string, unknown>; exec_status: string | null; idempotency_key: string | null }>(
      `SELECT a.id, a.action_type, a.state, v.content, x.status AS exec_status, x.idempotency_key
         FROM actions a JOIN action_versions v ON v.action_id = a.id AND v.version = a.current_version
         LEFT JOIN action_executions x ON x.action_id = a.id
        WHERE a.principal_id = $1 ORDER BY a.created_at, a.id`,
      [pid],
    )
  ).rows;
  const transitions = (
    await q.query<{ action_id: string; action_type: string; from_state: string | null; to_state: string; actor: string; reason: string | null; at: Date }>(
      `SELECT t.action_id, a.action_type, t.from_state, t.to_state, t.actor, t.reason, t.at FROM action_transitions t JOIN actions a ON a.id = t.action_id
        WHERE a.principal_id = $1 ORDER BY t.at, t.action_id`,
      [pid],
    )
  ).rows;
  const modelCalls = (await q.query<{ id: string; purpose: string; model: string }>(`SELECT id, purpose, model FROM model_calls WHERE principal_id = $1 ORDER BY started_at`, [pid])).rows;
  const audit = (
    await q.query<{ seq: string; event_type: string; subject_id: string; at: Date; cost: string | null }>(
      `SELECT seq, event_type, subject_id, at, payload->'cost'->>'amount' AS cost FROM audit_blocks WHERE principal_id = $1 ORDER BY seq`,
      [pid],
    )
  ).rows.map((a) => ({ seq: Number(a.seq), eventType: a.event_type, subjectId: a.subject_id, at: iso(a.at), ...(a.cost !== null ? { cost: Number(a.cost) } : {}) }));

  const toolCalls = events.filter((e) => e.type === 'tool.called').map((e) => ({ executionId: e.executionId, seq: e.seq, tool: e.name ?? '', input: parse(e.data.input) }));
  const toolResults = events
    .filter((e) => (e.type === 'tool.completed' || e.type === 'tool.failed') && !('actionId' in e.data))
    .map((e) => ({ executionId: e.executionId, seq: e.seq, tool: e.name ?? '', ok: e.type === 'tool.completed', ...(e.type === 'tool.completed' ? { output: parse(e.data.output) } : { error: e.data.error }) }));
  const policyDecisions = events
    .filter((e) => /^(permission\.|mandate\.(validated|confirmation_required|approved)|call\.validating|call\.action_required)/.test(e.type))
    .map((e) => ({ executionId: e.executionId, seq: e.seq, kind: e.type, data: e.data }));

  const callTransitions = events
    .filter((e) => e.type.startsWith('call.') && !['call.validating', 'call.outcome'].includes(e.type))
    .map((e) => ({ subject: 'call' as const, id: e.name ?? '', from: null, to: e.type, at: e.at }));

  const last = runs.filter((r) => r.skill_id === 'voice-concierge').at(-1) ?? runs.at(-1);
  const out = (last?.output ?? null) as { status?: string; result?: { outcome: string; summary: string; extractedFacts: { key: string; value: string }[]; nextActions: string[] } | null } | null;

  return {
    ...ids,
    initialState: extra.initialState,
    finalState: extra.finalState,
    userMoves: extra.userMoves,
    messages,
    runs: runs.map((r) => ({ id: r.id, skillId: r.skill_id, status: r.status, output: r.output, error: r.error, trigger: r.trigger })),
    toolCalls,
    toolResults,
    policyDecisions,
    approvals: transitions
      .filter((t) => t.to_state === 'APPROVED' || t.to_state === 'REJECTED')
      .map((t) => ({ actionId: t.action_id, tool: t.action_type, decision: t.to_state, actor: t.actor, reason: t.reason, at: iso(t.at) })),
    externalActions: actions.map((a) => ({
      actionId: a.id,
      tool: a.action_type,
      state: a.state,
      category: extra.categoryOf(a.action_type),
      content: a.content,
      executed: a.exec_status !== null && a.exec_status !== 'PENDING',
      idempotencyKey: a.idempotency_key,
    })),
    stateTransitions: [...transitions.map((t) => ({ subject: 'action' as const, id: t.action_id, from: t.from_state, to: t.to_state, actor: t.actor, at: iso(t.at) })), ...callTransitions],
    events,
    modelCalls,
    audit,
    finalResult: last
      ? {
          runStatus: out?.status ?? last.status,
          outcome: out?.result?.outcome ?? null,
          summary: out?.result?.summary ?? null,
          facts: out?.result?.extractedFacts ?? [],
          nextActions: out?.result?.nextActions ?? [],
        }
      : null,
    errors: runs.filter((r) => r.error).map((r) => ({ executionId: r.id, error: r.error })),
  };
}
