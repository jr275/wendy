/**
 * EXECUTION. Runs approved actions exactly once.
 *
 *  - Refuses to run anything if the audit ledger is not intact (fail closed).
 *  - Each action has one execution row (UNIQUE) with a stable idempotency key passed to the provider.
 *  - The execution is marked IN_FLIGHT and committed BEFORE the provider is called. A crash after
 *    that leaves IN_FLIGHT; reconciliation asks the provider (by idempotency key) whether the effect
 *    happened instead of re-sending blindly.
 *  - VERIFIED only after an independent read-back from the provider matches the approved content.
 */
import { assertLedgerIntegrity } from '../audit/ledger.js';
import { withTx, type Db } from '../db/db.js';
import type { EmailProvider } from '../providers/interfaces.js';
import { effectsToolbox, type Toolbox } from '../tools/index.js';
import { ToolError } from '../tools/types.js';
import { hashOf, newId } from '../util/hash.js';
import { getActionContent, lockAction, transition, type ActionRow } from './actions.js';

interface ExecutionRow {
  id: string;
  action_id: string;
  idempotency_key: string;
  version: number;
  content_hash: string;
  provider: string;
  status: 'PENDING' | 'IN_FLIGHT' | 'SUCCEEDED' | 'FAILED';
  attempts: number;
  updated_at: Date;
}

export interface ExecutorHooks {
  /** Test hook: called right after the provider accepted the effect, before the outcome is recorded. */
  afterProviderAccepted?: (actionId: string) => void | Promise<void>;
}

export const MAX_EXECUTION_ATTEMPTS = 3;

interface Effect {
  name: string;
  deliversExternally: boolean;
  perform(principalId: string, key: string, actionId: string, content: Record<string, unknown>): Promise<{ providerRef: string }>;
  readBack(principalId: string, key: string, actionId: string): Promise<{ providerRef: string; observed: Record<string, unknown> } | null>;
  expected(content: Record<string, unknown>): Record<string, unknown>;
  /** Long-running effects: 'pending' until the effect has finished; verification waits for 'done'. */
  settle?(principalId: string, actionId: string, content: Record<string, unknown>): Promise<'done' | 'pending'>;
}

function emailEffect(provider: EmailProvider): Effect {
  return {
    name: provider.name,
    deliversExternally: provider.deliversExternally,
    perform: (principalId, key, _actionId, c) =>
      provider.send(principalId, { idempotencyKey: key, to: c.to as string[], subject: String(c.subject), body: String(c.body) }),
    readBack: async (principalId, key) => {
      const r = await provider.findByIdempotencyKey(principalId, key);
      return r ? { providerRef: r.providerRef, observed: { to: r.to, subject: r.subject, body: r.body } } : null;
    },
    expected: (c) => ({ to: c.to, subject: c.subject, body: c.body }),
  };
}

function artifactEffect(db: Db): Effect {
  return {
    name: 'INTERNAL_ARTIFACTS',
    deliversExternally: false,
    perform: async (principalId, _key, actionId, c) => {
      await db.query(
        `INSERT INTO artifacts(id, principal_id, action_id, kind, content, content_hash, created_at)
         VALUES ($1,$2,$3,'BRIEFING',$4,$5,now()) ON CONFLICT (action_id) DO NOTHING`,
        [newId(), principalId, actionId, JSON.stringify(c), hashOf(c)],
      );
      const r = (await db.query<{ id: string }>('SELECT id FROM artifacts WHERE action_id = $1', [actionId])).rows[0]!;
      return { providerRef: r.id };
    },
    readBack: async (principalId, _key, actionId) => {
      const r = (await db.query<{ id: string; content: Record<string, unknown> }>('SELECT id, content FROM artifacts WHERE principal_id = $1 AND action_id = $2', [principalId, actionId])).rows[0];
      return r ? { providerRef: r.id, observed: r.content } : null;
    },
    expected: (c) => c,
  };
}

/** A tool with an effect, adapted to the executor's perform / read back / compare contract. */
function toolEffect(db: Db, toolbox: Toolbox, action: ActionRow): Effect {
  const tool = toolbox.effect(action.action_type);
  if (!tool) throw new ToolError('NOT_ALLOWED', `no tool implements ${action.action_type}`);
  const ctx = (actionId: string) => ({ db, principalId: action.principal_id, now: new Date(), actionId, executionId: action.skill_execution_id ?? undefined });
  const parse = (c: Record<string, unknown>) => tool.input.parse(c);
  return {
    name: `TOOL:${tool.spec.name}`,
    deliversExternally: tool.spec.category === 'EXTERNAL' || tool.spec.category === 'PAYMENT',
    perform: (_p, _key, actionId, c) => tool.perform(ctx(actionId), parse(c)),
    readBack: async (_p, _key, actionId) => {
      const { content } = await getActionContent(db, actionId, action.current_version);
      return tool.readBack(ctx(actionId), parse(content));
    },
    expected: (c) => tool.expected(parse(c)),
    ...(tool.settle ? { settle: (_p: string, actionId: string, c: Record<string, unknown>) => tool.settle!(ctx(actionId), parse(c)) } : {}),
  };
}

