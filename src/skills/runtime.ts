/**
 * SKILL RUNTIME — runs skill steps durably.
 *
 *   queued → running → (waiting_permission | waiting_child)* → completed | failed | cancelled
 *
 *  - A run is claimed with a lease (locked_until). The step cursor and step state are committed after
 *    every step, so a run interrupted by a crash or restart is picked up again (lease expired) at the
 *    step it was on. Steps are written to be re-runnable: effects and children are keyed per step.
 *  - Effects go through the existing action state machine: the permission engine decides AUTO / ask /
 *    never; a step that needs approval parks the run (waiting_permission) until the action is decided.
 *    Silence is never approval.
 *  - Composition: a step may start only the child skills its manifest declares. The parent parks
 *    (waiting_child) until the child finishes, and the runtime drives the child first.
 *  - Every move is a structured event in skill_execution_events (skill.*, tool.*, permission.*, model.*).
 */
import { proposeAction, type ActionRow } from '../actions/actions.js';
import type { ActionExecutor } from '../actions/executor.js';
import { ReasoningUnavailableError, type ReasoningClient } from '../cognition/llm.js';
import { withTx, type Db, type Queryable } from '../db/db.js';
import type { Clock } from '../util/clock.js';
import { newId } from '../util/hash.js';
import type { Toolbox } from '../tools/index.js';
import { getSources } from '../tools/sources.js';
import { TOOL_SPECS, type ToolName } from '../tools/specs.js';
import { ToolError } from '../tools/types.js';
import type { SkillRegistry } from './registry.js';
import { SkillError, type ChildOutcome, type EffectOutcome, type ExecutionError, type SkillDefinition, type StepContext, type StepResult } from './types.js';

export type ExecutionStatus = ChildOutcome['status'];
const TERMINAL: readonly ExecutionStatus[] = ['completed', 'failed', 'cancelled'];
const DECIDED_ACTION = ['VERIFIED', 'REJECTED', 'FAILED', 'CANCELLED', 'EXPIRED'];

export interface ExecutionRow {
  id: string;
  principal_id: string;
  skill_id: string;
  skill_version: string;
  parent_id: string | null;
  root_id: string;
  status: ExecutionStatus;
  input: unknown;
  output: unknown;
  error: ExecutionError | null;
  state: Record<string, unknown>;
  step_index: number;
  wait: { kind: 'action' | 'child'; id: string } | null;
  attempts: number;
  locked_until: Date | null;
  trigger: Record<string, unknown>;
  created_at: Date;
  completed_at: Date | null;
}

export interface RuntimeDeps {
  db: Db;
  registry: SkillRegistry;
  toolbox: Toolbox;
  reasoner: ReasoningClient;
  clock: Clock;
  executor: ActionExecutor;
  /** Identifies this process in leases (diagnostics only). */
  owner?: string;
  leaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  hooks?: {
    /** Test hook: called after a step's result is committed. Throwing here simulates a crash. */
    afterStepCommitted?: (executionId: string, stepId: string) => void | Promise<void>;
  };
}

