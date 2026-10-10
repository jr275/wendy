/**
 * Evaluation model: tasks (schema, registry, datasets), environment (isolation, reset, determinism),
 * user simulator, Pass^k / Pass@k math, aggregation, regression tasks. Pure — no database.
 */
import { describe, expect, it } from 'vitest';
import { createEnvironment, VoiceEnvironment } from '../../src/eval/agent/environment.js';
import { anonymize, toRegressionTask } from '../../src/eval/agent/regression.js';
import { builtinTasks, TaskRegistry, TaskRegistryError } from '../../src/eval/agent/registry.js';
import { formatReport } from '../../src/eval/agent/report.js';
import { binomial, passAtK, passHatK, summarize } from '../../src/eval/agent/scoring.js';
import { ScriptedUser } from '../../src/eval/agent/simulator.js';
import { VOICE_TASKS } from '../../fixtures/agentEval/voice.js';
import { EvaluationTaskSchema, FAILURE_CATEGORIES, type TrialResult, type VoiceWorld } from '../../src/eval/agent/types.js';
import { voiceConfig } from '../../src/voice/config.js';
import { MandateAgent } from '../../src/voice/agent.js';
import { VoicePolicy } from '../../src/voice/policy.js';
import type { VoiceMandate } from '../../src/voice/types.js';

const V001 = VOICE_TASKS[0]!;

describe('EvaluationTask', () => {
  it('the 10 voice tasks are valid and form the voice-concierge-v1 dataset', () => {
    const r = builtinTasks();
    expect(r.list({ dataset: 'voice-concierge-v1' }).map((t) => t.id)).toEqual(['V001', 'V002', 'V003', 'V004', 'V005', 'V006', 'V007', 'V008', 'V009', 'V010']);
    expect(r.list({ domain: 'voice' })).toHaveLength(10);
    expect(r.list({ domain: 'email' })).toEqual([]);
    expect(r.get('V003')!.expected.outcome).toBe('PARTIAL_SUCCESS');
    expect(r.get('V001')!.evaluationCriteria).toEqual(['task_success', 'policy_compliance', 'authorization', 'tool_correctness', 'safety', 'outcome_correctness']);
  });

  it('invalid tasks are refused with the reason', () => {
    expect(EvaluationTaskSchema.safeParse({ ...V001, id: 'v1' }).success).toBe(false);
    expect(EvaluationTaskSchema.safeParse({ ...V001, expected: undefined }).success).toBe(false);
    expect(EvaluationTaskSchema.safeParse({ ...V001, environment: { kind: 'airline' } }).success).toBe(false);
    expect(() => new TaskRegistry().register({ ...V001, initialUserMessage: '' })).toThrow(/initialUserMessage/);
  });

  it('the registry refuses duplicates and datasets with unknown tasks', () => {
    const r = new TaskRegistry().register(V001);
    expect(() => r.register(V001)).toThrow(TaskRegistryError);
    expect(() => r.dataset('x', ['V001', 'V999'])).toThrow(/unknown tasks V999/);
    expect(() => r.list({ dataset: 'nope' })).toThrow(/unknown dataset/);
  });
});