export class ActionExecutor {
  constructor(
    private readonly db: Db,
    private readonly emailProvider: EmailProvider,
    private readonly hooks: ExecutorHooks = {},
    /** Effects of tools (tasks.*). Always present, so no executor can mis-handle an approved tool action. */
    private readonly toolbox: Toolbox = effectsToolbox(),
  ) {}

  private effectFor(action: ActionRow): Effect {
    if (action.action_type === 'SEND_EMAIL') return emailEffect(this.emailProvider);
    if (action.action_type === 'PREPARE_BRIEFING') return artifactEffect(this.db);
    return toolEffect(this.db, this.toolbox, action);
  }

  /** Executes all PENDING executions. Returns the action ids that reached a terminal or executed state. */
  async runPending(): Promise<string[]> {
    await assertLedgerIntegrity(this.db);
    const done: string[] = [];
    for (;;) {
      const claimed = await this.claimOne();
      if (!claimed) break;
      await this.perform(claimed.execution, claimed.action);
      done.push(claimed.action.id);
    }
    return done;
  }

  private async claimOne(): Promise<{ execution: ExecutionRow; action: ActionRow } | null> {
    return withTx(this.db, async (tx) => {
      const execution = (
        await tx.query<ExecutionRow>(`SELECT * FROM action_executions WHERE status = 'PENDING' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`)
      ).rows[0];
      if (!execution) return null;
      const principalId = (await tx.query<{ principal_id: string }>('SELECT principal_id FROM actions WHERE id = $1', [execution.action_id])).rows[0]!.principal_id;
      let action = await lockAction(tx, execution.action_id, principalId);
      if (action.state !== 'APPROVED') {
        await tx.query(`UPDATE action_executions SET status = 'FAILED', last_error = $2, updated_at = now() WHERE id = $1`, [execution.id, `action is ${action.state}, not APPROVED`]);
        return { execution: { ...execution, status: 'FAILED' }, action };
      }
      await tx.query(`UPDATE action_executions SET status = 'IN_FLIGHT', attempts = attempts + 1, updated_at = now() WHERE id = $1`, [execution.id]);
      action = await transition(tx, action, 'EXECUTING', 'EXECUTOR', `attempt ${execution.attempts + 1} via ${execution.provider}`);
      return { execution: { ...execution, status: 'IN_FLIGHT', attempts: execution.attempts + 1 }, action };
    });
  }

