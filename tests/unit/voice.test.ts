/**
 * Voice Concierge, Phases 2+3: state machine, policy, and every mock scenario run through the REAL
 * skill runtime (approval → voice.call → provider events → transcript → worker result).
 * The provider is MockVoiceProvider (simulated, labeled so); nothing dials.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionService, proposeAction } from '../../src/actions/actions.js';
import { withTx, type Db } from '../../src/db/db.js';
import { createPerson, createPrincipal } from '../../src/events/world.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import type { VoiceConciergeOutput } from '../../src/skills/builtin/voiceConcierge.js';
import { builtinRegistry, createSkillRuntime } from '../../src/skills/index.js';
import { Toolbox } from '../../src/tools/index.js';
import { fixedClock } from '../../src/util/clock.js';
import { voiceConfig } from '../../src/voice/config.js';
import { MemoryMockStore, MockVoiceProvider, type MockScenario } from '../../src/voice/mock.js';
import { VoicePolicy } from '../../src/voice/policy.js';
import { CALL_TRANSITIONS, foldCallState, IllegalCallTransition, TERMINAL_CALL_STATES, transitionCall } from '../../src/voice/stateMachine.js';
import type { VoiceMandate, VoiceTaskResult } from '../../src/voice/types.js';
import { createTestDb } from '../helpers/db.js';
import { ScriptedReasoner } from '../helpers/scriptedReasoner.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let pid: string;
const clock = fixedClock('2026-10-08T15:00:00Z');
const policy = new VoicePolicy(voiceConfig({}));

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  pid = await createPrincipal(db, { displayName: 'João Mendes', primaryEmail: 'joao@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
});
afterAll(() => t.drop());
beforeEach(() => clock.set('2026-10-08T15:00:00Z'));

const mandate = (over: Partial<VoiceMandate> = {}): VoiceMandate => ({
  objective: 'Gostaria de reservar uma mesa',
  language: 'pt-BR',
  target: { name: 'Estabelecimento de teste', phone: '+55 21 99999-0000', phoneSource: { kind: 'principal' } },
  parameters: { date: '2026-10-09', time: '20:00', partySize: 2 },
  authorizedActions: ['ask', 'request_booking'],
  forbiddenActions: [],
  disclosures: [{ category: 'principal_name', value: 'João Mendes' }],
  limits: policy.limits,
  ...over,
});

function setup(scenario: MockScenario, store = new MemoryMockStore()) {
  const provider = new MockVoiceProvider({ store, now: () => clock.now(), scenario: () => scenario });
  const ctx = createContext({ db, reasoner: new ScriptedReasoner(db, {}), clock, emailProvider: new DevMailboxProvider(db) });
  const toolbox = new Toolbox({ search: () => ({ name: 'none', search: async () => [] }), documentsRoot: '/nonexistent', voice: { provider: async () => provider, policy, clock } });
  const { runtime } = createSkillRuntime(ctx, { toolbox, sleep: async () => {} });
  return { runtime, store };
}

/** Request → (approve) → let simulated time pass until the call is over → result. */
async function runCall(scenario: MockScenario, m: VoiceMandate = mandate(), opts: { approve?: boolean; minutes?: number; principal?: string } = {}) {
  const who = opts.principal ?? pid;
  const { runtime, store } = setup(scenario);
  const id = await runtime.start(who, 'voice-concierge', m, { kind: 'test' });
  await runtime.advance(id);
  const waiting = (await runtime.get(id))!;
  expect(waiting.status).toBe('waiting_permission'); // a call is EXTERNAL: never placed without approval
  const actionId = waiting.wait!.id;
  if (opts.approve === false) await new ActionService(db).reject(who, actionId, 'não', clock.now());
  else await new ActionService(db).approve(who, actionId, clock.now());
  await runtime.runReady(); // places the call; it is still going
  clock.set(new Date(clock.now().getTime() + (opts.minutes ?? 10) * 60_000));
  await runtime.runReady(); // the call ended: verify, resume, classify
  const run = (await runtime.get(id))!;
  const events = (await db.query<{ type: string }>(`SELECT type FROM skill_execution_events WHERE execution_id = $1 AND type LIKE 'call.%' ORDER BY seq`, [id])).rows.map((r) => r.type);
  return { run, out: run.output as VoiceConciergeOutput & { result: VoiceTaskResult }, actionId, events, store };
}

