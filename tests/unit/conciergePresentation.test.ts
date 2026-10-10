/**
 * Phase 6 — the concierge interface's presentation model (web/lib/concierge.ts) fed with REAL
 * ExecutionViews: the real runtime runs voice-concierge against MockVoiceProvider, and the view is
 * read after every step while simulated time passes. Checks the UI's state semantics: approval is
 * never shown as running, call states follow the call, terminal states never revert, facts and
 * costs come from the backend only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionService, PolicyService } from '../../src/actions/actions.js';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import { createSkillRuntime } from '../../src/skills/index.js';
import { executionView } from '../../src/skills/view.js';
import { Toolbox } from '../../src/tools/index.js';
import { fixedClock } from '../../src/util/clock.js';
import { voiceConfig } from '../../src/voice/config.js';
import { MemoryMockStore, MockVoiceProvider, type MockScenario } from '../../src/voice/mock.js';
import { VoicePolicy } from '../../src/voice/policy.js';
import type { VoiceMandate } from '../../src/voice/types.js';
import { deskPresence, IN_CALL, money, phone, TERMINAL, toTaskPresentation, type TaskPresentation, type TaskState } from '../../web/lib/concierge.js';
import type { ExecutionView as WebView } from '../../web/lib/wendy.js';
import { createTestDb } from '../helpers/db.js';
import { ScriptedReasoner } from '../helpers/scriptedReasoner.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
const clock = fixedClock('2026-10-08T21:00:00Z');
const base = voiceConfig({});

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => t.drop());
beforeEach(() => clock.set('2026-10-08T21:00:00Z'));

const mandate = (o: Partial<VoiceMandate> = {}): VoiceMandate => ({
  objective: 'Reservar uma mesa',
  language: 'pt-BR',
  target: { name: 'Restaurante Aurora', phone: '+552130001000', phoneSource: { kind: 'web_page', ref: 'https://www.restauranteaurora.com.br/contato', title: 'Restaurante Aurora — Contato', sourceType: 'official_site', confidence: 'high' } },
  parameters: { date: '2026-10-08', time: '20:00', party_size: 2 },
  authorizedActions: ['ask', 'request_booking'],
  forbiddenActions: [],
  disclosures: [{ category: 'principal_name', value: 'Ana Teste' }],
  limits: base.limits,
  ...o,
});

function setup(scenario: MockScenario, costs: Partial<typeof base.costs> = {}) {
  const policy = new VoicePolicy({ ...base, costs: { ...base.costs, ...costs } });
  const provider = new MockVoiceProvider({ store: new MemoryMockStore(), now: () => clock.now(), scenario: () => scenario });
  const ctx = createContext({ db, reasoner: new ScriptedReasoner(db, {}), clock, emailProvider: new DevMailboxProvider(db) });
  const toolbox = new Toolbox({ search: () => ({ name: 'none', search: async () => [] }), documentsRoot: '/nonexistent', voice: { provider: async () => provider, policy, clock } });
  return createSkillRuntime(ctx, { toolbox, sleep: async () => {} });
}
const newPrincipal = () => createPrincipal(db, { displayName: 'Ana Teste', primaryEmail: `a+${Math.random().toString(36).slice(2)}@example.test`, timezone: 'America/Sao_Paulo', locale: 'pt-BR' });

/** Runs one call and returns the presentation after every observable moment. */
async function story(scenario: MockScenario, opts: { approve?: boolean; m?: VoiceMandate } = {}) {
  const who = await newPrincipal();
  const { runtime, registry } = setup(scenario);
  const id = await runtime.start(who, 'voice-concierge', opts.m ?? mandate(), { kind: 'test' });
  const seen: TaskPresentation[] = [];
  const look = async () => {
    const v = (await executionView(db, registry, who, id)) as unknown as WebView;
    const p = toTaskPresentation(v, clock.now());
    seen.push(p);
    return p;
  };
  await look(); // queued
  await runtime.advance(id);
  const awaiting = await look();
  const actionId = (await runtime.get(id))!.wait!.id;
  if (opts.approve === false) await new ActionService(db).reject(who, actionId, 'Agora não', clock.now());
  else await new ActionService(db).approve(who, actionId, clock.now());
  await look(); // approved, not yet dialed
  for (let i = 0; i < 40 && !seen.at(-1)!.terminal; i++) {
    await runtime.runReady();
    await look();
    clock.set(new Date(clock.now().getTime() + 2_000));
  }
  await look(); // re-read after the end: must not change
  return { seen, awaiting, states: seen.map((s) => s.state) };
}