  private async perform(execution: ExecutionRow, action: ActionRow): Promise<void> {
    if (execution.status !== 'IN_FLIGHT') return;
    let effect: Effect;
    try {
      effect = this.effectFor(action);
    } catch (e) {
      await this.fail(execution, action, e instanceof Error ? e.message : String(e));
      return;
    }
    const { content, content_hash } = await getActionContent(this.db, action.id, execution.version);
    if (content_hash !== execution.content_hash) {
      await this.fail(execution, action, 'approved content hash does not match execution record');
      return;
    }
    let providerRef: string;
    try {
      ({ providerRef } = await effect.perform(action.principal_id, execution.idempotency_key, action.id, content));
    } catch (err) {
      await this.reconcile(execution.id, `provider error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    await this.hooks.afterProviderAccepted?.(action.id);
    await this.recordSuccess(execution, action, providerRef, effect);
    if (effect.settle && (await effect.settle(action.principal_id, action.id, content)) === 'pending') return; // verified later by settleAsync
    await this.verify(execution.id);
  }

  /**
   * Long-running effects that were started but not verified yet: ask each whether it has finished,
   * and verify the ones that have. Effects without `settle` never get here (they verify at once).
   */
  async settleAsync(): Promise<string[]> {
    const rows = (
      await this.db.query<{ execution_id: string; action_id: string }>(
        `SELECT e.id AS execution_id, a.id AS action_id FROM action_executions e JOIN actions a ON a.id = e.action_id
          WHERE e.status = 'SUCCEEDED' AND e.verification IS NULL AND a.state = 'EXECUTED'`,
      )
    ).rows;
    const settled: string[] = [];
    for (const r of rows) {
      const action = (await this.db.query<ActionRow>('SELECT * FROM actions WHERE id = $1', [r.action_id])).rows[0]!;
      let effect: Effect;
      try {
        effect = this.effectFor(action);
      } catch {
        continue;
      }
      if (!effect.settle) continue;
      const { content } = await getActionContent(this.db, action.id, action.current_version);
      if ((await effect.settle(action.principal_id, action.id, content)) === 'done') {
        await this.verify(r.execution_id);
        settled.push(action.id);
      }
    }
    return settled;
  }

  private async recordSuccess(execution: ExecutionRow, action: ActionRow, providerRef: string, effect: Effect): Promise<void> {
    await withTx(this.db, async (tx) => {
      await tx.query(`UPDATE action_executions SET status = 'SUCCEEDED', provider_ref = $2, updated_at = now() WHERE id = $1`, [execution.id, providerRef]);
      const locked = await lockAction(tx, action.id, action.principal_id);
      await transition(tx, locked, 'EXECUTED', 'EXECUTOR', `${effect.name} accepted (ref ${providerRef})${effect.deliversExternally ? '' : ' — NOT delivered externally'}`);
    });
  }

  /** Independent read-back: VERIFIED only if what the provider holds matches the approved version. */
  async verify(executionId: string): Promise<void> {
    const execution = (await this.db.query<ExecutionRow>('SELECT * FROM action_executions WHERE id = $1', [executionId])).rows[0]!;
    const action = (await this.db.query<ActionRow>('SELECT * FROM actions WHERE id = $1', [execution.action_id])).rows[0]!;
    if (action.state !== 'EXECUTED') return;
    const effect = this.effectFor(action);
    const { content } = await getActionContent(this.db, action.id, execution.version);
    const observed = await effect.readBack(action.principal_id, execution.idempotency_key, action.id);
    const matches = !!observed && hashOf(observed.observed) === hashOf(effect.expected(content));
    const verification = {
      provider: effect.name,
      deliversExternally: effect.deliversExternally,
      readBackFound: !!observed,
      contentMatches: matches,
      checkedAt: new Date().toISOString(),
    };
    await withTx(this.db, async (tx) => {
      await tx.query('UPDATE action_executions SET verification = $2, updated_at = now() WHERE id = $1', [execution.id, JSON.stringify(verification)]);
      const locked = await lockAction(tx, action.id, action.principal_id);
      if (matches) await transition(tx, locked, 'VERIFIED', 'VERIFIER', `read-back from ${effect.name} matches approved version ${execution.version}`);
      else await transition(tx, locked, 'FAILED', 'VERIFIER', 'read-back missing or content mismatch', { failure: 'verification failed' });
    });
  }

  /**
   * Resolves executions left IN_FLIGHT (crash/restart or provider error). Asks the provider by
   * idempotency key: if the effect exists, record success and verify; if not, it is safe to retry
   * (the provider is idempotent on the key) up to MAX_EXECUTION_ATTEMPTS.
   */
  async reconcileInFlight(staleBefore: Date): Promise<string[]> {
    const rows = (await this.db.query<{ id: string }>(`SELECT id FROM action_executions WHERE status = 'IN_FLIGHT' AND updated_at <= $1`, [staleBefore])).rows;
    for (const r of rows) await this.reconcile(r.id, 'reconciliation after interruption');
    return rows.map((r) => r.id);
  }

  private async reconcile(executionId: string, note: string): Promise<void> {
    const execution = (await this.db.query<ExecutionRow>('SELECT * FROM action_executions WHERE id = $1', [executionId])).rows[0]!;
    if (execution.status !== 'IN_FLIGHT') return;
    const action = (await this.db.query<ActionRow>('SELECT * FROM actions WHERE id = $1', [execution.action_id])).rows[0]!;
    const effect = this.effectFor(action);
    const observed = await effect.readBack(action.principal_id, execution.idempotency_key, action.id);
    if (observed) {
      await this.recordSuccess(execution, action, observed.providerRef, effect);
      await this.verify(execution.id);
      return;
    }
    await withTx(this.db, async (tx) => {
      const locked = await lockAction(tx, action.id, action.principal_id);
      if (execution.attempts >= MAX_EXECUTION_ATTEMPTS) {
        await tx.query(`UPDATE action_executions SET status = 'FAILED', last_error = $2, updated_at = now() WHERE id = $1`, [execution.id, note]);
        await transition(tx, locked, 'FAILED', 'EXECUTOR', `${note}; gave up after ${execution.attempts} attempts`, { failure: note });
      } else {
        await tx.query(`UPDATE action_executions SET status = 'PENDING', last_error = $2, updated_at = now() WHERE id = $1`, [execution.id, note]);
        await transition(tx, locked, 'APPROVED', 'EXECUTOR', `${note}; provider has no record of key — safe to retry`);
      }
    });
  }

  private async fail(execution: ExecutionRow, action: ActionRow, reason: string): Promise<void> {
    await withTx(this.db, async (tx) => {
      await tx.query(`UPDATE action_executions SET status = 'FAILED', last_error = $2, updated_at = now() WHERE id = $1`, [execution.id, reason]);
      await transition(tx, await lockAction(tx, action.id, action.principal_id), 'FAILED', 'EXECUTOR', reason, { failure: reason });
    });
  }
}