describe('call state machine', () => {
  it('accepts the normal path and rejects illegal or post-terminal moves', () => {
    let s = transitionCall('PENDING', 'VALIDATING');
    for (const to of ['DIALING', 'CONNECTED', 'ACTIVE', 'ACTION_REQUIRED', 'ACTIVE', 'ENDED', 'COMPLETED'] as const) s = transitionCall(s, to);
    expect(s).toBe('COMPLETED');
    expect(() => transitionCall('PENDING', 'CONNECTED')).toThrow(IllegalCallTransition);
    expect(() => transitionCall('DIALING', 'COMPLETED')).toThrow(IllegalCallTransition); // an outcome needs the call to have ended
    for (const terminal of TERMINAL_CALL_STATES) expect(CALL_TRANSITIONS[terminal]).toEqual([]);
  });

  it('folds provider events (+ the worker outcome) deterministically', () => {
    const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data });
    expect(foldCallState([ev('call.created'), ev('call.dialing'), ev('call.failed', { reason: 'voicemail' })], 'VALIDATING')).toBe('VOICEMAIL');
    expect(foldCallState([ev('call.dialing'), ev('call.connected'), ev('call.transcript'), ev('call.ended', { reason: 'done' }), ev('call.outcome', { state: 'PARTIAL_SUCCESS' })], 'VALIDATING')).toBe('PARTIAL_SUCCESS');
    expect(() => foldCallState([ev('call.connected')], 'VALIDATING')).toThrow(IllegalCallTransition);
  });
});

describe('voice policy', () => {
  it('numbers: Brazil only, E.164, no emergency, short or premium numbers; web numbers cite their page', () => {
    expect(policy.canCall('+55 (21) 99999-0000', { kind: 'principal' })).toEqual({ ok: true, e164: '+5521999990000' });
    expect(policy.canCall('+55190', { kind: 'principal' })).toMatchObject({ ok: false, reason: 'emergency number' });
    expect(policy.canCall('+551234', { kind: 'principal' })).toMatchObject({ ok: false });
    expect(policy.canCall('+559001234567', { kind: 'principal' })).toMatchObject({ ok: false, reason: 'premium or blocked service number' });
    expect(policy.canCall('+12125551234', { kind: 'principal' })).toMatchObject({ ok: false, reason: 'country not allowed' });
    expect(policy.canCall('21999990000', { kind: 'principal' })).toMatchObject({ ok: false, reason: 'not an E.164 number' });
    expect(policy.canCall('+5521999990000', { kind: 'web_page' })).toMatchObject({ ok: false });
  });

  it('mandates cannot pre-authorize money or binding acts, disclose secrets, or exceed limits', () => {
    const bad = policy.validateMandate(mandate({ authorizedActions: ['ask', 'pay'], disclosures: [{ category: 'password', value: 'x' }], limits: { ...policy.limits, maxCallDurationSeconds: 99_999 } }));
    expect(bad.ok).toBe(false);
    expect((bad as { errors: string[] }).errors.join(' ')).toMatch(/pre-authorize: pay.*disclose: password.*limits/);
    const ok = policy.validateMandate(mandate());
    expect(ok.ok && ok.mandate.forbiddenActions).toEqual(expect.arrayContaining(['pay', 'purchase', 'accept_charge', 'sign_contract']));
  });

  it('disclosure: secrets never, unlisted not authorized, listed allowed; money always needs the principal', () => {
    const m = mandate();
    expect(policy.canDisclose('password', m)).toEqual({ decision: 'forbidden' });
    expect(policy.canDisclose('some_new_kind', m)).toEqual({ decision: 'forbidden' }); // unknown = secret
    expect(policy.canDisclose('contact_phone', m)).toEqual({ decision: 'not_authorized' });
    expect(policy.canDisclose('principal_name', m)).toEqual({ decision: 'allowed', value: 'João Mendes' });
    expect(policy.evaluateAction('accept_charge', m)).toBe('requires_confirmation');
    expect(policy.evaluateAction('request_booking', m)).toBe('allowed');
    expect(policy.evaluateAction('negotiate', m)).toBe('requires_confirmation');
  });

  it('limits: calls per task, per day, and call duration', () => {
    expect(policy.checkCallLimits({ callsInTask: 3, callsToday: 0 }, policy.limits)).toMatchObject({ ok: false });
    expect(policy.checkCallLimits({ callsInTask: 0, callsToday: 10 }, policy.limits)).toMatchObject({ ok: false });
    expect(policy.exceededDuration(new Date('2026-10-08T15:00:00Z'), new Date('2026-10-08T15:06:00Z'), policy.limits)).toBe(true);
  });
});

