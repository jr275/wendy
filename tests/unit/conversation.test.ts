/**
 * Emotional Concierge phase 1 — the custom home conversation (web/lib/conversation.ts) fed by the
 * REAL agent turn: runWendyAgent with the labeled test-double model, the real SkillRuntime, tools
 * and policies, the simulated line. Messages are recorded the way the agent server records them
 * and read back the way `connect` replays them after a reload (chatHistory). The interface must
 * show the same text and cards live and after a reload.
 */
import crypto from 'node:crypto';
import type { BaseEvent, RunAgentInput } from '@ag-ui/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatHistory, messageRecorder, saveMessages, userMessages } from '../../src/agent/chatLog.js';
import { runWendyAgent } from '../../src/agent/run.js';
import type { Db } from '../../src/db/db.js';
import { createEnvironment } from '../../src/eval/agent/environment.js';
import { builtinTasks } from '../../src/eval/agent/registry.js';
import { deterministicReasoner } from '../../src/eval/agent/runner.js';
import { createPrincipal } from '../../src/events/world.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import { builtinRegistry, createSkillRuntime } from '../../src/skills/index.js';
import { Toolbox } from '../../src/tools/index.js';
import { fixedClock } from '../../src/util/clock.js';
import { voiceConfig } from '../../src/voice/config.js';
import { MemoryMockStore, MockVoiceProvider } from '../../src/voice/mock.js';
import { VoicePolicy } from '../../src/voice/policy.js';
import { conversationItems, conversationStatus, textOf, type AgUiMessage } from '../../web/lib/conversation.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => t.drop());

/** One agent turn, recorded exactly as src/agent/server.ts records it. */
async function turn(text: string) {
  const task = builtinTasks().get('V004')!; // number only on a listing → the approval card is shown
  const clock = fixedClock(task.now);
  const env = createEnvironment(task.environment);
  const principalId = await createPrincipal(db, { displayName: 'Ana Teste', primaryEmail: `a+${crypto.randomUUID()}@example.test`, timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
  const provider = new MockVoiceProvider({ store: new MemoryMockStore(), now: () => clock.now(), counterparty: (call) => env.counterparty(call, clock.now()) });
  const toolbox = new Toolbox({ search: () => env.search, hop: env.hop, documentsRoot: '/nonexistent', voice: { provider: async () => provider, policy: new VoicePolicy(voiceConfig({})), clock } });
  const ctx = createContext({ db, reasoner: deterministicReasoner(task, db).client, clock, emailProvider: new DevMailboxProvider(db), toolbox });
  const skills = createSkillRuntime(ctx, { registry: builtinRegistry(), toolbox, sleep: async () => {} });
  const input = { threadId: 'main', runId: crypto.randomUUID(), messages: [{ id: `u-${crypto.randomUUID()}`, role: 'user', content: text }], state: {}, tools: [], context: [], forwardedProps: {} } as unknown as RunAgentInput;
  await saveMessages(db, principalId, userMessages(input), clock.now());
  const rec = messageRecorder();
  const events: string[] = [];
  await runWendyAgent({ ctx, db, principalId, skills }, input, (e: BaseEvent) => {
    events.push(e.type);
    rec.record(e as BaseEvent & Record<string, unknown>);
  });
  await saveMessages(db, principalId, rec.messages, clock.now());
  return { principalId, live: [...(input.messages as unknown as AgUiMessage[]), ...(rec.messages as unknown as AgUiMessage[])], events };
}

describe('the custom conversation, fed by a real agent turn', () => {
  it('delivers Wendy\'s text and her task card; the stream carries steps progressively', async () => {
    const { live, events } = await turn('Liga para o Restaurante Aurora e faz uma reserva para 2 pessoas hoje às 20h.');
    expect(events[0]).toBe('RUN_STARTED');
    expect(events).toContain('STEP_STARTED');
    expect(events.at(-1)).toBe('RUN_FINISHED');
    const items = conversationItems(live);
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'card']);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'Liga para o Restaurante Aurora e faz uma reserva para 2 pessoas hoje às 20h.' });
    expect(items[1]).toMatchObject({ kind: 'assistant', text: expect.stringMatching(/^Entendi assim:\n- Ligar para Restaurante Aurora/) });
    expect(items[2]).toMatchObject({ kind: 'card', name: 'show_execution' });
    const view = JSON.parse((items[2] as { toolCall: { function: { arguments: string } } }).toolCall.function.arguments);
    expect(view).toMatchObject({ skillId: 'voice-concierge', status: 'waiting_permission' });
    expect(view.approvals[0]).toMatchObject({ tool: 'voice.call', state: 'AWAITING_APPROVAL' }); // the approval card stays the backend's
  });

  it('after a reload the same conversation comes back from Wendy\'s database (what connect replays)', async () => {
    const { principalId, live } = await turn('Liga para o Restaurante Aurora e faz uma reserva para 2 pessoas hoje às 20h.');
    const restored = (await chatHistory(db, principalId)) as unknown as AgUiMessage[];
    const strip = (xs: ReturnType<typeof conversationItems>) => xs.map((i) => (i.kind === 'card' ? { kind: i.kind, name: i.name, id: i.id, args: i.toolCall.function.arguments } : i));
    expect(strip(conversationItems(restored))).toEqual(strip(conversationItems(live)));
  });
});

