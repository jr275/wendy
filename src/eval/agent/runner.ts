/**
 * Evaluation runner: task → environment → user simulator → REAL Wendy → trajectory → evaluators.
 *
 * Wendy runs as in production: the agent turn (runWendyAgent: intent → skill), the SkillRuntime,
 * the Toolbox, the permission engine, ActionService / ActionExecutor, VoicePolicy and the in-call
 * agent. Only the outside world is simulated: web pages (fetch hop + search provider of the
 * environment) and the phone line (MockVoiceProvider with the environment as counterparty).
 *
 * Isolation: each trial gets a new principal, a new environment, a new mock call store and its own
 * clock; data of different trials never meet (everything Wendy stores is principal-scoped). Callers
 * run it in a throwaway schema of the TEST database (scripts/eval-agent.ts, tests).
 *
 * Zero external side effects: no real provider exists in the trial's toolbox, the web is the
 * environment's, and global fetch is blocked (and counted) while a trial runs.
 */
import crypto from 'node:crypto';
import type { BaseEvent, RunAgentInput } from '@ag-ui/core';
import { ActionService, PolicyService, type ActionType } from '../../actions/actions.js';
import { messageRecorder, saveMessages, userMessages } from '../../agent/chatLog.js';
import { runWendyAgent } from '../../agent/run.js';
import { summarizeRun } from '../../agent/skillSummary.js';
import type { ReasoningClient } from '../../cognition/llm.js';
import { ScriptedReasoner, TEST_DOUBLE_MODEL } from '../../cognition/scripted.js';
import type { Db } from '../../db/db.js';
import { createPrincipal } from '../../events/world.js';
import { DevMailboxProvider } from '../../providers/devMailbox.js';
import { createContext } from '../../runtime/context.js';
import { builtinRegistry, createSkillRuntime } from '../../skills/index.js';
import { executionView, pendingApprovals } from '../../skills/view.js';
import { Toolbox } from '../../tools/index.js';
import { toolSpec } from '../../tools/specs.js';
import { fixedClock } from '../../util/clock.js';
import { voiceConfig } from '../../voice/config.js';
import { MemoryMockStore, MockVoiceProvider } from '../../voice/mock.js';
import { VoicePolicy } from '../../voice/policy.js';
import { createEnvironment, type VoiceWorldState } from './environment.js';
import { evaluate } from './evaluators.js';
import { ScriptedUser, type Observation, type UserMove } from './simulator.js';
import { reconstructTrajectory, type Trajectory } from './trajectory.js';
import type { EvaluationTask, Failure, ModelConfig, TrialResult } from './types.js';

export type ReasonerFactory = (task: EvaluationTask, db: Db) => { client: ReasoningClient; config: ModelConfig };

/**
 * Deterministic mode: the model double answers what the task fixture says, per purpose. A value
 * may be an object (always the same answer) or an array (one per call, in order). "intent" also
 * accepts { skill } and routes the principal's own message as the skill's request.
 */
/** Model mode: the real reasoner Wendy is configured with (WENDY_REASONER), recorded per trial. */
export const modelReasoner =
  (make: (db: Db) => ReasoningClient, label: { model: string; provider: string; config?: Record<string, unknown> }): ReasonerFactory =>
  (_task, db) => ({ client: make(db), config: { mode: 'model', ...label } });

export const deterministicReasoner: ReasonerFactory = (task, db) => {
  const counters = new Map<string, number>();
  const pick = (purpose: string) => {
    const v = task.modelDouble[purpose];
    if (!Array.isArray(v)) return v;
    const i = counters.get(purpose) ?? 0;
    counters.set(purpose, i + 1);
    return v[Math.min(i, v.length - 1)];
  };
  const scripts = Object.fromEntries(
    Object.keys(task.modelDouble).map((purpose) => [
      purpose,
      purpose === 'intent'
        ? (req: { user: string }) => {
            const request = /<request>\n([\s\S]*)\n<\/request>/.exec(req.user)?.[1] ?? '';
            const v = pick('intent') as { skill: string };
            return { skill: v.skill, input_json: v.skill === 'none' ? '{}' : JSON.stringify({ request }), reason: 'model double' };
          }
        : () => pick(purpose),
    ]),
  );
  return { client: new ScriptedReasoner(db, scripts), config: { mode: 'deterministic', model: TEST_DOUBLE_MODEL, provider: 'scripted (task fixture)' } };
};

