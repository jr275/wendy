/**
 * Phase 1.1 — cancelling a RUN TREE (parent + children). Real runtime, real registry (with small
 * test-only composite skills registered next to the built-ins), real action state machine, real
 * voice tool on MockVoiceProvider. Each scenario checks the database AND what the runtime does
 * afterwards (does anything still run, get approved, or get executed?). No sleeps: states are
 * reached by driving the runtime step by step.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionService, IllegalTransitionError } from '../../src/actions/actions.js';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import { cancelExecution } from '../../src/skills/cancel.js';
import { builtinRegistry, createSkillRuntime } from '../../src/skills/index.js';
import { SkillError, type SkillDefinition, type StepContext, type StepResult } from '../../src/skills/types.js';
import { Toolbox } from '../../src/tools/index.js';
import { fixedClock } from '../../src/util/clock.js';
import { voiceConfig } from '../../src/voice/config.js';
import { MemoryMockStore, MockVoiceProvider } from '../../src/voice/mock.js';
import { VoicePolicy } from '../../src/voice/policy.js';
import type { VoiceMandate } from '../../src/voice/types.js';
import { createTestDb } from '../helpers/db.js';
import { ScriptedReasoner } from '../helpers/scriptedReasoner.js';
import { z } from 'zod';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
const clock = fixedClock('2026-10-10T15:00:00Z');
const base = voiceConfig({});
beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => t.drop());
beforeEach(() => clock.set('2026-10-10T15:00:00Z'));

// ── test-only composite skills ───────────────────────────────────────────────────────────
const skill = (o: Partial<SkillDefinition> & Pick<SkillDefinition, 'id' | 'steps'>): SkillDefinition => ({
  name: o.id,
  description: 'test-only composite skill',
  version: '0.0.1',
  triggers: [],
  requiredTools: [],
  composable: true,
  autonomous: false,
  riskLevel: 'LOW',
  instructions: '',
  inputs: z.unknown(),
  outputs: z.unknown(),
  ...o,
});
/** Starts a child once and waits for it (re-run reads its result). */
const childStep = (childSkill: string, input: () => unknown) => async (ctx: StepContext): Promise<StepResult> => {
  const id = await ctx.startChild('child', childSkill, input());
  const c = await ctx.child(id);
  if (c.status === 'completed') return { kind: 'next' };
  if (c.status === 'failed' || c.status === 'cancelled') throw new SkillError('CHILD_FAILED', `child ${c.status}`);
  return { kind: 'wait_child', childId: id };
};
const taskEffect = (title: string) => async (ctx: StepContext): Promise<StepResult> => {
  const r = await ctx.effect('task', 'tasks.create', { tasks: [{ title }] });
  return r.status === 'pending' ? { kind: 'wait_action', actionId: r.actionId } : { kind: 'done', output: { status: r.status } };
};
const TASK_CHILD = skill({ id: 'tree-task-child', requiredTools: ['tasks.create'], steps: [{ id: 'task', label: 'x', run: taskEffect('Tarefa do filho') }] });
const QUICK_CHILD = skill({ id: 'tree-quick-child', steps: [{ id: 'done', label: 'x', run: async () => ({ kind: 'done', output: { ok: true } }) }] });
const TASK_PARENT = skill({ id: 'tree-task-parent', dependencies: ['tree-task-child'], steps: [{ id: 'child', label: 'x', run: childStep('tree-task-child', () => ({})) }, { id: 'end', label: 'x', run: async () => ({ kind: 'done', output: {} }) }] });
const MIXED_PARENT = skill({
  id: 'tree-mixed-parent',
  dependencies: ['tree-quick-child'],
  requiredTools: ['tasks.create'],
  steps: [
    { id: 'child', label: 'x', run: childStep('tree-quick-child', () => ({})) },
    { id: 'own', label: 'x', run: taskEffect('Tarefa do pai') },
  ],
});
const mandate = (): VoiceMandate => ({
  objective: 'Reservar uma mesa',
  language: 'pt-BR',
  target: { name: 'Restaurante Aurora', phone: '+552130001000', phoneSource: { kind: 'principal' } },
  parameters: { date: '2026-10-10', time: '20:00', party_size: 2 },
  authorizedActions: ['ask', 'request_booking'],
  forbiddenActions: [],
  disclosures: [],
  limits: base.limits,
});
const CALL_PARENT = skill({ id: 'tree-call-parent', riskLevel: 'HIGH', dependencies: ['voice-concierge'], steps: [{ id: 'child', label: 'x', run: childStep('voice-concierge', mandate) }, { id: 'end', label: 'x', run: async () => ({ kind: 'done', output: {} }) }] });