const RANK: Record<TaskState, number> = { PLANNING: 0, AWAITING_APPROVAL: 1, WAITING: 2, DIALING: 3, CONNECTED: 4, ACTIVE: 5, ACTION_REQUIRED: 5, ENDING: 6, NEEDS_INFO: 7, BLOCKED: 7, COMPLETED: 7, PARTIAL_SUCCESS: 7, NEEDS_YOU: 7, FAILED: 7, CANCELLED: 7 };
const dedupe = (xs: string[]) => xs.filter((x, i) => x !== xs[i - 1]);

describe('state rendering from real runtime views', () => {
  it('approval → dialing → connected → active → ending → completed, in order, never back', async () => {
    const { seen, awaiting, states } = await story('success');
    // ENDING (call over, being classified) is transient: it may resolve in the same runtime step.
    expect(dedupe(states).filter((s) => s !== 'ENDING')).toEqual(['PLANNING', 'AWAITING_APPROVAL', 'WAITING', 'DIALING', 'CONNECTED', 'ACTIVE', 'COMPLETED']);
    for (let i = 1; i < seen.length; i++) expect(RANK[seen[i]!.state]).toBeGreaterThanOrEqual(RANK[seen[i - 1]!.state]);
    const firstTerminal = states.findIndex((s) => TERMINAL.includes(s as TaskState));
    expect(states.slice(firstTerminal).every((s) => s === 'COMPLETED')).toBe(true); // no stale / reverted state

    // "Cancelar" is offered only while nothing was approved; never during or after the call.
    for (const p of seen) expect({ state: p.state, cancellable: p.cancellable }).toEqual({ state: p.state, cancellable: p.state === 'PLANNING' || p.state === 'AWAITING_APPROVAL' });

    // Awaiting approval is not running: no call, no live state, the card has what the principal needs.
    expect(awaiting).toMatchObject({ state: 'AWAITING_APPROVAL', inCall: false, call: null, presence: 'awaiting', line: 'Posso cuidar disso. Posso ligar para eles?' });
    expect(awaiting.approval).toEqual({
      actionId: expect.any(String),
      target: 'Restaurante Aurora',
      phone: '+55 21 3000-1000',
      source: 'Restaurante Aurora — Contato · confiança alta',
      terms: expect.arrayContaining(['Posso: perguntar, pedir a reserva.', 'Não aceito outro horário ou data sem falar com você.']),
      maxMinutes: 5,
      cost: money({ amount: 0.5, currency: 'USD' }),
      simulated: true,
      authorizedByRequest: false, // a full mandate, no words from the principal: the card is required
    });
    expect(awaiting.subtitle).toBe('Restaurante Aurora · hoje · 20:00 · 2 pessoas');

    const done = seen.at(-1)!;
    expect(done.result).toMatchObject({ tone: 'success', headline: 'Está confirmado.', simulated: true, channel: 'por telefone', cost: money({ amount: 0.1, currency: 'USD' }) });
    expect(done.result!.facts).toEqual([
      { label: 'Dia', value: 'hoje' },
      { label: 'Horário', value: '20:00' },
      { label: 'Pessoas', value: '2' },
    ]);
    expect(done.timeline.every((s) => s.status === 'done')).toBe(true);
    expect(done.presence).toBe('done');
  });

  it('live call: elapsed time and transcript come from the call events', async () => {
    const { seen } = await story('success');
    const active = seen.find((s) => s.state === 'ACTIVE')!;
    expect(active.inCall).toBe(true);
    expect(active.call!.connectedAt).not.toBeNull();
    expect(active.call!.transcript[0]).toEqual({ speaker: 'Wendy', text: expect.stringContaining('assistente de inteligência artificial') });
    expect(seen.find((s) => s.state === 'DIALING')!.line).toBe('Ligando…');
    expect(seen.find((s) => s.state === 'CONNECTED')!.line).toBe('Atenderam. Estou falando com eles.');
  });

  it('action required during the call, then "needs you" (a charge is never accepted)', async () => {
    const { seen, states } = await story('confirmation');
    expect(states).toContain('ACTION_REQUIRED');
    const end = seen.at(-1)!;
    expect(end).toMatchObject({ state: 'NEEDS_YOU', presence: 'attention' });
    expect(end.result).toMatchObject({ tone: 'needs_you', next: 'Ainda não aceito cobranças por você; nada foi pago.' });
    expect(end.result!.facts).toEqual([{ label: 'Cobrança pedida', value: 'BRL 500' }]);
  });

  it('partial success shows the offered alternative, never as accepted', async () => {
    const end = (await story('counterproposal')).seen.at(-1)!;
    expect(end.state).toBe('PARTIAL_SUCCESS');
    expect(end.result!.facts).toEqual([{ label: 'Alternativa oferecida', value: '21:30' }]);
  });

  it('failures keep confidence and only offer what the runtime supports', async () => {
    const noAnswer = (await story('no_answer')).seen.at(-1)!;
    expect(noAnswer).toMatchObject({ state: 'FAILED', presence: 'error', line: 'Não consegui concluir esta.' });
    expect(noAnswer.result).toMatchObject({ whatHappened: 'Ninguém atendeu.', next: 'Não tentei de novo sozinha. Posso ligar mais tarde — é só pedir.' });
    const injection = (await story('injection')).seen.at(-1)!;
    expect(injection.state).toBe('FAILED');
    expect(injection.result!.whatHappened).toMatch(/^Encerrei a ligação: pediram uma informação que eu nunca forneço/);
  });

  it('refused at the card → cancelled; nothing dialed', async () => {
    const { seen, states } = await story('success', { approve: false });
    expect(dedupe(states)).toEqual(['PLANNING', 'AWAITING_APPROVAL', 'CANCELLED']);
    expect(seen.at(-1)).toMatchObject({ call: null, result: { tone: 'neutral', headline: 'Não liguei.' } });
  });
});