describe('message → item rules', () => {
  const tc = (id: string, name: string) => ({ id, type: 'function' as const, function: { name, arguments: '{}' } });
  it('pairs cards with their results, ignores tool results alone and unknown tools, keeps markdown text intact', () => {
    const msgs: AgUiMessage[] = [
      { id: 'u1', role: 'user', content: 'Oi' },
      { id: 'a1', role: 'assistant', content: '**Pronto.**\n\n- um\n- dois' },
      { id: 'a2', role: 'assistant', toolCalls: [tc('t1', 'show_answer'), tc('t2', 'some_other_tool')] },
      { id: 'r1', role: 'tool', toolCallId: 't1', content: 'rendered' },
      { id: 'r2', role: 'tool', toolCallId: 't2', content: 'x' },
      { id: 'a3', role: 'assistant', content: '   ' },
      { id: 'u2', role: 'user', content: [{ type: 'text', text: 'parte ' }, { type: 'text', text: 'dois' }] },
    ];
    const items = conversationItems(msgs);
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(['user:u1', 'assistant:a1', 'card:t1', 'user:u2']);
    expect(items[1]).toMatchObject({ text: '**Pronto.**\n\n- um\n- dois' }); // markdown goes to the renderer untouched
    expect(items[2]).toMatchObject({ name: 'show_answer', toolMessage: { id: 'r1' } });
    expect(items[3]).toMatchObject({ text: 'parte dois' });
    expect(textOf(undefined)).toBe('');
  });

  it('conversation states: connecting, empty, ready, running, error', () => {
    const s = (o: Partial<Parameters<typeof conversationStatus>[0]>) => conversationStatus({ connected: true, connectFailed: false, running: false, error: null, items: 0, ...o });
    expect(s({ connected: false })).toBe('connecting');
    expect(s({ connected: false, connectFailed: true })).toBe('empty'); // failed history still lets the principal write
    expect(s({})).toBe('empty');
    expect(s({ items: 3 })).toBe('ready');
    expect(s({ items: 3, running: true })).toBe('running');
    expect(s({ items: 3, running: true, error: 'x' })).toBe('error');
  });
});

describe('resending after a failed turn', () => {
  const user = (id: string, text: string) => ({ kind: 'user' as const, id, text });
  const assistant = (id: string, text: string) => ({ kind: 'assistant' as const, id, text });
  it('offers the last message only when Wendy produced nothing after it', async () => {
    const { unansweredUserText } = await import('../../web/lib/conversation.js');
    expect(unansweredUserText([user('u1', 'oi'), assistant('a1', 'olá'), user('u2', 'quais são minhas tarefas?')])).toBe('quais são minhas tarefas?');
    expect(unansweredUserText([user('u1', 'oi'), assistant('a1', 'olá')])).toBeNull(); // she answered: nothing to resend
    expect(unansweredUserText([])).toBeNull();
  });
  it('a card after the message means something was produced (maybe a task started): never offered', async () => {
    const { unansweredUserText } = await import('../../web/lib/conversation.js');
    const card = { kind: 'card' as const, id: 'c1', name: 'show_execution' as const, toolCall: { id: 'c1', type: 'function' as const, function: { name: 'show_execution', arguments: '{}' } }, toolMessage: undefined };
    expect(unansweredUserText([user('u1', 'crie uma tarefa'), card])).toBeNull();
  });
});

describe('what may take the "Em foco" panel', () => {
  it('a card restored from history never does; one that arrives during a live turn does, with a short grace after it ends', async () => {
    const { createLiveGate, LIVE_GRACE_MS } = await import('../../web/lib/focus.js');
    const g = createLiveGate();
    expect(g.accepts(1_000)).toBe(false); // opening Hoje: restored cards must not cover the page
    g.begin();
    expect(g.accepts(5_000)).toBe(true); // a turn started from this page is running
    g.end(10_000);
    expect(g.accepts(10_000 + LIVE_GRACE_MS)).toBe(true); // a card that renders a moment after the turn finished
    expect(g.accepts(10_000 + LIVE_GRACE_MS + 1)).toBe(false); // and then it is closed again
  });
});