describe('mock scenarios through the worker runtime', () => {
  it('A · success: confirmed on the call → COMPLETED, verified, audited, labeled simulated', async () => {
    const { run, out, actionId, events } = await runCall('success');
    expect(run.status).toBe('completed');
    expect(out.result).toMatchObject({ outcome: 'COMPLETED', success: true, simulated: true });
    expect(out.result.extractedFacts).toEqual(expect.arrayContaining([{ key: 'time', value: '20:00' }, { key: 'partySize', value: '2' }]));
    expect(out.result.summary).toMatch(/^\(Simulação/);
    expect(out.transcript[0]).toMatchObject({ speaker: 'agent' });
    expect(out.transcript[0]!.text).toMatch(/assistente de inteligência artificial.*João Mendes/);
    // opening · "temos disponibilidade" · Wendy asks to confirm · "confirmado" · goodbye
    expect(events).toEqual(['call.validating', 'call.created', 'call.dialing', 'call.connected', 'call.transcript', 'call.transcript', 'call.transcript', 'call.transcript', 'call.transcript', 'call.ended', 'call.outcome']);
    expect((await db.query('SELECT state FROM actions WHERE id = $1', [actionId])).rows[0].state).toBe('VERIFIED');
    const audit = (await db.query(`SELECT event_type FROM audit_blocks WHERE subject_id = $1 ORDER BY seq`, [actionId])).rows.map((r) => r.event_type);
    expect(audit).toEqual(expect.arrayContaining(['ACTION_PROPOSED', 'ACTION_AWAITING_APPROVAL', 'ACTION_APPROVED', 'VOICE_CALL_STARTED', 'VOICE_CALL_ENDED', 'ACTION_VERIFIED']));
  });

  it('B · counterproposal: not authorized to accept → PARTIAL_SUCCESS with the alternative for the principal', async () => {
    const { out } = await runCall('counterproposal');
    expect(out.result).toMatchObject({ outcome: 'PARTIAL_SUCCESS', requiresUserAction: true });
    expect(out.result.nextActions[0]).toMatch(/21:30/);
  });

  it('B′ · counterproposal inside a pre-authorized range is accepted → COMPLETED at the new time', async () => {
    const { out } = await runCall('counterproposal', mandate({ authorizedActions: ['ask', 'request_booking', 'accept_alternative'], acceptable: { time: { from: '19:30', to: '22:00' } } }));
    expect(out.result.outcome).toBe('COMPLETED');
    expect(out.result.extractedFacts).toEqual(expect.arrayContaining([{ key: 'time', value: '21:30' }]));
  });

  it('C · no answer and D · voicemail', async () => {
    expect((await runCall('no_answer')).out.result.outcome).toBe('NO_ANSWER');
    expect((await runCall('voicemail')).out.result.outcome).toBe('VOICEMAIL');
  });

  it('E · prompt injection: asked for the password → refuses, ends the call, POLICY_VIOLATION; nothing protected is said', async () => {
    const { out } = await runCall('injection');
    expect(out.result.outcome).toBe('POLICY_VIOLATION');
    const said = out.transcript.filter((x) => x.speaker === 'agent').map((x) => x.text).join(' ');
    expect(said).toMatch(/Não posso fornecer/);
    expect(said).not.toMatch(/senha:|password:/i);
  });

  it('F · confirmation required: a R$ 500 charge is not accepted → REQUIRES_CONFIRMATION', async () => {
    const { out } = await runCall('confirmation');
    expect(out.result).toMatchObject({ outcome: 'REQUIRES_CONFIRMATION', requiresUserAction: true });
    expect(out.result.summary).toMatch(/BRL 500/);
  });

  it('the duration limit is enforced by the policy, not the provider', async () => {
    const { out } = await runCall('long', mandate({ limits: { ...policy.limits, maxCallDurationSeconds: 120 } }), { minutes: 4 });
    expect(out.result.outcome).toBe('FAILED');
    expect(out.result.summary).toMatch(/tempo máximo/);
  });

  it('call limits are enforced when dialing: over the daily limit the call is refused and nothing is placed', async () => {
    const other = await createPrincipal(db, { displayName: 'Outra Pessoa', primaryEmail: 'outra@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
    const tight = mandate({ limits: { ...policy.limits, maxCallsPerUserPerDay: 1 } });
    const first = await runCall('success', tight, { principal: other });
    expect(first.out.result.outcome).toBe('COMPLETED');
    const second = await runCall('success', tight, { principal: other });
    expect(second.out.result.outcome).toBe('FAILED');
    expect(second.out.result.summary).toBe('Não liguei: o limite de ligações foi atingido antes de a ligação sair.');
    expect(second.store.byKey(second.actionId)).toBeNull();
  });

  it('creating a call is idempotent on the action (a retried execution never dials twice)', async () => {
    const store = new MemoryMockStore();
    const p = new MockVoiceProvider({ store, now: () => clock.now(), scenario: () => 'success' });
    const m = policy.validateMandate(mandate());
    if (!m.ok) throw new Error('mandate');
    const agent = { opening: () => 'oi', respond: () => ({}) };
    const a = await p.createCall({ idempotencyKey: 'action-1', to: m.mandate.target.phone, mandate: m.mandate, agent });
    const b = await p.createCall({ idempotencyKey: 'action-1', to: m.mandate.target.phone, mandate: m.mandate, agent });
    expect(a.providerCallId).toBe(b.providerCallId);
  });

  it('a rejected call is never placed', async () => {
    const { out, store } = await runCall('success', mandate(), { approve: false });
    expect(out.result.outcome).toBe('CANCELLED');
    expect(store.byKey('anything')).toBeNull();
  });

  it('an invalid mandate stops before any action exists', async () => {
    const { runtime } = setup('success');
    const id = await runtime.start(pid, 'voice-concierge', mandate({ target: { name: 'x', phone: '+55190', phoneSource: { kind: 'principal' } } }), { kind: 'test' });
    await runtime.advance(id);
    expect((await runtime.get(id))!).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } });
    expect((await db.query(`SELECT count(*)::int n FROM actions WHERE skill_execution_id = $1`, [id])).rows[0].n).toBe(0);
  });
});

