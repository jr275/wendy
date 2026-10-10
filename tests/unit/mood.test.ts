/**
 * Emotional Concierge — mood intelligence and character selection.
 * Server side: the model proposes, CODE decides (quote grounded, closed enums, caps, expiry).
 * Interface side (pure functions in web/lib): strict parsing, stabilized deterministic selection,
 * the user's control, the local registry. And the invariant that matters most: mood never changes
 * what Wendy does — approvals stay exactly as they were.
 */
import crypto from 'node:crypto';
import type { BaseEvent, RunAgentInput } from '@ag-ui/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messageRecorder, saveMessages, userMessages } from '../../src/agent/chatLog.js';
import { runWendyAgent } from '../../src/agent/run.js';
import { ScriptedReasoner } from '../../src/cognition/scripted.js';
import type { Db } from '../../src/db/db.js';
import { createEnvironment } from '../../src/eval/agent/environment.js';
import { builtinTasks } from '../../src/eval/agent/registry.js';
import { createPrincipal } from '../../src/events/world.js';
import { MIN_CONFIDENCE, INFERRED_CAP, MOOD_CATEGORIES as SERVER_CATEGORIES, MOOD_EVIDENCE_SOURCES as SERVER_SOURCES, MOOD_TTL_MS, RESPONSE_TONES as SERVER_TONES, validateMood, type MoodDraft } from '../../src/mood/mood.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import { builtinRegistry, createSkillRuntime } from '../../src/skills/index.js';
import { Toolbox } from '../../src/tools/index.js';
import { fixedClock } from '../../src/util/clock.js';
import { voiceConfig } from '../../src/voice/config.js';
import { MemoryMockStore, MockVoiceProvider } from '../../src/voice/mock.js';
import { VoicePolicy } from '../../src/voice/policy.js';
import { CHARACTER_IDS, CHARACTERS, characterFor, isCharacterId, resolveCharacter } from '../../web/lib/characters.js';
import * as web from '../../web/lib/mood.js';
import { createTestDb } from '../helpers/db.js';

const NOW = new Date('2026-10-10T15:00:00Z');
const req = 'Estou muito ansioso com essa viagem. Liga para o hotel e confirma a reserva.';
const draft = (o: Partial<MoodDraft> = {}): MoodDraft => ({ category: 'concerned', confidence: 0.9, evidence_source: 'explicit_user_statement', evidence_quote: 'Estou muito ansioso com essa viagem', response_tone: 'calm', secondary: null, ...o });

describe('server: the model proposes, code decides', () => {
  it('an explicit statement, quoted from the request, becomes a mood that expires', () => {
    const m = validateMood(draft(), req, NOW)!;
    expect(m).toMatchObject({ category: 'concerned', confidence: 0.9, evidenceSource: 'explicit_user_statement', responseTone: 'calm', updatedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + MOOD_TTL_MS).toISOString() });
  });
  it('explicit frustration and explicit positive energy', () => {
    expect(validateMood(draft({ category: 'frustrated', evidence_quote: 'Estou muito ansioso' }), req, NOW)?.category).toBe('frustrated');
    expect(validateMood(draft({ category: 'positive_energy', evidence_quote: 'confirma a reserva' }), req, NOW)?.category).toBe('positive_energy');
  });
  it('neutral: no draft, no quote, or a quote that is not in the request → no mood', () => {
    expect(validateMood(null, req, NOW)).toBeNull();
    expect(validateMood(undefined, req, NOW)).toBeNull();
    expect(validateMood(draft({ evidence_quote: '' }), req, NOW)).toBeNull();
    expect(validateMood(draft({ evidence_quote: 'estou arrasado' }), req, NOW)).toBeNull(); // invented evidence
  });
  it('an inference from the request alone can never be confident; weak evidence stays neutral', () => {
    const inferred = validateMood(draft({ evidence_source: 'current_conversation', confidence: 0.99 }), req, NOW)!;
    expect(inferred.confidence).toBe(INFERRED_CAP);
    expect(INFERRED_CAP).toBeLessThan(0.75); // below the strong band the interface needs to switch characters at once
    expect(validateMood(draft({ evidence_source: 'current_conversation', confidence: 0.5 }), req, NOW)).toBeNull();
    expect(validateMood(draft({ confidence: MIN_CONFIDENCE - 0.01 }), req, NOW)).toBeNull();
  });
  it('invalid model output is ignored, never partially trusted', () => {
    for (const bad of [{ ...draft(), category: 'furious' }, { ...draft(), confidence: 1.5 }, { ...draft(), evidence_source: 'user_selected' }, { ...draft(), response_tone: 'angry' }, 'happy', 42, {}]) {
      expect(validateMood(bad as unknown as MoodDraft, req, NOW)).toBeNull();
    }
  });
  it('conflicting signals: a secondary reading is kept only when it differs and is itself strong enough', () => {
    expect(validateMood(draft({ secondary: { category: 'frustrated', confidence: 0.9 } }), req, NOW)?.secondary).toEqual({ category: 'frustrated', confidence: INFERRED_CAP });
    expect(validateMood(draft({ secondary: { category: 'concerned', confidence: 0.9 } }), req, NOW)?.secondary).toBeUndefined(); // same as primary
    expect(validateMood(draft({ secondary: { category: 'sad', confidence: 0.4 } }), req, NOW)?.secondary).toBeUndefined(); // weak
  });
  it('the web enums equal the server enums (one vocabulary on both sides)', () => {
    expect([...web.MOOD_CATEGORIES]).toEqual([...SERVER_CATEGORIES]);
    expect([...web.MOOD_EVIDENCE_SOURCES]).toEqual([...SERVER_SOURCES]);
    expect([...web.RESPONSE_TONES]).toEqual([...SERVER_TONES]);
  });
});

