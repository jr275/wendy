/**
 * Voice Concierge Phase 5 — authorization: voice permissions (the principal's standing policy),
 * confirmation policy, action policy, cost limits. Through the real runtime where it matters; the
 * provider is MockVoiceProvider. Nothing dials, nothing is charged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionService, PolicyService } from '../../src/actions/actions.js';
import { saveMessages } from '../../src/agent/chatLog.js';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import type { VoiceConciergeOutput } from '../../src/skills/builtin/voiceConcierge.js';
import { builtinRegistry, createSkillRuntime } from '../../src/skills/index.js';
import type { SkillDefinition } from '../../src/skills/types.js';
import { Toolbox } from '../../src/tools/index.js';
import type { VoiceBudget } from '../../src/tools/voice.js';
import { fixedClock } from '../../src/util/clock.js';
import { voiceConfig, type VoiceConfig } from '../../src/voice/config.js';
import { MemoryMockStore, MockVoiceProvider } from '../../src/voice/mock.js';
import { BINDING, FINANCIAL, VoicePolicy } from '../../src/voice/policy.js';
import { VOICE_ACTIONS, type VoiceMandate } from '../../src/voice/types.js';
import { createTestDb } from '../helpers/db.js';
import { ScriptedReasoner } from '../helpers/scriptedReasoner.js';
import { z } from 'zod';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
const clock = fixedClock('2026-10-08T15:00:00Z');
const base = voiceConfig({});
const policyWith = (o: Partial<VoiceConfig['costs']> = {}, extra: Partial<VoiceConfig> = {}) => new VoicePolicy({ ...base, ...extra, costs: { ...base.costs, ...o } });

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => t.drop());
beforeEach(() => clock.set('2026-10-08T15:00:00Z'));

const mandate = (o: Partial<VoiceMandate> = {}): VoiceMandate => ({
  objective: 'Reservar uma mesa',
  language: 'pt-BR',
  target: { name: 'Estabelecimento de teste', phone: '+5521999990000', phoneSource: { kind: 'principal' } },
  parameters: { date: '2026-10-09', time: '20:00', party_size: 2 },
  authorizedActions: ['ask', 'request_booking'],
  forbiddenActions: [],
  disclosures: [],
  limits: base.limits,
  ...o,
});

describe('cost limits (policy)', () => {
  const p = policyWith();
  it('a call is costed per started minute after it is answered; unanswered calls cost nothing', () => {
    expect([p.callCost(null), p.callCost(0), p.callCost(1), p.callCost(60), p.callCost(61)].map((c) => [c.amount, c.billedMinutes])).toEqual([
      [0, 0],
      [0, 0],
      [0.1, 1],
      [0.1, 1],
      [0.2, 2],
    ]);
    expect(p.callCost(30)).toMatchObject({ currency: 'USD', estimated: true });
  });
  it('the worst case is the maximum duration', () => expect(p.worstCaseCost({ ...base.limits, maxCallDurationSeconds: 300 })).toEqual({ amount: 0.5, currency: 'USD' }));
  it('refuses a call that could pass the per-call, daily or monthly budget', () => {
    const L = base.limits;
    expect(p.checkCostLimits({ spentToday: 0, spentMonth: 0 }, L).ok).toBe(true);
    expect(policyWith({ maxPerCall: 0.3 }).checkCostLimits({ spentToday: 0, spentMonth: 0 }, L)).toMatchObject({ ok: false, kind: 'per_call' });
    expect(p.checkCostLimits({ spentToday: 2.6, spentMonth: 2.6 }, L)).toMatchObject({ ok: false, kind: 'day' });
    expect(p.checkCostLimits({ spentToday: 0, spentMonth: 29.6 }, L)).toMatchObject({ ok: false, kind: 'month' });
    expect(p.checkCostLimits({ spentToday: 2.5, spentMonth: 2.5 }, L).ok).toBe(true); // exactly at the limit is allowed
  });
});

describe('confirmation policy', () => {
  const clear = { authorizationQuote: 'Liga para o X', messageId: 'm1', sensitiveRequested: [], phoneSource: { kind: 'principal' as const } };
  it('the principal\'s own words skip the second question only when nothing else needs them', () => {
    const p = policyWith();
    expect(p.confirmationReasons(clear)).toEqual([]);
    expect(p.confirmationReasons({ ...clear, authorizationQuote: null })).toEqual(['no explicit authorization in the request']);
    expect(p.confirmationReasons({ ...clear, sensitiveRequested: ['pay'] })).toEqual(['sensitive request stays with the principal: pay']);
    expect(p.confirmationReasons({ ...clear, phoneSource: { kind: 'web_page', ref: 'https://x', confidence: 'medium' } })).toEqual(['phone found on the web with medium confidence']);
    expect(p.confirmationReasons({ ...clear, phoneSource: { kind: 'web_page', ref: 'https://x', confidence: 'high' } })).toEqual([]);
  });
  it('VOICE_PREAUTHORIZE_FROM_REQUEST=false: every call is confirmed', () => {
    expect(voiceConfig({ VOICE_PREAUTHORIZE_FROM_REQUEST: 'false' }).preauthorizeFromRequest).toBe(false);
    expect(policyWith({}, { preauthorizeFromRequest: false }).confirmationReasons(clear)).toEqual(['configured to always confirm calls']);
  });
});

describe('action policy matrix', () => {
  it('every voice action, for a booking mandate', () => {
    const p = policyWith();
    const m = mandate({ forbiddenActions: ['inform'] });
    const decided = Object.fromEntries(VOICE_ACTIONS.map((a) => [a, p.evaluateAction(a, m)]));
    for (const a of [...FINANCIAL, ...BINDING]) expect(decided[a]).toBe('requires_confirmation');
    expect(decided).toMatchObject({ ask: 'allowed', request_booking: 'allowed', inform: 'forbidden', accept_alternative: 'requires_confirmation', join_waitlist: 'requires_confirmation', negotiate: 'requires_confirmation' });
  });
  it('money and contracts can never be pre-authorized, even if a mandate lists them', () => {
    const v = policyWith().validateMandate(mandate({ authorizedActions: ['ask', 'pay', 'sign_contract'] }));
    expect(v).toMatchObject({ ok: false, errors: ['cannot pre-authorize: pay, sign_contract (always confirmed by the principal)'] });
  });
});

// ── through the runtime ──────────────────────────────────────────────────────────────────

function setup(policy = policyWith(), registry = builtinRegistry()) {
  const store = new MemoryMockStore();
  const provider = new MockVoiceProvider({ store, now: () => clock.now(), scenario: () => 'success' });
  const ctx = createContext({ db, reasoner: new ScriptedReasoner(db, {}), clock, emailProvider: new DevMailboxProvider(db) });
  const toolbox = new Toolbox({ search: () => ({ name: 'none', search: async () => [] }), documentsRoot: '/nonexistent', voice: { provider: async () => provider, policy, clock } });
  const { runtime } = createSkillRuntime(ctx, { registry, toolbox, sleep: async () => {} });
  return { runtime, toolbox, store };
}
const newPrincipal = () => createPrincipal(db, { displayName: 'João Mendes', primaryEmail: `j+${Math.random().toString(36).slice(2)}@example.test`, timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
const out = async (runtime: ReturnType<typeof setup>['runtime'], id: string) => (await runtime.get(id))!.output as VoiceConciergeOutput;

describe('voice permissions (the principal\'s standing policy)', () => {
  it('"never": Wendy stops before searching or proposing, and says why', async () => {
    const who = await newPrincipal();
    await new PolicyService(db).set(who, 'voice.call', 'DENY', clock.now());
    const { runtime } = setup();
    const id = await runtime.start(who, 'voice-concierge', mandate(), { kind: 'test' });
    await runtime.advance(id);
    const o = await out(runtime, id);
    expect(o).toMatchObject({ status: 'not_called', notice: 'Não liguei: nas suas permissões, ligações estão bloqueadas. Se quiser, mude isso em Permissões.', actionId: null });
    expect((await db.query('SELECT 1 FROM actions WHERE skill_execution_id = $1', [id])).rowCount).toBe(0);
  });

  it('"always ask" wins over the principal\'s words in one message: the runtime refuses the pre-approval', async () => {
    const who = await newPrincipal();
    await new PolicyService(db).set(who, 'voice.call', 'REQUIRE_APPROVAL', clock.now());
    const messageId = 'msg-always-ask';
    await saveMessages(db, who, [{ id: messageId, role: 'user', content: 'Liga agora para o Estabelecimento de teste.' }], clock.now());
    // A skill that asks the runtime for pre-approval directly (the voice skill already refrains).
    const probe: SkillDefinition = {
      id: 'probe-call',
      name: 'Probe',
      description: 'test',
      version: '0.0.1',
      triggers: [],
      requiredTools: ['voice.call'],
      composable: false,
      autonomous: false,
      riskLevel: 'HIGH',
      instructions: '',
      inputs: z.object({}),
      outputs: z.unknown(),
      steps: [
        {
          id: 'call',
          label: 'x',
          run: async (ctx) => {
            const r = await ctx.effect('call', 'voice.call', mandate() as unknown as Record<string, unknown>, { principalApproval: { messageId, quote: 'Liga agora' } });
            return r.status === 'pending' && !r.approved ? { kind: 'wait_action', actionId: r.actionId } : { kind: 'done', output: r };
          },
        },
      ],
    };
    const { runtime } = setup(policyWith(), builtinRegistry().register(probe));
    const id = await runtime.start(who, 'probe-call', {}, { kind: 'chat', question: 'x', messageId });
    await runtime.advance(id);
    expect((await runtime.get(id))!.status).toBe('waiting_permission');
    const ev = (await db.query<{ type: string; data: { reason?: string } }>(`SELECT type, data FROM skill_execution_events WHERE execution_id = $1 AND type LIKE 'permission.%' ORDER BY seq`, [id])).rows;
    expect(ev.map((e) => e.type)).toEqual(['permission.requested', 'permission.preapproval_declined']);
    expect(ev[1]!.data.reason).toBe('principal policy: always ask');
  });
});

describe('cost limits through the runtime', () => {
  it('a finished call\'s estimated cost goes to the ledger and shows in voice.budget', async () => {
    const who = await newPrincipal();
    const { runtime, toolbox } = setup();
    const id = await runtime.start(who, 'voice-concierge', mandate(), { kind: 'test' });
    await runtime.advance(id);
    await new ActionService(db).approve(who, (await runtime.get(id))!.wait!.id, clock.now());
    await runtime.runReady();
    clock.set(new Date(clock.now().getTime() + 10 * 60_000));
    await runtime.runReady();
    const o = await out(runtime, id);
    expect(o.cost).toEqual({ amount: 0.1, currency: 'USD', estimated: true, billedMinutes: 1 });
    const ledger = (await db.query<{ payload: { cost: unknown; endedAt: string } }>(`SELECT payload FROM audit_blocks WHERE principal_id = $1 AND event_type = 'VOICE_CALL_ENDED'`, [who])).rows;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.payload.cost).toEqual({ amount: 0.1, currency: 'USD', estimated: true, billedMinutes: 1 });
    const b = (await toolbox.read('voice.budget')!.run({ db, principalId: who, now: clock.now() }, {})) as VoiceBudget;
    expect(b).toMatchObject({ permission: 'default', usage: { callsToday: 1, spentToday: 0.1, spentMonth: 0.1 }, blocked: null, worstCase: { amount: 0.5 } });
  });

  it('two calls approved before either spends: the second is refused at dialing time (defense in depth)', async () => {
    const who = await newPrincipal();
    const { runtime, store } = setup(policyWith({ maxPerDay: 0.55 }));
    const placed: string[] = [];
    const put = store.put.bind(store);
    store.put = (r) => (placed.push(r.key), put(r));
    const a = await runtime.start(who, 'voice-concierge', mandate(), { kind: 'test' });
    const b = await runtime.start(who, 'voice-concierge', mandate({ parameters: { date: '2026-10-09', time: '21:00', party_size: 2 } }), { kind: 'test' });
    await runtime.advance(a);
    await runtime.advance(b);
    const actions = new ActionService(db);
    await actions.approve(who, (await runtime.get(a))!.wait!.id, clock.now());
    await runtime.runReady();
    clock.set(new Date(clock.now().getTime() + 10 * 60_000));
    await runtime.runReady(); // A ends and its cost is spent
    await actions.approve(who, (await runtime.get(b))!.wait!.id, clock.now());
    await runtime.runReady();
    expect(placed).toHaveLength(1);
    const ob = await out(runtime, b);
    expect(ob.status).toBe('not_called');
    expect(ob.result).toMatchObject({ outcome: 'FAILED', summary: 'Não liguei: o limite de gasto com ligações foi atingido antes de a ligação sair.' });
  });
});