function setup() {
  const store = new MemoryMockStore();
  const provider = new MockVoiceProvider({ store, now: () => clock.now(), scenario: () => 'long' });
  const ctx = createContext({ db, reasoner: new ScriptedReasoner(db, {}), clock, emailProvider: new DevMailboxProvider(db) });
  const toolbox = new Toolbox({ search: () => ({ name: 'none', search: async () => [] }), documentsRoot: '/nonexistent', voice: { provider: async () => provider, policy: new VoicePolicy(base), clock } });
  const registry = builtinRegistry().register(TASK_CHILD).register(QUICK_CHILD).register(TASK_PARENT).register(MIXED_PARENT).register(CALL_PARENT);
  return { ...createSkillRuntime(ctx, { registry, toolbox, sleep: async () => {} }), store };
}
const principal = () => createPrincipal(db, { displayName: 'Ana Teste', primaryEmail: `a+${Math.random().toString(36).slice(2)}@example.test`, timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
const status = async (id: string) => (await db.query<{ status: string }>('SELECT status FROM skill_executions WHERE id = $1', [id])).rows[0]!.status;
const childOf = async (id: string) => (await db.query<{ id: string }>('SELECT id FROM skill_executions WHERE parent_id = $1', [id])).rows[0]!.id;
const actionsOf = async (runId: string) => (await db.query<{ id: string; state: string }>('SELECT id, state FROM actions WHERE skill_execution_id = $1 ORDER BY created_at', [runId])).rows;
const tasksOf = async (pid: string) => Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM tasks WHERE principal_id = $1', [pid])).rows[0]!.n);
const cancelEvents = async (runId: string) => (await db.query<{ data: { by: string } }>(`SELECT data FROM skill_execution_events WHERE execution_id = $1 AND type = 'skill.cancelled'`, [runId])).rows;

describe('cancelling a run tree', () => {
  it('parent with a pending (queued, never started) child: both cancelled; the child never runs or proposes anything', async () => {
    const who = await principal();
    const { runtime } = setup();
    const parent = await runtime.start(who, 'tree-task-parent', {}, { kind: 'test' });
    const child = await runtime.start(who, 'tree-task-child', {}, { kind: 'parent', key: 'child' }, (await runtime.get(parent))!);
    expect([await status(parent), await status(child)]).toEqual(['queued', 'queued']);

    expect(await cancelExecution(db, who, parent, 'stop', clock.now())).toMatchObject({ status: 'cancelled', runs: expect.arrayContaining([parent, child]) });
    await runtime.runReady();
    expect([await status(parent), await status(child)]).toEqual(['cancelled', 'cancelled']);
    expect(await actionsOf(child)).toEqual([]);
    expect(await tasksOf(who)).toBe(0);
  });

  it('parent waiting on a child that awaits approval: the tree and the child\'s action are cancelled; a late approval is refused and nothing executes', async () => {
    const who = await principal();
    const { runtime } = setup();
    const parent = await runtime.start(who, 'tree-task-parent', {}, { kind: 'test' });
    await runtime.advance(parent);
    const child = await childOf(parent);
    expect([await status(parent), await status(child)]).toEqual(['waiting_child', 'waiting_permission']);
    const [pending] = await actionsOf(child);
    expect(pending!.state).toBe('AWAITING_APPROVAL');

    expect(await cancelExecution(db, who, parent, 'stop', clock.now())).toEqual({ status: 'cancelled', runs: expect.arrayContaining([parent, child]), cancelledActions: [pending!.id] });
    await expect(new ActionService(db).approve(who, pending!.id, clock.now())).rejects.toBeInstanceOf(IllegalTransitionError);
    await runtime.runReady();
    expect([await status(parent), await status(child)]).toEqual(['cancelled', 'cancelled']);
    expect((await actionsOf(child)).map((a) => a.state)).toEqual(['CANCELLED']);
    expect(await tasksOf(who)).toBe(0); // the effect never ran
    // Audit: one cancel event per run, by the principal; the action's last transition is the principal's.
    expect((await cancelEvents(parent)).map((e) => e.data.by)).toEqual(['principal']);
    expect((await cancelEvents(child)).map((e) => e.data.by)).toEqual(['principal']);
    const last = (await db.query<{ to_state: string; actor: string }>(`SELECT to_state, actor FROM action_transitions WHERE action_id = $1 ORDER BY at DESC, to_state LIMIT 1`, [pending!.id])).rows[0];
    expect(last).toEqual({ to_state: 'CANCELLED', actor: 'PRINCIPAL' });
  });

  it('a child that already completed keeps its truthful status; the parent\'s own pending action is cancelled', async () => {
    const who = await principal();
    const { runtime } = setup();
    const parent = await runtime.start(who, 'tree-mixed-parent', {}, { kind: 'test' });
    await runtime.advance(parent);
    const child = await childOf(parent);
    expect([await status(parent), await status(child)]).toEqual(['waiting_permission', 'completed']);
    const r = await cancelExecution(db, who, parent, 'stop', clock.now());
    expect(r).toMatchObject({ status: 'cancelled', runs: [parent] }); // the completed child is not touched
    expect([await status(parent), await status(child)]).toEqual(['cancelled', 'completed']);
    expect((await actionsOf(parent)).map((a) => a.state)).toEqual(['CANCELLED']);
    expect(await cancelEvents(child)).toEqual([]);
  });

  it('a child whose call is already executing: the parent\'s cancel is refused; nothing is presented as cancelled', async () => {
    const who = await principal();
    const { runtime, store } = setup();
    const parent = await runtime.start(who, 'tree-call-parent', {}, { kind: 'test' });
    await runtime.advance(parent);
    const child = await childOf(parent);
    const [call] = await actionsOf(child);
    await new ActionService(db).approve(who, call!.id, clock.now());
    await runtime.runReady(); // the call is placed and still going ("long")
    const before = { parent: await status(parent), child: await status(child), call: (await actionsOf(child))[0]!.state };
    expect(['EXECUTING', 'EXECUTED']).toContain(before.call);
    expect(store.byKey(call!.id)).not.toBeNull();

    const r = await cancelExecution(db, who, parent, 'stop', clock.now());
    expect(r).toMatchObject({ status: 'not_cancellable', actionId: call!.id });
    expect({ parent: await status(parent), child: await status(child), call: (await actionsOf(child))[0]!.state }).toEqual(before);
    expect(await cancelEvents(parent)).toEqual([]);
    expect(await cancelEvents(child)).toEqual([]);
  });

  it('repeated and concurrent cancels of the parent are idempotent; another principal cannot cancel it', async () => {
    const who = await principal();
    const other = await principal();
    const { runtime } = setup();
    const parent = await runtime.start(who, 'tree-task-parent', {}, { kind: 'test' });
    await runtime.advance(parent);
    const child = await childOf(parent);
    expect(await cancelExecution(db, other, parent, 'x', clock.now())).toEqual({ status: 'not_found' });
    expect(await cancelExecution(db, other, child, 'x', clock.now())).toEqual({ status: 'not_found' });

    const rs = await Promise.all([cancelExecution(db, who, parent, 'a', clock.now()), cancelExecution(db, who, parent, 'b', clock.now())]);
    expect(rs.map((r) => r.status).sort()).toEqual(['already_finished', 'cancelled']);
    expect(await cancelExecution(db, who, parent, 'again', clock.now())).toEqual({ status: 'already_finished', state: 'cancelled' });
    expect((await cancelEvents(parent)).length).toBe(1);
    expect((await cancelEvents(child)).length).toBe(1);
  });

  it('a failure partway through the transaction rolls everything back: no half-cancelled tree', async () => {
    const who = await principal();
    const { runtime } = setup();
    const parent = await runtime.start(who, 'tree-task-parent', {}, { kind: 'test' });
    await runtime.advance(parent);
    const child = await childOf(parent);
    const [pending] = await actionsOf(child);
    // Test-schema-only trigger: the CHILD's cancellation fails after the action and parent were already updated in the same transaction.
    await db.query(`CREATE FUNCTION fail_child_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'cancelled' AND NEW.id = '${child}' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER fail_child_cancel BEFORE UPDATE ON skill_executions FOR EACH ROW EXECUTE FUNCTION fail_child_cancel()`);
    try {
      await expect(cancelExecution(db, who, parent, 'stop', clock.now())).rejects.toThrow(/injected failure/);
      expect([await status(parent), await status(child), (await actionsOf(child))[0]!.state]).toEqual(['waiting_child', 'waiting_permission', 'AWAITING_APPROVAL']);
      expect(await cancelEvents(parent)).toEqual([]);
    } finally {
      await db.query('DROP TRIGGER fail_child_cancel ON skill_executions');
      await db.query('DROP FUNCTION fail_child_cancel()');
    }
    // Recoverable: once the failure is gone, the same cancel completes.
    expect(await cancelExecution(db, who, parent, 'stop', clock.now())).toMatchObject({ status: 'cancelled', cancelledActions: [pending!.id] });
  });
});