// ── interface side ───────────────────────────────────────────────────────────────────────
const reading = (o: Partial<web.MoodPresentation> = {}, at = NOW): web.MoodPresentation => ({
  category: 'concerned',
  confidence: 0.9,
  evidenceSource: 'explicit_user_statement',
  responseTone: 'calm',
  updatedAt: at.toISOString(),
  expiresAt: new Date(at.getTime() + MOOD_TTL_MS).toISOString(),
  ...o,
});
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
const sel = (s: web.SelectorState, prefs: web.MoodPrefs = web.DEFAULT_PREFS, at = NOW) => web.selectPresentation(s, prefs, at);

describe('interface: strict parsing', () => {
  it('only an exactly valid mood is accepted', () => {
    expect(web.parseMood(reading())).not.toBeNull();
    for (const bad of [null, undefined, 'sad', {}, { ...reading(), category: 'rage' }, { ...reading(), confidence: 2 }, { ...reading(), expiresAt: 'nope' }]) expect(web.parseMood(bad)).toBeNull();
    // unknown extra keys (a model trying to smuggle a character id, a path or CSS) are dropped, not used
    const smuggled = web.parseMood({ ...reading(), primaryCharacterId: 'fear', src: 'https://evil.example/x.png', className: 'x' })!;
    expect(smuggled).not.toHaveProperty('primaryCharacterId');
    expect(smuggled).not.toHaveProperty('src');
  });
});

describe('interface: character registry', () => {
  it('resolves ids only through the local registry; unknown ids and paths resolve to nothing', () => {
    expect(resolveCharacter('joy')?.src).toBe('/characters/joy.webp');
    for (const bad of ['../joy', 'https://x/y.png', 'JOY', '', null, undefined, 7, { id: 'joy' }]) expect(resolveCharacter(bad)).toBeNull();
    expect(isCharacterId('fear')).toBe(true);
    for (const id of CHARACTER_IDS) expect(CHARACTERS[id].src).toMatch(/^\/characters\/[a-z]+\.webp$/); // local assets only
  });
  it('categories map to one character each; calm has none yet → neutral halo', () => {
    expect(['positive_energy', 'concerned', 'frustrated', 'sad', 'curious'].map((c) => characterFor(c as web.MoodCategory))).toEqual(['joy', 'anxiety', 'anger', 'sadness', 'envy']);
    expect(characterFor('calm')).toBeNull();
    expect(sel(web.stepSelector(web.INITIAL_SELECTOR, reading({ category: 'calm' }), NOW))).toMatchObject({ primary: null, category: 'neutral' });
  });
});

