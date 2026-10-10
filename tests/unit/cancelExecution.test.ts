/**
 * Emotional Concierge Phase 1 — cancelling a run from the interface. The real runtime, the real
 * action state machine and the real write route; the line is MockVoiceProvider (nothing dials).
 * What must hold: the runtime run really stops, a waiting approval dies with it (a late approval
 * cannot execute anything), an approved effect is never cancelled, other runs are untouched,
 * finished / unknown / repeated cancels are harmless, and the principal comes from the server.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionService, IllegalTransitionError } from '../../src/actions/actions.js';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import { cancelExecution } from '../../src/skills/cancel.js';
import { saveMessages } from '../../src/agent/chatLog.js';
import { createSkillRuntime } from '../../src/skills/index.js';
import type { MandateDraft } from '../../src/voice/mandate.js';
import { executionView } from '../../src/skills/view.js';
import { Toolbox } from '../../src/tools/index.js';
import { fixedClock } from '../../src/util/clock.js';
import { voiceConfig } from '../../src/voice/config.js';
import { MemoryMockStore, MockVoiceProvider } from '../../src/voice/mock.js';
import { VoicePolicy } from '../../src/voice/policy.js';
import type { VoiceMandate } from '../../src/voice/types.js';
import { performWrite } from '../../inspector/writeApi.js';
import { toTaskPresentation } from '../../web/lib/concierge.js';
import type { ExecutionView as WebView } from '../../web/lib/wendy.js';
import { createTestDb } from '../helpers/db.js';
import { ScriptedReasoner } from '../helpers/scriptedReasoner.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
const clock = fixedClock('2026-10-09T15:00:00Z');
const base = voiceConfig({});

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => t.drop());
beforeEach(() => clock.set('2026-10-09T15:00:00Z'));

const mandate = (time = '20:00'): VoiceMandate => ({
  objective: 'Reservar uma mesa',
  language: 'pt-BR',
  target: { name: 'Restaurante Aurora', phone: '+552130001000', phoneSource: { kind: 'principal' } },
  parameters: { date: '2026-10-09', time, party_size: 2 },
  authorizedActions: ['ask', 'request_booking'],
  forbiddenActions: [],
  disclosures: [],
  limits: base.limits,
});

function setup(hooks?: { afterStepCommitted?: (executionId: string, stepId: string) => void | Promise<void> }, scripts: Record<string, () => unknown> = {}) {
  const store = new MemoryMockStore();
  const placed: string[] = [];
  const put = store.put.bind(store);
  store.put = (r) => (placed.push(r.key), put(r));
  const provider = new MockVoiceProvider({ store, now: () => clock.now(), scenario: () => 'long' });
  const ctx = createContext({ db, reasoner: new ScriptedReasoner(db, scripts), clock, emailProvider: new DevMailboxProvider(db) });
  const toolbox = new Toolbox({ search: () => ({ name: 'none', search: async () => [] }), documentsRoot: '/nonexistent', voice: { provider: async () => provider, policy: new VoicePolicy(base), clock } });
  return { ...createSkillRuntime(ctx, { toolbox, sleep: async () => {}, hooks }), placed };
}
const principal = () => createPrincipal(db, { displayName: 'Ana Teste', primaryEmail: `a+${Math.random().toString(36).slice(2)}@example.test`, timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
const actionState = async (id: string) => (await db.query<{ state: string }>('SELECT state FROM actions WHERE id = $1', [id])).rows[0]!.state;
const runStatus = async (id: string) => (await db.query<{ status: string }>('SELECT status FROM skill_executions WHERE id = $1', [id])).rows[0]!.status;

/** A run parked at the approval card. */
async function awaitingRun(runtime: ReturnType<typeof setup>['runtime'], who: string, time?: string) {
  const id = await runtime.start(who, 'voice-concierge', mandate(time), { kind: 'test' });
  await runtime.advance(id);
  const actionId = (await runtime.get(id))!.wait!.id;
  expect(await actionState(actionId)).toBe('AWAITING_APPROVAL');
  return { id, actionId };
}

