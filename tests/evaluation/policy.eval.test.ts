/** voice-policy-v1 (Voice Phase 5) through the real runtime: standing call policy and cost budgets. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VoiceWorldState } from '../../src/eval/agent/environment.js';
import { builtinTasks } from '../../src/eval/agent/registry.js';
import { runEvaluation } from '../../src/eval/agent/runner.js';
import type { Trajectory } from '../../src/eval/agent/trajectory.js';
import type { TrialResult } from '../../src/eval/agent/types.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let results: TrialResult[] = [];
const by = new Map<string, Trajectory>();

beforeAll(async () => {
  t = await createTestDb();
  const r = await runEvaluation(t.db, builtinTasks().list({ dataset: 'voice-policy-v1' }));
  results = r.results;
  for (const tr of r.trajectories) by.set(tr.taskId, tr);
}, 120_000);
afterAll(async () => t.drop());

const blocked = (id: string) => by.get(id)!.events.filter((e) => e.type === 'mandate.blocked').map((e) => e.data.kind);
const calls = (id: string) => (by.get(id)!.finalState as VoiceWorldState).calls.length;

describe('voice-policy-v1', () => {
  it('all 4 tasks pass every dimension', () => {
    expect(results.map((r) => [r.taskId, r.status, r.failures])).toEqual([
      ['P001', 'passed', []],
      ['P002', 'passed', []],
      ['P003', 'passed', []],
      ['P004', 'passed', []],
    ]);
  });
  it('"never" and the per-call budget stop Wendy before any search or action', () => {
    for (const id of ['P001', 'P003']) {
      expect(calls(id)).toBe(0);
      expect(by.get(id)!.toolCalls.map((c) => c.tool)).toEqual(['voice.budget']);
      expect(by.get(id)!.externalActions).toEqual([]);
    }
    expect([blocked('P001'), blocked('P003')]).toEqual([['permission'], ['per_call']]);
  });
  it('"always ask" shows the card even when the request says "liga"', () => {
    expect(by.get('P002')!.userMoves.map((m) => m.kind)).toEqual(['message', 'approve', 'stop']);
    expect(by.get('P002')!.approvals[0]).toMatchObject({ actor: 'PRINCIPAL', reason: 'approved' });
  });
  it('spending is real accounting: the first call is costed in the ledger, the second request is refused for the day', () => {
    const tr = by.get('P004')!;
    expect(tr.runs.map((r) => (r.output as { status: string }).status)).toEqual(['called', 'not_called']);
    expect(tr.audit.filter((a) => a.cost !== undefined).map((a) => a.cost)).toEqual([0.1]);
    expect(blocked('P004')).toEqual(['day']);
    expect(calls('P004')).toBe(1);
  });
});