describe('interface: stabilized, deterministic selection', () => {
  it('no reading → neutral; a strong reading → one character', () => {
    expect(sel(web.INITIAL_SELECTOR)).toEqual({ category: 'neutral', primary: null, secondary: null, basis: 'neutral' });
    expect(sel(web.stepSelector(web.INITIAL_SELECTOR, reading(), NOW))).toEqual({ category: 'concerned', primary: 'anxiety', secondary: null, basis: 'reading' });
  });
  it('low confidence → neutral', () => {
    expect(sel(web.stepSelector(web.INITIAL_SELECTOR, reading({ confidence: 0.55 }), NOW)).primary).toBeNull();
  });
  it('a second character only when compatible: concerned + frustrated yes; joy + sad never', () => {
    const two = web.stepSelector(web.INITIAL_SELECTOR, reading({ secondary: { category: 'frustrated', confidence: 0.65 } }), NOW);
    expect(sel(two)).toMatchObject({ primary: 'anxiety', secondary: 'anger' });
    const clash = web.stepSelector(web.INITIAL_SELECTOR, reading({ category: 'positive_energy', secondary: { category: 'sad', confidence: 0.65 } }), NOW);
    expect(sel(clash)).toMatchObject({ primary: 'joy', secondary: null });
    expect(web.compatible('concerned', 'concerned')).toBe(false);
  });
  it('no flicker: a weak different reading does not replace the shown character; it must repeat, or be strong', () => {
    let s = web.stepSelector(web.INITIAL_SELECTOR, reading(), NOW); // anxiety
    s = web.stepSelector(s, reading({ category: 'frustrated', confidence: 0.65, evidenceSource: 'current_conversation' }, later(1)), later(1));
    expect(sel(s, undefined, later(1)).primary).toBe('anxiety'); // held
    s = web.stepSelector(s, reading({ category: 'frustrated', confidence: 0.65, evidenceSource: 'current_conversation' }, later(2)), later(2));
    expect(sel(s, undefined, later(2)).primary).toBe('anger'); // confirmed twice
    // strong evidence switches at once
    s = web.stepSelector(s, reading({ category: 'sad', confidence: 0.9 }, later(3)), later(3));
    expect(sel(s, undefined, later(3)).primary).toBe('sadness');
    // an interleaved different reading resets the count
    let t = web.stepSelector(web.INITIAL_SELECTOR, reading(), NOW);
    for (const c of ['frustrated', 'sad', 'frustrated'] as const) t = web.stepSelector(t, reading({ category: c, confidence: 0.65 }, later(1)), later(1));
    expect(sel(t, undefined, later(1)).primary).toBe('anxiety');
  });
  it('no new reading keeps what is shown; it expires back to neutral', () => {
    let s = web.stepSelector(web.INITIAL_SELECTOR, reading(), NOW);
    s = web.stepSelector(s, null, later(5));
    expect(sel(s, undefined, later(5)).primary).toBe('anxiety');
    expect(sel(s, undefined, later(11)).primary).toBeNull(); // 10-minute TTL
    expect(web.stepSelector(s, null, later(11)).shown).toBeNull();
  });
  it('an expired reading is ignored on arrival', () => {
    expect(web.stepSelector(web.INITIAL_SELECTOR, reading({}, NOW), later(11)).shown).toBeNull();
  });
  it('the user\'s correction wins over the earlier inference and over readings up to then; a newer reading counts again', () => {
    let s = web.stepSelector(web.INITIAL_SELECTOR, reading(), NOW);
    s = web.correct(later(1));
    expect(sel(s, undefined, later(1)).primary).toBeNull();
    s = web.stepSelector(s, reading({}, NOW), later(2)); // the same old reading arrives again
    expect(sel(s, undefined, later(2)).primary).toBeNull();
    s = web.stepSelector(s, reading({}, later(3)), later(3)); // a newer one
    expect(sel(s, undefined, later(3)).primary).toBe('anxiety');
  });
  it('user preferences take precedence: a chosen category, neutral, or characters off', () => {
    const s = web.stepSelector(web.INITIAL_SELECTOR, reading(), NOW);
    expect(sel(s, { enabled: true, selected: 'positive_energy' })).toMatchObject({ primary: 'joy', basis: 'user_selected' });
    expect(sel(s, { enabled: true, selected: 'neutral' })).toMatchObject({ primary: null, basis: 'user_selected' });
    expect(sel(s, { enabled: false, selected: 'sad' })).toMatchObject({ primary: null, secondary: null, basis: 'disabled' });
    expect(web.parsePrefs({ enabled: 'yes' })).toEqual(web.DEFAULT_PREFS); // bad stored prefs → defaults
    expect(web.parsePrefs({ enabled: false, selected: 'sad' })).toEqual({ enabled: false, selected: 'sad' });
  });
  it('deterministic: the same inputs always give the same selection, and nothing in the policy is random', () => {
    const run = () => sel(web.stepSelector(web.stepSelector(web.INITIAL_SELECTOR, reading(), NOW), reading({ category: 'sad', confidence: 0.65 }, later(1)), later(1)), undefined, later(1));
    expect(Array.from({ length: 20 }, run).every((x) => JSON.stringify(x) === JSON.stringify(run()))).toBe(true);
  });
});

// ── the invariant: mood never changes what Wendy does ──────────────────────────────────────
let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => t.drop());