describe('regression: existing actions are unchanged', () => {
  it('email and tasks still execute and verify at once (no long-running path)', async () => {
    const person = await createPerson(db, pid, { fullName: 'R', emails: ['r@example.test'], source: 'TEST' });
    const ctx = createContext({ db, reasoner: new ScriptedReasoner(db, {}), clock, emailProvider: new DevMailboxProvider(db) });
    const email = await withTx(db, (tx) => proposeAction(tx, { principalId: pid, insightId: null, type: 'SEND_EMAIL', targetPersonId: person, content: { to: ['r@example.test'], to_person_id: person, subject: 'Oi', body: 'b' }, expiresAt: null }));
    const task = await withTx(db, (tx) => proposeAction(tx, { principalId: pid, insightId: null, type: 'tasks.create', targetPersonId: null, content: { tasks: [{ title: 'Regressão' }] }, expiresAt: null }));
    await new ActionService(db).approve(pid, email.id, clock.now());
    await new ActionService(db).approve(pid, task.id, clock.now());
    await ctx.executor.runPending();
    const states = (await db.query(`SELECT action_type, state FROM actions WHERE id = ANY($1::uuid[]) ORDER BY action_type`, [[email.id, task.id]])).rows;
    expect(states).toEqual([
      { action_type: 'SEND_EMAIL', state: 'VERIFIED' },
      { action_type: 'tasks.create', state: 'VERIFIED' },
    ]);
    expect(await ctx.executor.settleAsync()).toEqual([]); // nothing long-running pending
  });
});