describe('policy rendering', () => {
  it('blocked by the principal\'s permission', async () => {
    const who = await newPrincipal();
    await new PolicyService(db).set(who, 'voice.call', 'DENY', clock.now());
    const { runtime, registry } = setup('success');
    const id = await runtime.start(who, 'voice-concierge', mandate(), { kind: 'test' });
    await runtime.advance(id);
    const p = toTaskPresentation((await executionView(db, registry, who, id)) as unknown as WebView, clock.now());
    expect(p).toMatchObject({ state: 'BLOCKED', approval: null, call: null, blocked: { title: 'Ligações estão bloqueadas', usage: null } });
  });

  it('daily budget exceeded: shows today\'s usage against the limit (backend numbers)', async () => {
    const who = await newPrincipal();
    const { runtime, registry } = setup('success', { maxPerDay: 0.55 });
    const first = await runtime.start(who, 'voice-concierge', mandate(), { kind: 'test' });
    await runtime.advance(first);
    await new ActionService(db).approve(who, (await runtime.get(first))!.wait!.id, clock.now());
    await runtime.runReady();
    clock.set(new Date(clock.now().getTime() + 10 * 60_000));
    await runtime.runReady();
    const second = await runtime.start(who, 'voice-concierge', mandate({ parameters: { date: '2026-10-08', time: '21:00', party_size: 2 } }), { kind: 'test' });
    await runtime.advance(second);
    const p = toTaskPresentation((await executionView(db, registry, who, second)) as unknown as WebView, clock.now());
    expect(p.state).toBe('BLOCKED');
    expect(p.blocked).toEqual({
      title: 'Passaria do seu orçamento de hoje',
      body: `Mais uma ligação pode custar até ${money({ amount: 0.5, currency: 'USD' })}.`,
      usage: { label: 'Uso estimado hoje', value: `${money({ amount: 0.1, currency: 'USD' })} / ${money({ amount: 0.55, currency: 'USD' })}`, ratio: 0.1 / 0.55 },
    });
  });
});

describe('helpers', () => {
  it('formats phones and money in pt-BR', () => {
    expect([phone('+552130001000'), phone('+5521998765432'), phone('+14155550100')]).toEqual(['+55 21 3000-1000', '+55 21 99876-5432', '+14155550100']);
    expect(money({ amount: 0.3, currency: 'USD' })).toBe('US$ 0,30');
  });
  it('the desk presence follows the live task, then the agent, then the composer', () => {
    const live = { terminal: false, presence: 'calling' } as TaskPresentation;
    const done = { terminal: true, presence: 'done' } as TaskPresentation;
    expect(deskPresence([done, live], false, false)).toBe('calling');
    expect(deskPresence([done], true, false)).toBe('thinking');
    expect(deskPresence([done], false, true)).toBe('listening');
    expect(deskPresence([], false, false)).toBe('idle');
    expect(IN_CALL).not.toContain('AWAITING_APPROVAL');
  });
});