async function agentTurn(moodDraft: unknown, text = 'Liga para o Restaurante Aurora e faz uma reserva para 2 pessoas hoje às 20h.') {
  const task = builtinTasks().get('V004')!; // number only on a listing → the principal's approval is required
  const clock = fixedClock(task.now);
  const env = createEnvironment(task.environment);
  const principalId = await createPrincipal(db, { displayName: 'Ana Teste', primaryEmail: `a+${crypto.randomUUID()}@example.test`, timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
  const placed: string[] = [];
  const store = new MemoryMockStore();
  const put = store.put.bind(store);
  store.put = (r) => (placed.push(r.key), put(r));
  const provider = new MockVoiceProvider({ store, now: () => clock.now(), counterparty: (call) => env.counterparty(call, clock.now()) });
  const toolbox = new Toolbox({ search: () => env.search, hop: env.hop, documentsRoot: '/nonexistent', voice: { provider: async () => provider, policy: new VoicePolicy(voiceConfig({})), clock } });
  const scripts = {
    intent: (r: { user: string }) => ({ skill: 'voice-concierge', input_json: JSON.stringify({ request: /<request>\n([\s\S]*)\n<\/request>/.exec(r.user)?.[1] ?? '' }), reason: 'test', mood: moodDraft }),
    'skill:voice-concierge:mandate': () => task.modelDouble['skill:voice-concierge:mandate'],
  };
  const ctx = createContext({ db, reasoner: new ScriptedReasoner(db, scripts as never), clock, emailProvider: new DevMailboxProvider(db), toolbox });
  const skills = createSkillRuntime(ctx, { registry: builtinRegistry(), toolbox, sleep: async () => {} });
  const input = { threadId: 'main', runId: crypto.randomUUID(), messages: [{ id: `u-${crypto.randomUUID()}`, role: 'user', content: text }], state: { viewing: { kind: 'today', label: 'Hoje' } }, tools: [], context: [], forwardedProps: {} } as unknown as RunAgentInput;
  await saveMessages(db, principalId, userMessages(input), clock.now());
  const rec = messageRecorder();
  const events: Record<string, unknown>[] = [];
  await runWendyAgent({ ctx, db, principalId, skills }, input, (e: BaseEvent) => {
    events.push(e as unknown as Record<string, unknown>);
    rec.record(e as BaseEvent & Record<string, unknown>);
  });
  await saveMessages(db, principalId, rec.messages, clock.now());
  const actions = (await db.query<{ state: string; action_type: string }>('SELECT state, action_type FROM actions WHERE principal_id = $1', [principalId])).rows;
  const moodTables = (await db.query<{ n: string }>(`SELECT count(*) AS n FROM memories WHERE principal_id = $1`, [principalId])).rows[0]!.n;
  return { events, actions, placed, memories: Number(moodTables), chat: (await db.query<{ content: string | null; tool_calls: unknown }>('SELECT content, tool_calls::text AS tool_calls FROM chat_messages WHERE principal_id = $1', [principalId])).rows };
}

describe('through the real agent turn', () => {
  const happy = draft({ category: 'positive_energy', confidence: 1, evidence_quote: 'faz uma reserva', response_tone: 'warm' });
  it('a validated mood reaches the interface as transient agent state, next to what the page shared', async () => {
    const { events } = await agentTurn(happy);
    const snap = events.find((e) => e.type === 'STATE_SNAPSHOT') as { snapshot: Record<string, unknown> };
    expect(snap.snapshot).toMatchObject({ viewing: { kind: 'today', label: 'Hoje' }, mood: { category: 'positive_energy', confidence: 1, evidenceSource: 'explicit_user_statement' } });
    expect(events.map((e) => e.type).indexOf('STATE_SNAPSHOT')).toBeLessThan(events.map((e) => e.type).indexOf('RUN_FINISHED'));
  });
  it('MOOD DOES NOT BYPASS APPROVAL: a confident happy mood on a call that needs the principal still waits for the principal', async () => {
    const withMood = await agentTurn(happy);
    const withoutMood = await agentTurn(null);
    expect(withMood.actions).toEqual(withoutMood.actions); // identical: the call action awaits approval either way
    expect(withMood.actions).toEqual([{ state: 'AWAITING_APPROVAL', action_type: 'voice.call' }]);
    expect(withMood.placed).toEqual([]);
    expect(withoutMood.placed).toEqual([]);
  });
  it('mood is not stored: no memory is written, and the saved conversation has no mood in it', async () => {
    const r = await agentTurn(happy);
    expect(r.memories).toBe(0);
    expect(JSON.stringify(r.chat)).not.toMatch(/positive_energy|"mood"/);
  });
  it('an invalid or unquoted mood from the model sends nothing to the interface', async () => {
    for (const bad of [{ ...happy, evidence_quote: 'estou radiante' }, { ...happy, category: 'ecstatic' }, null]) {
      const { events } = await agentTurn(bad);
      expect(events.find((e) => e.type === 'STATE_SNAPSHOT')).toBeUndefined();
    }
  });
});