const clip = (v: unknown, n = 600) => {
  const s = JSON.stringify(v) ?? 'null';
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function toExecutionError(e: unknown, step: string | null): ExecutionError {
  if (e instanceof SkillError) return { code: e.code, message: e.message, step, retryable: e.retryable };
  if (e instanceof ToolError) return { code: e.code === 'TIMEOUT' ? 'TIMEOUT' : e.code === 'NOT_ALLOWED' || e.code === 'BLOCKED' ? 'NOT_ALLOWED' : 'TOOL_FAILED', message: `${e.code}: ${e.message}`, step, retryable: e.retryable };
  if (e instanceof ReasoningUnavailableError) return { code: 'MODEL_UNAVAILABLE', message: e.message, step, retryable: true };
  return { code: 'INTERNAL', message: e instanceof Error ? `${e.name}: ${e.message}` : String(e), step, retryable: false };
}

export class SkillRuntime {
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: RuntimeDeps) {
    this.owner = deps.owner ?? `pid:${process.pid}`;
    this.leaseMs = deps.leaseMs ?? 5 * 60_000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  /** Validates and queues a run. Nothing executes until advance()/runReady(). */
  async start(principalId: string, skillId: string, input: unknown, trigger: Record<string, unknown>, parent?: ExecutionRow): Promise<string> {
    const skill = this.deps.registry.get(skillId);
    if (!skill || !this.deps.registry.isEnabled(skillId)) throw new SkillError('NOT_ALLOWED', `skill ${skillId} is not available`);
    const parsed = skill.inputs.safeParse(input);
    if (!parsed.success) throw new SkillError('INVALID_INPUT', `${skillId}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`);
    const id = newId();
    const now = this.deps.clock.now();
    await this.deps.db.query(
      `INSERT INTO skill_executions(id, principal_id, skill_id, skill_version, parent_id, root_id, status, input, trigger, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$9)`,
      [id, principalId, skill.id, skill.version, parent?.id ?? null, parent?.root_id ?? id, JSON.stringify(parsed.data), JSON.stringify(trigger), now],
    );
    await this.event(this.deps.db, id, 'skill.queued', skill.id, { version: skill.version, input: clip(parsed.data), parent: parent?.id ?? null });
    return id;
  }

  async get(id: string, q: Queryable = this.deps.db): Promise<ExecutionRow | null> {
    return (await q.query<ExecutionRow>('SELECT * FROM skill_executions WHERE id = $1', [id])).rows[0] ?? null;
  }

  async cancel(principalId: string, id: string, reason: string): Promise<void> {
    await withTx(this.deps.db, async (tx) => {
      const r = (await tx.query<ExecutionRow>('SELECT * FROM skill_executions WHERE id = $1 AND principal_id = $2 FOR UPDATE', [id, principalId])).rows[0];
      if (!r || TERMINAL.includes(r.status)) return;
      await tx.query(`UPDATE skill_executions SET status = 'cancelled', error = $2, locked_until = NULL, updated_at = $3, completed_at = $3 WHERE id = $1`, [
        id,
        JSON.stringify({ code: 'REJECTED', message: reason, step: null, retryable: false } satisfies ExecutionError),
        this.deps.clock.now(),
      ]);
      await this.event(tx, id, 'skill.cancelled', r.skill_id, { reason });
    });
  }

  /**
   * Finds runs that can make progress and advances them: queued runs, runs whose lease expired
   * (process died), and parked runs whose action or child has been decided. Approved effects are
   * executed first so the runs waiting on them see the result.
   */
  async runReady(limit = 20): Promise<string[]> {
    await this.deps.executor.runPending();
    const now = this.deps.clock.now();
    const rows = (
      await this.deps.db.query<{ id: string }>(
        `SELECT e.id FROM skill_executions e
          WHERE e.status = 'queued'
             OR (e.status = 'running' AND (e.locked_until IS NULL OR e.locked_until < $1))
             OR (e.status = 'waiting_permission' AND EXISTS (SELECT 1 FROM actions a WHERE a.id::text = e.wait->>'id' AND a.state = ANY($2)))
             OR (e.status = 'waiting_child' AND EXISTS (SELECT 1 FROM skill_executions c WHERE c.id::text = e.wait->>'id' AND c.status = ANY($3)))
          ORDER BY e.created_at LIMIT $4`,
        [now, DECIDED_ACTION, TERMINAL, limit],
      )
    ).rows;
    const advanced: string[] = [];
    for (const r of rows) if (await this.advance(r.id)) advanced.push(r.id);
    return advanced;
  }

  /** Runs one execution as far as it can go. Returns false if another process holds it. */
  async advance(id: string): Promise<boolean> {
    let exec = await this.claim(id);
    if (!exec) return false;
    const skill = this.deps.registry.get(exec.skill_id);
    if (!skill) {
      await this.finish(exec, 'failed', null, { code: 'NOT_ALLOWED', message: `skill ${exec.skill_id} is no longer registered`, step: null, retryable: false });
      return true;
    }
    if (exec.attempts === 1 && exec.step_index === 0) await this.event(this.deps.db, exec.id, 'skill.started', skill.id, { version: skill.version });

    for (;;) {
      const step = skill.steps[exec.step_index];
      if (!step) {
        await this.finish(exec, 'failed', null, { code: 'INVALID_OUTPUT', message: 'skill ran out of steps without an output', step: null, retryable: false });
        return true;
      }
      const ctx = this.stepContext(exec, skill);
      let result: StepResult;
      try {
        result = await this.runStep(exec, step, ctx);
      } catch (e) {
        await this.finish(exec, 'failed', null, toExecutionError(e, step.id), ctx.state);
        return true;
      }

      if (result.kind === 'next') {
        const committed = await this.commitStep(exec, exec.step_index + 1, ctx.state);
        if (!committed) return true; // lease lost to another process; it continues from the committed step
        exec = committed;
        await this.event(this.deps.db, exec.id, 'skill.step.completed', step.id, {});
        await this.deps.hooks?.afterStepCommitted?.(exec.id, step.id);
        continue;
      }
      if (result.kind === 'done') {
        const out = skill.outputs.safeParse(result.output);
        if (!out.success) {
          await this.finish(exec, 'failed', null, { code: 'INVALID_OUTPUT', message: out.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '), step: step.id, retryable: false }, ctx.state);
        } else {
          await this.event(this.deps.db, exec.id, 'skill.step.completed', step.id, {});
          await this.finish(exec, 'completed', out.data, null, ctx.state);
        }
        return true;
      }
      if (result.kind === 'wait_action') {
        await this.park(exec, 'waiting_permission', { kind: 'action', id: result.actionId }, ctx.state);
        return true;
      }
      // wait_child: drive the child now; if it finishes, re-run this step to read its result.
      exec = await this.park(exec, 'waiting_child', { kind: 'child', id: result.childId }, ctx.state);
      this.driving.add(exec.id);
      try {
        await this.advance(result.childId);
      } finally {
        this.driving.delete(exec.id);
      }
      const child = await this.get(result.childId);
      if (!child || !TERMINAL.includes(child.status)) return true; // child parked (e.g. waiting for approval)
      const reclaimed = await this.claim(exec.id);
      if (!reclaimed) return true;
      exec = reclaimed;
    }
  }

  // ── steps ────────────────────────────────────────────────────────────────────

  private async runStep(exec: ExecutionRow, step: SkillDefinition['steps'][number], ctx: StepContext): Promise<StepResult> {
    const attempts = Math.max(1, step.retry?.attempts ?? 1);
    for (let attempt = 1; ; attempt++) {
      await this.event(this.deps.db, exec.id, 'skill.step.started', step.id, { attempt, label: step.label });
      try {
        const run = step.run(ctx);
        if (!step.timeoutMs) return await run;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SkillError('TIMEOUT', `step ${step.id} took longer than ${step.timeoutMs} ms`, true)), step.timeoutMs);
        });
        try {
          return await Promise.race([run, timeout]);
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        const err = toExecutionError(e, step.id);
        await this.event(this.deps.db, exec.id, 'skill.step.failed', step.id, { attempt, error: err });
        if (!err.retryable || attempt >= attempts) throw e;
        await this.sleep((step.retry?.backoffMs ?? 0) * attempt);
      }
    }
  }

  private stepContext(exec: ExecutionRow, skill: SkillDefinition): StepContext {
    const { db, toolbox, reasoner, clock } = this.deps;
    const state: Record<string, unknown> = structuredClone(exec.state ?? {});
    const allowed = new Set(skill.requiredTools);
    const requireTool = (tool: ToolName) => {
      if (!allowed.has(tool)) throw new SkillError('NOT_ALLOWED', `${skill.id} did not declare tool ${tool}`);
    };

    return {
      executionId: exec.id,
      principalId: exec.principal_id,
      skillId: skill.id,
      now: clock.now(),
      input: exec.input,
      state,

      read: async (tool, input) => {
        requireTool(tool);
        const t = toolbox.read(tool);
        if (!t) throw new SkillError('NOT_ALLOWED', `${tool} is not a read-only tool; request it as an effect`);
        const parsed = t.input.safeParse(input);
        if (!parsed.success) throw new SkillError('INVALID_INPUT', `${tool}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
        await this.event(db, exec.id, 'tool.called', tool, { input: clip(parsed.data) });
        try {
          const out = await t.run({ db, principalId: exec.principal_id, now: clock.now(), executionId: exec.id }, parsed.data);
          await this.event(db, exec.id, 'tool.completed', tool, { output: clip(out) });
          return out;
        } catch (e) {
          await this.event(db, exec.id, 'tool.failed', tool, { error: e instanceof Error ? e.message : String(e) });
          throw e;
        }
      },

      effect: async (key, tool, content) => {
        requireTool(tool);
        const t = toolbox.effect(tool);
        if (!t) throw new SkillError('NOT_ALLOWED', `${tool} has no effect`);
        const parsed = t.input.safeParse(content);
        if (!parsed.success) throw new SkillError('INVALID_INPUT', `${tool}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
        let action = await this.actionFor(exec.id, key);
        if (!action) {
          action = await withTx(db, (tx) =>
            proposeAction(tx, { principalId: exec.principal_id, insightId: null, type: tool, targetPersonId: null, content: parsed.data, expiresAt: null, skill: { executionId: exec.id, stepKey: key } }),
          );
          await this.event(db, exec.id, 'permission.requested', tool, { actionId: action.id, decision: action.policy_decision, category: TOOL_SPECS[tool].category });
        }
        if (action.state === 'APPROVED') {
          await this.deps.executor.runPending();
          action = (await this.actionFor(exec.id, key))!;
        }
        return this.outcomeOf(exec.id, tool, action);
      },

      startChild: async (key, skillId, input) => {
        if (!skill.dependencies?.includes(skillId)) throw new SkillError('NOT_ALLOWED', `${skill.id} does not declare ${skillId} as a dependency`);
        const existing = (await db.query<{ id: string }>(`SELECT id FROM skill_executions WHERE parent_id = $1 AND trigger->>'key' = $2`, [exec.id, key])).rows[0];
        if (existing) return existing.id;
        const id = await this.start(exec.principal_id, skillId, input, { kind: 'parent', key }, exec);
        await this.event(db, exec.id, 'skill.child.started', skillId, { childId: id, key });
        return id;
      },

      child: async (childId) => {
        const c = await this.get(childId);
        if (!c || c.parent_id !== exec.id) throw new SkillError('NOT_ALLOWED', `${childId} is not a child of this run`);
        return { status: c.status, output: c.output, error: c.error };
      },

      sources: (ids) => getSources(db, exec.principal_id, ids),

      language: async () => (await db.query<{ locale: string }>('SELECT locale FROM principals WHERE id = $1', [exec.principal_id])).rows[0]?.locale ?? 'pt-BR',

      principal: async () => {
        const p = (await db.query<{ display_name: string; locale: string }>('SELECT display_name, locale FROM principals WHERE id = $1', [exec.principal_id])).rows[0];
        return { displayName: p?.display_name ?? 'the principal', locale: p?.locale ?? 'pt-BR' };
      },

      reason: async (req) => {
        const r = await reasoner.generate({ ...req, principalId: exec.principal_id, purpose: `skill:${skill.id}:${req.purpose}` });
        await this.event(db, exec.id, 'model.called', req.purpose, { modelCallId: r.modelCallId, model: r.model });
        return r;
      },
    };
  }

  private async actionFor(executionId: string, key: string): Promise<ActionRow | null> {
    return (await this.deps.db.query<ActionRow>('SELECT * FROM actions WHERE skill_execution_id = $1 AND skill_step_key = $2', [executionId, key])).rows[0] ?? null;
  }

  private async outcomeOf(executionId: string, tool: ToolName, a: ActionRow): Promise<EffectOutcome> {
    if (a.state === 'VERIFIED') {
      await this.eventOnce(executionId, 'tool.completed', tool, { actionId: a.id, state: a.state });
      return { status: 'done', actionId: a.id };
    }
    if (a.state === 'REJECTED' || a.state === 'EXPIRED' || a.state === 'CANCELLED' || a.state === 'FAILED') {
      const type = a.state === 'FAILED' ? 'tool.failed' : 'permission.denied';
      await this.eventOnce(executionId, type, tool, { actionId: a.id, state: a.state, reason: a.rejection_reason ?? a.failure ?? a.policy_decision?.rule ?? null });
      return { status: 'refused', actionId: a.id, state: a.state, reason: a.rejection_reason ?? a.failure ?? (a.state === 'CANCELLED' ? a.policy_decision?.rule ?? null : null) };
    }
    return { status: 'pending', actionId: a.id };
  }

  // ── persistence ──────────────────────────────────────────────────────────────

  private async claim(id: string): Promise<ExecutionRow | null> {
    const now = this.deps.clock.now();
    return (
      (
        await this.deps.db.query<ExecutionRow>(
          `UPDATE skill_executions
              SET status = 'running', locked_until = $2, lease_owner = $3, attempts = attempts + 1,
                  started_at = coalesce(started_at, $4), updated_at = $4, wait = NULL
            WHERE id = $1
              AND (status IN ('queued', 'waiting_permission', 'waiting_child')
                   OR (status = 'running' AND (locked_until IS NULL OR locked_until < $4)))
            RETURNING *`,
          [id, new Date(now.getTime() + this.leaseMs), this.owner, now],
        )
      ).rows[0] ?? null
    );
  }

  /** Commits the cursor and renews the lease; null if this process no longer holds the run. */
  private async commitStep(exec: ExecutionRow, nextIndex: number, state: Record<string, unknown>): Promise<ExecutionRow | null> {
    const now = this.deps.clock.now();
    return (
      (
        await this.deps.db.query<ExecutionRow>(
          `UPDATE skill_executions SET step_index = $2, state = $3, locked_until = $4, updated_at = $5
            WHERE id = $1 AND status = 'running' AND lease_owner = $6 AND attempts = $7 RETURNING *`,
          [exec.id, nextIndex, JSON.stringify(state), new Date(now.getTime() + this.leaseMs), now, this.owner, exec.attempts],
        )
      ).rows[0] ?? null
    );
  }

  private async park(exec: ExecutionRow, status: 'waiting_permission' | 'waiting_child', wait: NonNullable<ExecutionRow['wait']>, state: Record<string, unknown>): Promise<ExecutionRow> {
    const row = (
      await this.deps.db.query<ExecutionRow>(
        `UPDATE skill_executions SET status = $2, wait = $3, state = $4, locked_until = NULL, updated_at = $5 WHERE id = $1 RETURNING *`,
        [exec.id, status, JSON.stringify(wait), JSON.stringify(state), this.deps.clock.now()],
      )
    ).rows[0]!;
    await this.eventOnce(exec.id, status === 'waiting_permission' ? 'skill.waiting_permission' : 'skill.waiting_child', wait.id, wait);
    return row;
  }

  private async finish(exec: ExecutionRow, status: 'completed' | 'failed', output: unknown, error: ExecutionError | null, state?: Record<string, unknown>): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.db.query(
      `UPDATE skill_executions SET status = $2, output = $3, error = $4, state = coalesce($5, state), locked_until = NULL, wait = NULL, updated_at = $6, completed_at = $6 WHERE id = $1`,
      [exec.id, status, output === null || output === undefined ? null : JSON.stringify(output), error ? JSON.stringify(error) : null, state ? JSON.stringify(state) : null, now],
    );
    await this.event(this.deps.db, exec.id, status === 'completed' ? 'skill.completed' : 'skill.failed', exec.skill_id, status === 'completed' ? { output: clip(output) } : { error });
    // A parent parked on this run can continue now.
    if (exec.parent_id) {
      const parent = await this.get(exec.parent_id);
      if (parent?.status === 'waiting_child' && parent.wait?.id === exec.id && !this.driving.has(parent.id)) await this.advance(parent.id);
    }
  }

  /** Parents currently being driven in this process (their own loop resumes them). */
  private readonly driving = new Set<string>();

  private async event(q: Queryable, executionId: string, type: string, name: string | null, data: unknown): Promise<void> {
    await q.query(
      `INSERT INTO skill_execution_events(execution_id, seq, type, name, data, at)
       VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM skill_execution_events WHERE execution_id = $1), $2, $3, $4, $5)`,
      [executionId, type, name, JSON.stringify(data ?? {}), this.deps.clock.now()],
    );
  }

  /** Same event at most once per run and subject (re-runs of a step do not repeat it). */
  private async eventOnce(executionId: string, type: string, name: string, data: Record<string, unknown> | { kind: string; id: string }): Promise<void> {
    const seen = await this.deps.db.query(`SELECT 1 FROM skill_execution_events WHERE execution_id = $1 AND type = $2 AND data = $3::jsonb LIMIT 1`, [executionId, type, JSON.stringify(data)]);
    if (!seen.rowCount) await this.event(this.deps.db, executionId, type, name, data);
  }
}