const MAX_MOVES = 12;
const DRIVE_STEPS = 60;
const STEP_MS = 60_000;

/**
 * Blocks global fetch while a trial runs and counts attempts (must stay 0). The only exception is
 * the reasoner itself in model mode (a real model is reached over the network); its calls are
 * recorded in model_calls like any other.
 */
function guardNetwork(): { attempts: () => number; restore: () => void; model: <T>(f: () => Promise<T>) => Promise<T> } {
  const original = globalThis.fetch;
  let n = 0;
  let inModel = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    if (inModel > 0) return original(...args);
    n++;
    throw new Error('network is blocked during evaluation');
  }) as typeof fetch;
  return {
    attempts: () => n,
    restore: () => void (globalThis.fetch = original),
    model: async (f) => {
      inModel++;
      try {
        return await f();
      } finally {
        inModel--;
      }
    },
  };
}

export async function runTrial(db: Db, task: EvaluationTask, opts: { trial: number; seed: number; reasoner: ReasonerFactory }): Promise<{ result: TrialResult; trajectory: Trajectory | null }> {
  const started = Date.now();
  const trialId = crypto.randomUUID();
  const clock = fixedClock(task.now);
  const env = createEnvironment(task.environment);
  const initialState = env.snapshot();
  const net = guardNetwork();
  const base = { taskId: task.id, trialId, trial: opts.trial, seed: opts.seed, model: { mode: 'deterministic', model: 'unknown', provider: 'unknown' } as ModelConfig };
  let principalId = '';
  try {
    const made = opts.reasoner(task, db);
    base.model = made.config;
    const client: ReasoningClient = made.config.mode === 'model' ? { generate: (req) => net.model(() => made.client.generate(req)) } : made.client;
    principalId = await createPrincipal(db, { displayName: task.principal.name, primaryEmail: `eval+${trialId}@eval.invalid`, timezone: 'America/Sao_Paulo', locale: task.principal.locale });
    const defaults = voiceConfig({}); // not the process env: a trial's policy is the task's
    const policy = new VoicePolicy({ ...defaults, limits: { ...defaults.limits, ...task.policy.voiceLimits }, costs: { ...defaults.costs, ...task.policy.voiceCosts } });
    for (const p of task.setup.approvalPolicies) await new PolicyService(db).set(principalId, p.actionType as ActionType, p.mode, clock.now());
    const provider = new MockVoiceProvider({ store: new MemoryMockStore(), now: () => clock.now(), counterparty: (call) => env.counterparty(call, clock.now()) });
    const toolbox = new Toolbox({ search: () => env.search, hop: env.hop, documentsRoot: '/nonexistent/wendy-eval', voice: { provider: async () => provider, policy, clock } });
    const ctx = createContext({ db, reasoner: client, clock, emailProvider: new DevMailboxProvider(db), toolbox });
    const skills = createSkillRuntime(ctx, { registry: builtinRegistry(), toolbox, sleep: async () => {} });
    const actions = new ActionService(db);

    const agentTurn = async (text: string): Promise<string[]> => {
      const input = { threadId: 'main', runId: crypto.randomUUID(), messages: [{ id: `eval-${crypto.randomUUID()}`, role: 'user', content: text }], state: {}, tools: [], context: [], forwardedProps: {} } as unknown as RunAgentInput;
      await saveMessages(db, principalId, userMessages(input), clock.now());
      const rec = messageRecorder();
      await runWendyAgent({ ctx, db, principalId, skills }, input, (e: BaseEvent) => rec.record(e as BaseEvent & Record<string, unknown>));
      await saveMessages(db, principalId, rec.messages, clock.now());
      return rec.messages.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content!);
    };

    /** Lets simulated time pass until nothing moves without the principal. */
    const drive = async () => {
      for (let i = 0; i < DRIVE_STEPS; i++) {
        await skills.runtime.runReady();
        const open = (
          await db.query<{ status: string; state: string | null }>(
            `SELECT e.status, a.state FROM skill_executions e LEFT JOIN actions a ON e.wait->>'kind' = 'action' AND a.id = (e.wait->>'id')::uuid
              WHERE e.principal_id = $1 AND e.status NOT IN ('completed','failed','cancelled')`,
            [principalId],
          )
        ).rows;
        if (open.every((r) => r.status === 'waiting_permission' && r.state === 'AWAITING_APPROVAL')) return;
        clock.set(new Date(clock.now().getTime() + STEP_MS));
      }
    };

    const seen = new Map<string, string>();
    const observe = async (turn: number, said: string[]): Promise<Observation> => {
      const runs = (await db.query<{ id: string }>(`SELECT id FROM skill_executions WHERE principal_id = $1 AND parent_id IS NULL ORDER BY created_at`, [principalId])).rows;
      const o: Observation = { turn, wendy: [...said], approvals: [], runs: [] };
      for (const { id } of runs) {
        const v = (await executionView(db, skills.registry, principalId, id))!;
        o.runs.push({ id, skillId: v.skillId, status: v.status });
        o.approvals.push(...pendingApprovals(v).map((a) => ({ actionId: a.actionId, tool: a.tool, label: a.label, items: a.items })));
        const card = summarizeRun(v); // the card updates in place in the chat
        if (seen.get(id) !== card) {
          if (!said.includes(card)) o.wendy.push(card);
          seen.set(id, card);
        }
      }
      return o;
    };

    const user = new ScriptedUser(task.initialUserMessage, task.user);
    const moves: UserMove[] = [];
    const first = user.start();
    moves.push({ kind: 'message', text: first });
    let said = await agentTurn(first);
    for (let turn = 1; turn <= MAX_MOVES; turn++) {
      await drive();
      const move = user.next(await observe(turn, said));
      moves.push(move);
      said = [];
      if (move.kind === 'stop') break;
      if (move.kind === 'approve') await actions.approve(principalId, move.actionId, clock.now());
      else if (move.kind === 'reject') await actions.reject(principalId, move.actionId, move.text, clock.now());
      else said = await agentTurn(move.text);
    }
    await drive();

    const finalState = env.snapshot() as VoiceWorldState;
    const trajectory = await reconstructTrajectory(
      db,
      { id: crypto.randomUUID(), taskId: task.id, trialId, principalId },
      { initialState, finalState, userMoves: moves, categoryOf: (t) => toolSpec(t)?.category ?? 'UNKNOWN' },
    );
    const dimensions = evaluate({ task, trajectory, world: finalState });
    const failures: Failure[] = dimensions.flatMap((d) => d.failures);
    if (net.attempts() > 0) failures.push({ category: 'SAFETY_VIOLATION', evaluator: 'safety', message: `${net.attempts()} network attempt(s) during an isolated trial` });
    const runIds = trajectory.runs.map((r) => r.id);
    return {
      trajectory,
      result: {
        ...base,
        runIds,
        trajectoryId: trajectory.id,
        status: dimensions.every((d) => d.verdict === 'PASS') && net.attempts() === 0 ? 'passed' : 'failed',
        scores: Object.fromEntries(dimensions.map((d) => [d.evaluator, d.score])),
        dimensions,
        failures,
        sideEffects: { blockedNetworkAttempts: net.attempts() },
        durationMs: Date.now() - started,
      },
    };
  } catch (e) {
    return {
      trajectory: null,
      result: { ...base, runIds: [], trajectoryId: '', status: 'error', scores: {}, dimensions: [], failures: [{ category: 'OTHER', evaluator: 'task_success', message: (e as Error).message }], sideEffects: { blockedNetworkAttempts: net.attempts() }, error: (e as Error).stack ?? String(e), durationMs: Date.now() - started },
    };
  } finally {
    net.restore();
  }
}

/** N trials per task, sequential (trials never share mutable state). Seeds are baseSeed + trial. */
export async function runEvaluation(
  db: Db,
  tasks: EvaluationTask[],
  opts: { trials?: number; baseSeed?: number; reasoner?: ReasonerFactory; onTrial?: (r: TrialResult) => void } = {},
): Promise<{ results: TrialResult[]; trajectories: Trajectory[] }> {
  const results: TrialResult[] = [];
  const trajectories: Trajectory[] = [];
  for (const task of tasks) {
    for (let k = 0; k < (opts.trials ?? 1); k++) {
      const { result, trajectory } = await runTrial(db, task, { trial: k + 1, seed: (opts.baseSeed ?? 1) + k, reasoner: opts.reasoner ?? deterministicReasoner });
      results.push(result);
      if (trajectory) trajectories.push(trajectory);
      opts.onTrial?.(result);
    }
  }
  return { results, trajectories };
}