describe('Environment', () => {
  const world = (): VoiceWorld => EvaluationTaskSchema.parse(VOICE_TASKS[1]).environment;
  const mandate = { parameters: { time: '20:00', party_size: 2 } } as unknown as VoiceMandate;

  it('each instance is isolated; a new one starts from the same state (reset)', () => {
    const a = new VoiceEnvironment(world());
    const b = new VoiceEnvironment(world());
    const plan = a.counterparty({ to: '+552130001000', mandate }, new Date('2026-10-08T21:00:00Z'));
    expect('script' in plan).toBe(true);
    expect((a.snapshot() as { calls: unknown[] }).calls).toHaveLength(1);
    expect((b.snapshot() as { calls: unknown[] }).calls).toHaveLength(0);
    expect(new VoiceEnvironment(world()).snapshot()).toEqual(b.snapshot());
  });

  it('the spec is copied: mutating the world never changes the task', () => {
    const spec = world();
    const env = new VoiceEnvironment(spec);
    if ('script' in env.counterparty({ to: '+552130001000', mandate }, new Date())) spec.businesses[0]!.availability['23:00'] = true;
    expect(env.snapshot().businesses[0]!.availability['23:00']).toBeUndefined();
  });

  it('search and pages are deterministic; unknown pages are 404', async () => {
    const env = createEnvironment(world());
    const r1 = await env.search.search('p', 'Restaurante Aurora telefone', 5);
    const r2 = await env.search.search('p', 'Restaurante Aurora telefone', 5);
    expect(r1).toEqual(r2);
    expect(r1.map((r) => r.uri)).toContain('https://www.restauranteaurora.com.br/contato');
    expect((await env.hop(new URL('https://nowhere.example.com/'), (() => {}) as never)).status).toBe(404);
  });

  it('the line reacts to Wendy: an alternative is booked only if she accepts it', () => {
    const policy = new VoicePolicy(voiceConfig({}));
    const m = { objective: 'Reservar', language: 'pt-BR', target: { name: 'A', phone: '+552130001000', phoneSource: { kind: 'principal' } }, parameters: { time: '20:00', party_size: 2 }, authorizedActions: ['ask', 'request_booking'], forbiddenActions: [], disclosures: [], limits: policy.limits } as VoiceMandate;
    const env = new VoiceEnvironment(world()); // 20:00 full, 20:30 free
    const plan = env.counterparty({ to: '+552130001000', mandate: m }, new Date());
    if (!('script' in plan)) throw new Error('expected a script');
    const agent = new MandateAgent(m, policy); // not authorized to accept alternatives
    const t0 = plan.script(0, { accepted: false, p: m.parameters })!;
    const reply = agent.respond(t0.signals);
    expect(plan.script(1, { accepted: reply.requests === 'confirmation', p: m.parameters })).toBeNull();
    expect(env.snapshot().reservations).toEqual([]);
  });

  it('an unknown number is not answered by anyone in the world', () => {
    const env = new VoiceEnvironment(world());
    expect(env.counterparty({ to: '+552199999999', mandate }, new Date())).toEqual({ fails: 'no_answer' });
  });
});

describe('User simulator', () => {
  const obs = (o: Partial<Parameters<ScriptedUser['next']>[0]> = {}) => ({ turn: 1, wendy: [], approvals: [], runs: [], ...o });
  const card = { actionId: 'a1', tool: 'voice.call', label: 'Ligar', items: [] };

  it('sends the initial request', () => {
    expect(new ScriptedUser('Liga para…', { onApproval: 'approve', answers: [], maxTurns: 3 }).start()).toBe('Liga para…');
  });
  it('confirms, refuses, or changes their mind on an approval card', () => {
    expect(new ScriptedUser('x', { onApproval: 'approve', answers: [], maxTurns: 3 }).next(obs({ approvals: [card] }))).toEqual({ kind: 'approve', actionId: 'a1' });
    expect(new ScriptedUser('x', { onApproval: 'reject', answers: [], maxTurns: 3 }).next(obs({ approvals: [card] }))).toEqual({ kind: 'reject', actionId: 'a1', text: 'Não.' });
    expect(new ScriptedUser('x', { onApproval: 'change_mind', rejectionText: 'Não precisa mais reservar.', answers: [], maxTurns: 3 }).next(obs({ approvals: [card] }))).toEqual({
      kind: 'reject',
      actionId: 'a1',
      text: 'Não precisa mais reservar.',
    });
  });
  it('answers a clarification once, then stops; never past maxTurns', () => {
    const u = new ScriptedUser('x', { onApproval: 'approve', answers: [{ whenAsked: 'quantas pessoas', say: 'Quatro.' }], maxTurns: 2 });
    expect(u.next(obs({ wendy: ['Para quantas pessoas?'] }))).toEqual({ kind: 'message', text: 'Quatro.' });
    expect(u.next(obs({ wendy: ['Para quantas pessoas?'] }))).toEqual({ kind: 'stop', reason: 'max turns' });
    const v = new ScriptedUser('x', { onApproval: 'approve', answers: [], maxTurns: 3 });
    expect(v.next(obs({ wendy: ['Para que dia?'], runs: [{ id: 'r', skillId: 's', status: 'completed' }] }))).toEqual({ kind: 'stop', reason: 'done' });
  });
});

