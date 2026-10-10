/**
 * npm run concierge:fixtures
 *
 * Captures REAL ExecutionViews of voice-concierge runs at each moment the interface must render,
 * for the dev-only gallery (web/app/dev/concierge). The real runtime runs against MockVoiceProvider
 * in a throwaway schema of the TEST database (dropped at the end); the model is the labeled test
 * double. Fictional principal and restaurant; nothing personal; nothing dials.
 */
import fs from 'node:fs';
import { ActionService, PolicyService } from '../src/actions/actions.js';
import { saveMessages } from '../src/agent/chatLog.js';
import { ScriptedReasoner } from '../src/cognition/scripted.js';
import { createPrincipal } from '../src/events/world.js';
import { DevMailboxProvider } from '../src/providers/devMailbox.js';
import { createContext } from '../src/runtime/context.js';
import { createSkillRuntime } from '../src/skills/index.js';
import { executionView, type ExecutionView } from '../src/skills/view.js';
import { Toolbox } from '../src/tools/index.js';
import { fixedClock } from '../src/util/clock.js';
import { voiceConfig } from '../src/voice/config.js';
import type { MandateDraft } from '../src/voice/mandate.js';
import { MemoryMockStore, MockVoiceProvider, type MockScenario } from '../src/voice/mock.js';
import { VoicePolicy } from '../src/voice/policy.js';
import type { VoiceMandate } from '../src/voice/types.js';
import { createTestDb } from '../tests/helpers/db.js';

const OUT = 'web/app/dev/concierge/fixtures.json';
const t = await createTestDb();
const db = t.db;
const clock = fixedClock('2026-10-08T21:00:00Z');
const base = voiceConfig({});
const fixtures: { label: string; view: ExecutionView }[] = [];

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

function setup(scenario: MockScenario, opts: { maxPerDay?: number; draft?: MandateDraft } = {}) {
  const policy = new VoicePolicy({ ...base, costs: { ...base.costs, ...(opts.maxPerDay ? { maxPerDay: opts.maxPerDay } : {}) } });
  const provider = new MockVoiceProvider({ store: new MemoryMockStore(), now: () => clock.now(), scenario: () => scenario });
  const reasoner = new ScriptedReasoner(db, opts.draft ? { 'skill:voice-concierge:mandate': () => opts.draft } : {});
  const ctx = createContext({ db, reasoner, clock, emailProvider: new DevMailboxProvider(db) });
  const toolbox = new Toolbox({ search: () => ({ name: 'none', search: async () => [] }), documentsRoot: '/nonexistent', voice: { provider: async () => provider, policy, clock } });
  return createSkillRuntime(ctx, { toolbox, sleep: async () => {} });
}
const principal = () => createPrincipal(db, { displayName: 'Ana Teste', primaryEmail: `a+${Math.random().toString(36).slice(2)}@example.test`, timezone: 'America/Sao_Paulo', locale: 'pt-BR' });

/** Runs a call; keeps the first view seen in each presentation-relevant moment. */
async function story(scenario: MockScenario, labels: Record<string, string>, approve = true) {
  clock.set('2026-10-08T21:00:00Z');
  const who = await principal();
  const { runtime, registry } = setup(scenario);
  const id = await runtime.start(who, 'voice-concierge', mandate(), { kind: 'test' });
  const kept = new Set<string>();
  const keep = async () => {
    const v = (await executionView(db, registry, who, id))!;
    const callState = v.voice?.call?.state ?? null;
    const key = v.status === 'completed' ? 'END' : v.approvals.some((a) => a.state === 'AWAITING_APPROVAL') ? 'AWAITING' : (callState ?? (v.voice?.action ? 'WAITING' : 'PLANNING'));
    if (labels[key] && !kept.has(key)) {
      kept.add(key);
      fixtures.push({ label: labels[key]!, view: v });
    }
  };
  await keep();
  await runtime.advance(id);
  await keep();
  const actionId = (await runtime.get(id))!.wait!.id;
  if (approve) await new ActionService(db).approve(who, actionId, clock.now());
  else await new ActionService(db).reject(who, actionId, 'Agora não', clock.now());
  for (let i = 0; i < 40; i++) {
    await runtime.runReady();
    await keep();
    if ((await runtime.get(id))!.status === 'completed') break;
    clock.set(new Date(clock.now().getTime() + 2_000));
  }
}

await story('success', { PLANNING: 'Planejando', AWAITING: 'Aguardando aprovação', DIALING: 'Ligando', CONNECTED: 'Atenderam', ACTIVE: 'Em conversa', END: 'Concluída' });
await story('confirmation', { ACTION_REQUIRED: 'Precisa de você (durante a ligação)', END: 'Precisa da sua decisão' });
await story('counterproposal', { END: 'Alternativa oferecida' });
await story('no_answer', { END: 'Ninguém atendeu' });
await story('injection', { END: 'Encerrada por segurança' });
await story('success', { END: 'Recusada no cartão' }, false);

// Blocked by the principal's permission.
{
  const who = await principal();
  await new PolicyService(db).set(who, 'voice.call', 'DENY', clock.now());
  const { runtime, registry } = setup('success');
  const id = await runtime.start(who, 'voice-concierge', mandate(), { kind: 'test' });
  await runtime.advance(id);
  fixtures.push({ label: 'Bloqueada pelas permissões', view: (await executionView(db, registry, who, id))! });
}
// Blocked by the daily budget (after a first call that really spent).
{
  clock.set('2026-10-08T21:00:00Z');
  const who = await principal();
  const { runtime, registry } = setup('success', { maxPerDay: 0.55 });
  const first = await runtime.start(who, 'voice-concierge', mandate(), { kind: 'test' });
  await runtime.advance(first);
  await new ActionService(db).approve(who, (await runtime.get(first))!.wait!.id, clock.now());
  await runtime.runReady();
  clock.set(new Date(clock.now().getTime() + 10 * 60_000));
  await runtime.runReady();
  const second = await runtime.start(who, 'voice-concierge', mandate({ parameters: { date: '2026-10-08', time: '21:00', party_size: 2 } }), { kind: 'test' });
  await runtime.advance(second);
  fixtures.push({ label: 'Bloqueada pelo orçamento do dia', view: (await executionView(db, registry, who, second))! });
}
// Needs information (an incomplete request, through the request path).
{
  const who = await principal();
  const request = 'Liga e faz uma reserva';
  const draft: MandateDraft = {
    objective: 'Reservar uma mesa',
    level: 'execute',
    target: { name: null, name_quote: null, location_hint: null, phone: null, phone_quote: null },
    requested_actions: [{ action: 'request_booking', quote: 'faz uma reserva' }],
    parameters: [],
    acceptable_time: null,
    max_extra_cost: null,
    call_authorization_quote: null,
    missing: [],
  };
  const { runtime, registry } = setup('success', { draft });
  const messageId = 'fixture-msg';
  await saveMessages(db, who, [{ id: messageId, role: 'user', content: request }], clock.now());
  const id = await runtime.start(who, 'voice-concierge', { request }, { kind: 'chat', question: request, messageId });
  await runtime.advance(id);
  fixtures.push({ label: 'Faltam informações', view: (await executionView(db, registry, who, id))! });
}

await t.drop();
fs.writeFileSync(OUT, `${JSON.stringify({ note: 'Generated by npm run concierge:fixtures from real runtime runs against the simulated line (MockVoiceProvider, test double model). Fictional data.', fixtures }, null, 1)}\n`);
console.log(`${fixtures.length} fixtures → ${OUT}`);
for (const f of fixtures) console.log(` - ${f.label}`);
