/** Read model of one skill run (and its children) for the UI. Read-only, scoped to the principal. */
import type { Queryable } from '../db/db.js';
import { approvalItems } from './approvalItems.js';
import { toolSpec } from '../tools/specs.js';
import { summarizeMandate } from '../voice/mandate.js';
import type { VoiceMandate } from '../voice/types.js';
import type { SkillRegistry } from './registry.js';
import type { ExecutionRow } from './runtime.js';
import { loadVoiceView, type VoiceView } from './voiceView.js';

export interface ExecutionView {
  id: string;
  skillId: string;
  skillName: string;
  version: string;
  status: ExecutionRow['status'];
  error: ExecutionRow['error'];
  output: unknown;
  createdAt: string;
  completedAt: string | null;
  steps: { id: string; label: string; status: 'done' | 'running' | 'waiting' | 'pending' | 'failed' }[];
  /** `items`: what the principal is asked to approve, in words (task titles), never just ids. */
  approvals: { actionId: string; tool: string; label: string; category: string; state: string; content: Record<string, unknown>; items: string[] }[];
  models: string[];
  children: ExecutionView[];
  /** voice-concierge runs: the call as the UI presents it, derived from this run's events (voiceView.ts). */
  voice?: VoiceView;
}

export async function executionView(q: Queryable, registry: SkillRegistry, principalId: string, id: string, depth = 0): Promise<ExecutionView | null> {
  const e = (await q.query<ExecutionRow>('SELECT * FROM skill_executions WHERE id = $1 AND principal_id = $2', [id, principalId])).rows[0];
  if (!e) return null;
  const skill = registry.get(e.skill_id);
  const steps = (skill?.steps ?? []).map((s, i) => {
    const status: ExecutionView['steps'][number]['status'] =
      e.status === 'completed' || i < e.step_index ? 'done' : i > e.step_index ? 'pending' : e.status === 'failed' ? 'failed' : e.status.startsWith('waiting') ? 'waiting' : e.status === 'running' ? 'running' : 'pending';
    return { id: s.id, label: s.label, status };
  });
  const rows = (
    await q.query<{ id: string; action_type: string; state: string; content: Record<string, unknown> }>(
      `SELECT a.id, a.action_type, a.state, v.content FROM actions a JOIN action_versions v ON v.action_id = a.id AND v.version = a.current_version
        WHERE a.skill_execution_id = $1 AND a.principal_id = $2 ORDER BY a.created_at`,
      [id, principalId],
    )
  ).rows;
  const approvals: ExecutionView['approvals'] = [];
  for (const a of rows) {
    const spec = toolSpec(a.action_type);
    const c = a.content as { tasks?: { title: string }[]; taskId?: string; personId?: string };
    const taskTitle = c.taskId ? ((await q.query<{ title: string }>('SELECT title FROM tasks WHERE id = $1 AND principal_id = $2', [c.taskId, principalId])).rows[0]?.title ?? null) : null;
    const contactName = c.personId ? ((await q.query<{ full_name: string }>('SELECT full_name FROM people WHERE id = $1 AND principal_id = $2', [c.personId, principalId])).rows[0]?.full_name ?? null) : null;
    const described = approvalItems(a.action_type, a.content, { taskTitle, contactName });
    const items = a.action_type === 'voice.call'
      ? summarizeMandate(a.content as unknown as VoiceMandate)
      : described.length
      ? described
      : c.tasks
      ? c.tasks.map((t) => t.title)
      : taskTitle
        ? [taskTitle]
        : [];
    approvals.push({ actionId: a.id, tool: a.action_type, label: spec?.label ?? a.action_type, category: spec?.category ?? 'UNKNOWN', state: a.state, content: a.content, items });
  }
  const models = (
    await q.query<{ model: string }>(
      `SELECT DISTINCT m.model FROM skill_execution_events ev JOIN model_calls m ON m.id::text = ev.data->>'modelCallId' WHERE ev.execution_id = $1 AND ev.type = 'model.called'`,
      [id],
    )
  ).rows.map((r) => r.model);
  const childIds = depth < 3 ? (await q.query<{ id: string }>('SELECT id FROM skill_executions WHERE parent_id = $1 ORDER BY created_at, id', [id])).rows : [];
  const children = (await Promise.all(childIds.map((c) => executionView(q, registry, principalId, c.id, depth + 1)))).filter((c): c is ExecutionView => !!c);
  return {
    id: e.id,
    skillId: e.skill_id,
    skillName: skill?.name ?? e.skill_id,
    version: e.skill_version,
    status: e.status,
    error: e.error,
    output: e.output,
    createdAt: new Date(e.created_at).toISOString(),
    completedAt: e.completed_at ? new Date(e.completed_at).toISOString() : null,
    steps,
    approvals,
    models: [...new Set([...models, ...children.flatMap((c) => c.models)])],
    children,
    ...(e.skill_id === 'voice-concierge' ? { voice: await loadVoiceView(q, e.id, rows, e.state) } : {}),
  };
}

/** The principal's latest top-level runs (newest first), for the concierge desk. */
export async function recentExecutions(q: Queryable, registry: SkillRegistry, principalId: string, limit = 8): Promise<ExecutionView[]> {
  const ids = (await q.query<{ id: string }>(`SELECT id FROM skill_executions WHERE principal_id = $1 AND parent_id IS NULL ORDER BY created_at DESC, id LIMIT $2`, [principalId, limit])).rows;
  return (await Promise.all(ids.map((r) => executionView(q, registry, principalId, r.id)))).filter((v): v is ExecutionView => !!v);
}

/** Every approval still waiting anywhere in a run tree. */
export function pendingApprovals(v: ExecutionView): ExecutionView['approvals'] {
  return [...v.approvals.filter((a) => a.state === 'AWAITING_APPROVAL'), ...v.children.flatMap(pendingApprovals)];
}