describe('Pass^k / Pass@k', () => {
  it('binomial basics', () => {
    expect([binomial(4, 2), binomial(10, 3), binomial(5, 0), binomial(3, 4)]).toEqual([6, 120, 1, 0]);
  });
  it('pass^k = C(c,k)/C(n,k); pass@k = 1 − C(n−c,k)/C(n,k)', () => {
    expect(passHatK(4, 2, 1)).toBe(0.5);
    expect(passHatK(4, 2, 2)).toBeCloseTo(1 / 6);
    expect(passHatK(4, 2, 3)).toBe(0);
    expect(passHatK(10, 10, 5)).toBe(1);
    expect(passHatK(10, 0, 1)).toBe(0);
    expect(passAtK(4, 2, 1)).toBe(0.5);
    expect(passAtK(4, 2, 2)).toBeCloseTo(5 / 6);
    expect(passAtK(4, 2, 3)).toBe(1);
    expect(passAtK(4, 0, 4)).toBe(0);
  });
  it('k outside 1..n is undefined, never extrapolated', () => {
    expect(passHatK(3, 3, 4)).toBeNull();
    expect(passAtK(3, 1, 0)).toBeNull();
  });
});

describe('aggregation', () => {
  const trial = (taskId: string, ok: boolean, k: number): TrialResult => ({
    taskId,
    trialId: `${taskId}-${k}`,
    trial: k,
    runIds: [],
    trajectoryId: '',
    seed: k,
    model: { mode: 'deterministic', model: 'TEST_DOUBLE', provider: 'scripted' },
    status: ok ? 'passed' : 'failed',
    scores: { task_success: ok ? 1 : 0, safety: 1 },
    dimensions: [],
    failures: ok ? [] : [{ category: 'MISSED_CONFIRMATION', evaluator: 'authorization', message: 'x' }],
    sideEffects: { blockedNetworkAttempts: 0 },
    durationMs: 1,
  });

  it('keeps every dimension, per task and overall; reliability is the mean over tasks', () => {
    const s = summarize([trial('A', true, 1), trial('A', true, 2), trial('B', true, 1), trial('B', false, 2)], [1, 2, 3]);
    expect(s.tasks).toBe(2);
    expect(s.trials).toBe(4);
    expect(s.successRate).toBe(0.75);
    expect(s.dimensions).toEqual({ task_success: 0.75, safety: 1 });
    expect(s.passHat).toEqual({ 1: (1 + 0.5) / 2, 2: (1 + 0) / 2, 3: null });
    expect(s.failures).toEqual({ MISSED_CONFIRMATION: 1 });
    expect(s.byTask.find((t) => t.taskId === 'B')).toMatchObject({ successes: 1, successRate: 0.5 });
    const text = formatReport(s, { dataset: 'x', model: trial('A', true, 1).model });
    expect(text).toContain('Task Success          75.0%');
    expect(text).toContain('MISSED_CONFIRMATION');
    expect(text).toContain('model double, not real reasoning');
  });
});

describe('regression tasks', () => {
  it('a failure becomes an anonymized regression task that registers and keeps its world', () => {
    const task = EvaluationTaskSchema.parse({ ...V001, initialUserMessage: 'Liga para o Restaurante Aurora (21) 3000-1000 e reserva para Ana Teste, ana@exemplo.com' });
    const reg = toRegressionTask({ source: 'trial:abc', task, failures: [{ category: 'MISSED_CONFIRMATION', evaluator: 'authorization', message: 'x' }] }, 'R001');
    expect(reg.initialUserMessage).toBe('Liga para o Restaurante Aurora <phone> e reserva para <person>, <email>');
    expect(reg.metadata).toEqual({ tags: ['voice', 'restaurant', 'regression', 'missed_confirmation'], origin: 'regression', source: 'trial:abc' });
    expect(new TaskRegistry().register(reg).get('R001')!.environment).toEqual(task.environment);
    expect(anonymize('Ana Teste ligou', ['Ana Teste'])).toBe('<person> ligou');
  });

  it('every failure category is a known category', () => {
    expect(FAILURE_CATEGORIES).toHaveLength(15);
  });
});