describe('cancelling a run', () => {
  it('stops the runtime run and cancels its waiting approval; a late approval cannot execute anything', async () => {
    const who = await principal();
    const { runtime, registry, placed } = setup();
    const { id, actionId } = await awaitingRun(runtime, who);

    expect(await cancelExecution(db, who, id, 'Não preciso mais', clock.now())).toEqual({ status: 'cancelled', runs: [id], cancelledActions: [actionId] });
    expect(await runStatus(id)).toBe('cancelled');
    expect(await actionState(actionId)).toBe('CANCELLED');

    await expect(new ActionService(db).approve(who, actionId, clock.now())).rejects.toBeInstanceOf(IllegalTransitionError);
    await runtime.runReady();
    clock.set(new Date(clock.now().getTime() + 10 * 60_000));
    await runtime.runReady();
    expect(placed).toEqual([]); // nothing dialed
    expect(await runStatus(id)).toBe('cancelled'); // the runtime does not resume it

    const events = (await db.query<{ type: string; data: Record<string, unknown> }>(`SELECT type, data FROM skill_execution_events WHERE execution_id = $1 AND type = 'skill.cancelled'`, [id])).rows;
    expect(events).toEqual([{ type: 'skill.cancelled', data: { reason: 'Não preciso mais', by: 'principal', cancelledActions: [actionId] } }]);
    const transitions = (await db.query<{ to_state: string; actor: string }>(`SELECT to_state, actor FROM action_transitions WHERE action_id = $1 ORDER BY at, to_state`, [actionId])).rows.map((r) => `${r.to_state}:${r.actor}`);
    expect(transitions.at(-1)).toBe('CANCELLED:PRINCIPAL');

    // The interface shows it as cancelled (not running, no approval card).
    const p = toTaskPresentation((await executionView(db, registry, who, id)) as unknown as WebView, clock.now());
    expect(p).toMatchObject({ state: 'CANCELLED', approval: null, terminal: true });
  });

  it('never cancels an approved effect: a call in progress refuses the cancel and keeps going', async () => {
    const who = await principal();
    const { runtime, placed } = setup();
    const { id, actionId } = await awaitingRun(runtime, who);
    await new ActionService(db).approve(who, actionId, clock.now());
    await runtime.runReady(); // the call is placed and still going ("long" scenario)
    expect(placed).toHaveLength(1);
    const before = await actionState(actionId);
    expect(['EXECUTING', 'EXECUTED']).toContain(before);

    const r = await cancelExecution(db, who, id, 'parar', clock.now());
    expect(r).toMatchObject({ status: 'not_cancellable', actionId });
    expect(await actionState(actionId)).toBe(before);
    expect(await runStatus(id)).not.toBe('cancelled');
  });

  it('finished, repeated, unknown and other principals\' runs are harmless no-ops; other runs are untouched', async () => {
    const who = await principal();
    const other = await principal();
    const { runtime } = setup();
    const a = await awaitingRun(runtime, who, '20:00');
    const b = await awaitingRun(runtime, who, '21:00');
    const c = await awaitingRun(runtime, other, '20:00');

    expect(await cancelExecution(db, other, a.id, 'x', clock.now())).toEqual({ status: 'not_found' }); // not theirs
    expect(await cancelExecution(db, who, '00000000-0000-4000-8000-000000000000', 'x', clock.now())).toEqual({ status: 'not_found' });
    expect((await cancelExecution(db, who, a.id, 'x', clock.now())).status).toBe('cancelled');
    expect(await cancelExecution(db, who, a.id, 'x', clock.now())).toEqual({ status: 'already_finished', state: 'cancelled' }); // repeated

    // Only `a` changed.
    expect([await runStatus(b.id), await actionState(b.actionId)]).toEqual(['waiting_permission', 'AWAITING_APPROVAL']);
    expect([await runStatus(c.id), await actionState(c.actionId)]).toEqual(['waiting_permission', 'AWAITING_APPROVAL']);

    // A completed run stays completed.
    await new ActionService(db).reject(who, b.actionId, 'não', clock.now());
    await runtime.runReady();
    expect(await runStatus(b.id)).toBe('completed');
    expect(await cancelExecution(db, who, b.id, 'x', clock.now())).toEqual({ status: 'already_finished', state: 'completed' });
  });

  it('runtime.cancel uses the same rules', async () => {
    const who = await principal();
    const { runtime } = setup();
    const { id, actionId } = await awaitingRun(runtime, who);
    expect(await runtime.cancel(who, id, 'x')).toMatchObject({ status: 'cancelled', cancelledActions: [actionId] });
  });

  it('through the write route: validated body, principal supplied by the server', async () => {
    const who = await principal();
    const { runtime } = setup();
    const { id } = await awaitingRun(runtime, who);
    await expect(performWrite(db, '/api/write/execution/cancel', { executionId: id })).rejects.toThrow(/principalId/); // never from the browser alone
    await expect(performWrite(db, '/api/write/execution/cancel', { principalId: who, executionId: 'not-a-uuid' })).rejects.toThrow(/executionId/);
    expect(await performWrite(db, '/api/write/execution/cancel', { principalId: who, executionId: id, reason: 'Não preciso mais' }, clock.now())).toMatchObject({ status: 'cancelled' });
    expect(await runStatus(id)).toBe('cancelled');
  });

  it('a cancel that lands while a step is executing is not undone by the step finishing (no resurrection, no orphan approval)', async () => {
    const who = await principal();
    let target = '';
    // Cancel exactly between two steps: after "validate" is committed, before "call" proposes the action.
    const { runtime, placed } = setup({
      afterStepCommitted: async (executionId, stepId) => {
        if (executionId === target && stepId === 'validate') expect((await cancelExecution(db, who, executionId, 'mudei de ideia', clock.now())).status).toBe('cancelled');
      },
    });
    target = await runtime.start(who, 'voice-concierge', mandate(), { kind: 'test' });
    await runtime.advance(target);
    await runtime.runReady();
    expect(await runStatus(target)).toBe('cancelled');
    const actions = (await db.query<{ state: string }>('SELECT state FROM actions WHERE skill_execution_id = $1', [target])).rows.map((r) => r.state);
    expect(actions.every((s) => s === 'CANCELLED')).toBe(true); // an action proposed by the in-flight step dies with the run
    expect(placed).toEqual([]);
    const types = (await db.query<{ type: string }>(`SELECT type FROM skill_execution_events WHERE execution_id = $1 AND type IN ('skill.cancelled','skill.completed','skill.failed','skill.waiting_permission') ORDER BY seq`, [target])).rows.map((r) => r.type);
    expect(types).toEqual(['skill.cancelled']); // no contradictory terminal events
  });

  it('race: cancel vs approval of the same action, run concurrently — exactly one wins, never both', async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 12; i++) {
      const who = await principal();
      const { runtime } = setup();
      const { id, actionId } = await awaitingRun(runtime, who);
      const [c, a] = await Promise.allSettled([cancelExecution(db, who, id, 'x', clock.now()), new ActionService(db).approve(who, actionId, clock.now())]);
      const state = await actionState(actionId);
      const cancelled = c.status === 'fulfilled' && c.value.status === 'cancelled';
      const approved = a.status === 'fulfilled';
      expect(cancelled !== approved).toBe(true); // exactly one
      if (cancelled) {
        expect(state).toBe('CANCELLED');
        expect(a.status === 'rejected' && a.reason instanceof IllegalTransitionError).toBe(true);
      } else {
        expect(['APPROVED', 'EXECUTING', 'EXECUTED', 'VERIFIED']).toContain(state);
        expect(c.status === 'fulfilled' && c.value.status).toBe('not_cancellable');
      }
      outcomes.push(cancelled ? 'cancel-won' : 'approve-won');
    }
    process.stderr.write(`race A outcomes: ${JSON.stringify(outcomes.reduce<Record<string, number>>((m, o) => ((m[o] = (m[o] ?? 0) + 1), m), {}))}\n`);
  });

  it('race: two cancels of the same run at once — one cancels, the other sees it finished; one event only', async () => {
    const who = await principal();
    const { runtime } = setup();
    const { id } = await awaitingRun(runtime, who);
    const rs = await Promise.all([cancelExecution(db, who, id, 'a', clock.now()), cancelExecution(db, who, id, 'b', clock.now())]);
    expect(rs.map((r) => r.status).sort()).toEqual(['already_finished', 'cancelled']);
    expect((await db.query(`SELECT 1 FROM skill_execution_events WHERE execution_id = $1 AND type = 'skill.cancelled'`, [id])).rowCount).toBe(1);
  });

  it('a call already authorized in the principal\'s words is not placed if the cancel lands before the call step', async () => {
    const who = await principal();
    const request = 'Liga para o Restaurante Aurora no (21) 3000-1000 e faz uma reserva para 2 pessoas hoje às 20h.';
    const draft: MandateDraft = {
      objective: 'Reservar uma mesa',
      level: 'execute',
      target: { name: 'Restaurante Aurora', name_quote: 'Restaurante Aurora', location_hint: null, phone: '(21) 3000-1000', phone_quote: '(21) 3000-1000' },
      requested_actions: [{ action: 'request_booking', quote: 'faz uma reserva' }],
      parameters: [
        { key: 'date', value: '2026-10-09', quote: 'hoje' },
        { key: 'time', value: '20:00', quote: 'às 20h' },
        { key: 'party_size', value: '2', quote: '2 pessoas' },
      ],
      acceptable_time: null,
      max_extra_cost: null,
      call_authorization_quote: 'Liga para o Restaurante Aurora',
      missing: [],
    };
    let target = '';
    const { runtime, placed } = setup(
      {
        afterStepCommitted: async (executionId, stepId) => {
          if (executionId === target && stepId === 'validate') expect((await cancelExecution(db, who, executionId, 'mudei de ideia', clock.now())).status).toBe('cancelled');
        },
      },
      { 'skill:voice-concierge:mandate': () => draft },
    );
    const messageId = `m-${Math.random().toString(36).slice(2)}`;
    await saveMessages(db, who, [{ id: messageId, role: 'user', content: request }], clock.now());
    target = await runtime.start(who, 'voice-concierge', { request }, { kind: 'chat', question: request, messageId });
    // Control: without the cancel this request is pre-authorized (no card) — checked in voiceMandate.test.ts.
    await runtime.advance(target);
    await runtime.runReady();
    clock.set(new Date(clock.now().getTime() + 10 * 60_000));
    await runtime.runReady();
    // runReady executes every approved action in this shared test database (other tests' too), so
    // the check is scoped to THIS run: none of its actions, and not its mandate's call key, reached the line.
    const mine = (await db.query<{ id: string }>('SELECT id FROM actions WHERE skill_execution_id = $1', [target])).rows.map((r) => r.id);
    const key = ((await runtime.get(target))!.state.mandate as { idempotencyKey?: string } | undefined)?.idempotencyKey;
    expect(key).toMatch(/^voice:/);
    expect(placed.filter((k) => k === key || mine.includes(k))).toEqual([]); // nothing dialed for this run
    expect(await runStatus(target)).toBe('cancelled');
    const states = (await db.query<{ state: string }>('SELECT state FROM actions WHERE skill_execution_id = $1', [target])).rows.map((r) => r.state);
    expect(states.every((x) => x === 'CANCELLED')).toBe(true); // none created, or created and cancelled — never approved
  });
});
