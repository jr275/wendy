/**
 * ACTIONS: persistent state machine + approval policy.
 *
 *   PROPOSED → STAGED → AWAITING_APPROVAL → APPROVED → EXECUTING → EXECUTED → VERIFIED
 *   terminal: REJECTED, FAILED, CANCELLED, EXPIRED
 *
 * Every transition happens under a row lock, is recorded in action_transitions and appended to
 * the audit ledger in the same transaction. Approval creates exactly one execution record
 * (UNIQUE action_id) — the basis of idempotent execution.
 */
import { appendAudit } from '../audit/ledger.js';
import { withTx, type Db, type Queryable, type Tx } from '../db/db.js';
import { ActionState, TERMINAL_ACTION_STATES } from '../domain/types.js';
import { hashOf, newId } from '../util/hash.js';

export type ActionType = 'PREPARE_BRIEFING' | 'SEND_EMAIL';

export const ALLOWED_TRANSITIONS: Record<ActionState, readonly ActionState[]> = {
  PROPOSED: ['STAGED', 'CANCELLED', 'EXPIRED'],
  STAGED: ['AWAITING_APPROVAL', 'APPROVED', 'CANCELLED', 'EXPIRED'],
  AWAITING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'],
  APPROVED: ['EXECUTING', 'CANCELLED'],
  EXECUTING: ['EXECUTED', 'FAILED', 'APPROVED'], // back to APPROVED only when reconciliation proves nothing was sent
  EXECUTED: ['VERIFIED', 'FAILED'],
  VERIFIED: [],
  REJECTED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export class IllegalTransitionError extends Error {}

export interface ActionRow {
  id: string;
  principal_id: string;
  insight_id: string | null;
  action_type: ActionType;
  target_person_id: string | null;
  state: ActionState;
  authorization_level: number;
  policy_decision: PolicyDecision;
  current_version: number;
  expires_at: Date | null;
  rejection_reason: string | null;
  failure: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Action catalog: what each action does and how far it reaches. */
export const ACTION_CATALOG: Record<ActionType, { authorizationLevel: number; external: boolean; provider: string }> = {
  PREPARE_BRIEFING: { authorizationLevel: 1, external: false, provider: 'INTERNAL_ARTIFACTS' },
  SEND_EMAIL: { authorizationLevel: 3, external: true, provider: 'EMAIL' },
};

export interface PolicyDecision {
  mode: 'AUTO' | 'REQUIRE_APPROVAL';
  rule: string;
}

/**
 * Approval policy: the higher the impact, the more authorization required.
 * Level ≤1 (internal preparation, no external effect) runs automatically.
 * Level ≥2 requires the principal's explicit approval. (Per-principal overrides: Phase 4.)
 */
export type PolicyOverride = 'AUTO' | 'REQUIRE_APPROVAL' | null;

/**
 * The principal may make an action stricter (require approval) or, for internal actions only,
 * automatic. External actions can never be made automatic by a setting in this phase.
 */
export function decidePolicy(type: ActionType, override: PolicyOverride = null): PolicyDecision {
  const { authorizationLevel, external } = ACTION_CATALOG[type];
  if (override === 'REQUIRE_APPROVAL') return { mode: 'REQUIRE_APPROVAL', rule: 'principal policy: always ask' };
  if (override === 'AUTO' && !external) return { mode: 'AUTO', rule: 'principal policy: run automatically (internal action)' };
  if (!external && authorizationLevel <= 1) return { mode: 'AUTO', rule: 'level<=1 internal preparation runs automatically' };
  return { mode: 'REQUIRE_APPROVAL', rule: `level ${authorizationLevel}${external ? ' external' : ''} action requires explicit approval` };
}

export async function policyOverride(q: Queryable, principalId: string, type: ActionType): Promise<PolicyOverride> {
  const r = (await q.query<{ mode: PolicyOverride }>('SELECT mode FROM approval_policies WHERE principal_id = $1 AND action_type = $2', [principalId, type])).rows[0];
  return r?.mode ?? null;
}

export class PolicyService {
  constructor(private readonly db: Db) {}
  /** Sets (or clears with null) the principal's policy for an action type. External actions cannot be set to AUTO. */
  async set(principalId: string, type: ActionType, mode: PolicyOverride, now: Date) {
    if (!(type in ACTION_CATALOG)) throw new IllegalTransitionError(`unknown action type ${type}`);
    if (mode === 'AUTO' && ACTION_CATALOG[type].external) throw new IllegalTransitionError(`${type} is external and cannot run without approval in this phase`);
    return withTx(this.db, async (tx) => {
      const before = await policyOverride(tx, principalId, type);
      if (mode === null) await tx.query('DELETE FROM approval_policies WHERE principal_id = $1 AND action_type = $2', [principalId, type]);
      else
        await tx.query(
          `INSERT INTO approval_policies(principal_id, action_type, mode, updated_at, updated_by) VALUES ($1,$2,$3,$4,'PRINCIPAL')
           ON CONFLICT (principal_id, action_type) DO UPDATE SET mode = EXCLUDED.mode, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
          [principalId, type, mode, now],
        );
      await appendAudit(tx, { principalId, eventType: 'APPROVAL_POLICY_SET', actor: 'PRINCIPAL', subjectType: 'policy', subjectId: type, payload: { from: before, to: mode } });
    });
  }
}

export async function lockAction(tx: Tx, actionId: string, principalId: string): Promise<ActionRow> {
  const row = (await tx.query<ActionRow>('SELECT * FROM actions WHERE id = $1 AND principal_id = $2 FOR UPDATE', [actionId, principalId])).rows[0];
  if (!row) throw new IllegalTransitionError(`Action ${actionId} not found for principal`);
  return row;
}

export async function transition(tx: Tx, action: ActionRow, to: ActionState, actor: string, reason: string | null, patch: Partial<Pick<ActionRow, 'rejection_reason' | 'failure'>> = {}): Promise<ActionRow> {
  if (!ALLOWED_TRANSITIONS[action.state].includes(to)) {
    throw new IllegalTransitionError(`Illegal transition ${action.state} -> ${to} for action ${action.id}`);
  }
  const updated = (
    await tx.query<ActionRow>(
      `UPDATE actions SET state = $2, updated_at = now(), rejection_reason = coalesce($3, rejection_reason), failure = coalesce($4, failure)
       WHERE id = $1 RETURNING *`,
      [action.id, to, patch.rejection_reason ?? null, patch.failure ?? null],
    )
  ).rows[0]!;
  await tx.query('INSERT INTO action_transitions(action_id, from_state, to_state, actor, reason, at) VALUES ($1,$2,$3,$4,$5,now())', [action.id, action.state, to, actor, reason]);
  await appendAudit(tx, {
    principalId: action.principal_id,
    eventType: `ACTION_${to}`,
    actor,
    subjectType: 'action',
    subjectId: action.id,
    payload: { from: action.state, to, reason, version: action.current_version },
  });
  return updated;
}

async function createExecution(tx: Tx, action: ActionRow): Promise<void> {
  const version = (await tx.query<{ content_hash: string }>('SELECT content_hash FROM action_versions WHERE action_id = $1 AND version = $2', [action.id, action.current_version])).rows[0]!;
  await tx.query(
    `INSERT INTO action_executions(id, action_id, idempotency_key, version, content_hash, provider, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'PENDING',now(),now())`,
    [newId(), action.id, `wendy-action:${action.id}`, action.current_version, version.content_hash, ACTION_CATALOG[action.action_type].provider],
  );
}

/** Creates a proposed action (version 1, authored by Wendy) and applies the approval policy. */
export async function proposeAction(
  tx: Tx,
  a: { principalId: string; insightId: string | null; type: ActionType; targetPersonId: string | null; content: Record<string, unknown>; expiresAt: Date | null },
): Promise<ActionRow> {
  const policy = decidePolicy(a.type, await policyOverride(tx, a.principalId, a.type));
  const id = newId();
  const created = (
    await tx.query<ActionRow>(
      `INSERT INTO actions(id, principal_id, insight_id, action_type, target_person_id, state, authorization_level, policy_decision, current_version, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'PROPOSED',$6,$7,1,$8,now(),now()) RETURNING *`,
      [id, a.principalId, a.insightId, a.type, a.targetPersonId, ACTION_CATALOG[a.type].authorizationLevel, JSON.stringify(policy), a.expiresAt],
    )
  ).rows[0]!;
  await tx.query(`INSERT INTO action_versions(action_id, version, content, content_hash, author, created_at) VALUES ($1,1,$2,$3,'WENDY',now())`, [id, JSON.stringify(a.content), hashOf(a.content)]);
  await tx.query(`INSERT INTO action_transitions(action_id, from_state, to_state, actor, reason, at) VALUES ($1,NULL,'PROPOSED','WENDY',$2,now())`, [id, policy.rule]);
  await appendAudit(tx, {
    principalId: a.principalId,
    eventType: 'ACTION_PROPOSED',
    actor: 'WENDY',
    subjectType: 'action',
    subjectId: id,
    payload: { type: a.type, policy, contentHash: hashOf(a.content), insightId: a.insightId },
  });

  let row = await transition(tx, created, 'STAGED', 'WENDY', 'content prepared');
  if (policy.mode === 'AUTO') {
    row = await transition(tx, row, 'APPROVED', 'POLICY', policy.rule);
    await createExecution(tx, row);
  } else {
    row = await transition(tx, row, 'AWAITING_APPROVAL', 'POLICY', policy.rule);
  }
  return row;
}

export async function getActionContent(q: Queryable, actionId: string, version: number): Promise<{ content: Record<string, unknown>; content_hash: string }> {
  return (await q.query('SELECT content, content_hash FROM action_versions WHERE action_id = $1 AND version = $2', [actionId, version])).rows[0];
}

export class ActionService {
  constructor(private readonly db: Db) {}

  /** Principal approves (optionally with edited content → new version). Exactly one execution is created. */
  async approve(principalId: string, actionId: string, now: Date, editedContent?: Record<string, unknown>): Promise<ActionRow> {
    const result = await withTx(this.db, async (tx): Promise<ActionRow | { expiredAt: Date }> => {
      let action = await lockAction(tx, actionId, principalId);
      if (action.state !== 'AWAITING_APPROVAL') throw new IllegalTransitionError(`Action ${actionId} is ${action.state}; only AWAITING_APPROVAL can be approved`);
      if (action.expires_at && action.expires_at.getTime() <= now.getTime()) {
        // Commit the expiry (do not throw inside the transaction, or it would roll back).
        await transition(tx, action, 'EXPIRED', 'SYSTEM', 'approval arrived after expiry');
        return { expiredAt: action.expires_at };
      }
      if (editedContent) {
        const current = await getActionContent(tx, action.id, action.current_version);
        const merged = { ...current.content, ...editedContent };
        const version = action.current_version + 1;
        await tx.query(`INSERT INTO action_versions(action_id, version, content, content_hash, author, created_at) VALUES ($1,$2,$3,$4,'PRINCIPAL',now())`, [
          action.id,
          version,
          JSON.stringify(merged),
          hashOf(merged),
        ]);
        action = (await tx.query<ActionRow>('UPDATE actions SET current_version = $2 WHERE id = $1 RETURNING *', [action.id, version])).rows[0]!;
      }
      action = await transition(tx, action, 'APPROVED', 'PRINCIPAL', editedContent ? 'approved with edits' : 'approved');
      await createExecution(tx, action);
      await this.recordOutcome(tx, action, editedContent ? 'APPROVED_WITH_EDITS' : 'APPROVED', null, now);
      return action;
    });
    if ('expiredAt' in result) throw new IllegalTransitionError(`Action ${actionId} expired at ${result.expiredAt.toISOString()}`);
    return result;
  }

  async reject(principalId: string, actionId: string, reason: string | null, now: Date): Promise<ActionRow> {
    return withTx(this.db, async (tx) => {
      const action = await lockAction(tx, actionId, principalId);
      const updated = await transition(tx, action, 'REJECTED', 'PRINCIPAL', reason, { rejection_reason: reason });
      await this.recordOutcome(tx, updated, 'REJECTED', reason, now);
      return updated;
    });
  }

  async cancel(principalId: string, actionId: string, reason: string): Promise<ActionRow> {
    return withTx(this.db, async (tx) => transition(tx, await lockAction(tx, actionId, principalId), 'CANCELLED', 'SYSTEM', reason));
  }

  /** Expires every non-terminal, not-yet-executing action past its expiry. */
  async expireDue(principalId: string, now: Date): Promise<number> {
    const ids = (
      await this.db.query<{ id: string }>(
        `SELECT id FROM actions WHERE principal_id = $1 AND expires_at <= $2 AND state IN ('PROPOSED','STAGED','AWAITING_APPROVAL')`,
        [principalId, now],
      )
    ).rows;
    for (const { id } of ids) {
      await withTx(this.db, async (tx) => {
        const a = await lockAction(tx, id, principalId);
        if (ALLOWED_TRANSITIONS[a.state].includes('EXPIRED')) await transition(tx, a, 'EXPIRED', 'SYSTEM', 'expired');
      });
    }
    return ids.length;
  }

  /** Decisions become memory, so future reasoning sees how the principal responded (learning). */
  private async recordOutcome(tx: Tx, action: ActionRow, decision: string, reason: string | null, now: Date): Promise<void> {
    const content = `Principal decision on ${action.action_type} proposed by Wendy: ${decision}${reason ? ` (reason: ${reason})` : ''}.`;
    await tx.query(
      `INSERT INTO memories(id, principal_id, kind, subject_person_id, content, confidence, status, evidence, written_by, created_at)
       VALUES ($1,$2,'OUTCOME',$3,$4,1,'ACTIVE',$5,'SYSTEM',$6)`,
      [newId(), action.principal_id, action.target_person_id, content, JSON.stringify([{ kind: 'action', id: action.id }]), now],
    );
  }
}

export const isTerminal = (s: ActionState) => TERMINAL_ACTION_STATES.includes(s);
export { ActionState };
