/**
 * The unified task phase (web/lib/taskStatus.ts) against REAL runtime views: a real task-management
 * run is created, parked on its approval, approved, completed, rejected and cancelled, and the view
 * read at each point. The phase must follow what the runtime really knows: "needs you" only while
 * an approval is truly awaiting, "working" once it is decided, terminal states never revert.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/actions.js';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import { createSkillRuntime } from '../../src/skills/index.js';
import { cancelExecution } from '../../src/skills/cancel.js';
import { executionView } from '../../src/skills/view.js';
import { fixedClock } from '../../src/util/clock.js';
import { awaitingApproval, isFinished, PHASE_LABEL, PHASE_MEANING, taskPhase, type PhaseInput, type TaskPhase } from '../../web/lib/taskStatus.js';
import type { ExecutionView as WebView } from '../../web/lib/wendy.js';
import { createTestDb } from '../helpers/db.js';
import { ScriptedReasoner } from '../helpers/scriptedReasoner.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let principalId: string;
const clock = fixedClock('2026-10-08T12:00:00Z');

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  principalId = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
});
afterAll(() => t.drop());

function rt() {
  const ctx = createContext({ db, reasoner: new ScriptedReasoner(db, {}), clock, emailProvider: new DevMailboxProvider(db) });
  return createSkillRuntime(ctx, { sleep: async () => {} });
}
const view = async (s: ReturnType<typeof rt>, id: string) => (await executionView(db, s.registry, principalId, id)) as unknown as WebView;
const start = (s: ReturnType<typeof rt>, title: string) => s.runtime.start(principalId, 'task-management', { operation: 'create', tasks: [{ title }] }, { kind: 'test' });

describe('the phase follows the real run', () => {
  it('queued → needs you (approval really awaiting) → working (decided) → completed', async () => {
    const s = rt();
    const id = await start(s, 'Fase 1');
    expect(taskPhase(await view(s, id))).toBe('queued');

    await s.runtime.advance(id);
    const parked = await view(s, id);
    expect(parked.status).toBe('waiting_permission');
    expect(parked.approvals.some((a) => a.state === 'AWAITING_APPROVAL')).toBe(true);
    expect(taskPhase(parked)).toBe('waiting_for_approval');

    // Approved but the run has not moved yet: the runtime still says waiting_permission, but nothing waits for the principal any more.
    const actionId = (await s.runtime.get(id))!.wait!.id;
    await new ActionService(db).approve(principalId, actionId, clock.now());
    const decided = await view(s, id);
    expect(decided.status).toBe('waiting_permission');
    expect(awaitingApproval(decided)).toBe(false);
    expect(taskPhase(decided)).toBe('running'); // saying "needs you" here would be false

    await s.runtime.runReady();
    const done = await view(s, id);
    expect(taskPhase(done)).toBe('completed');
    expect(isFinished(taskPhase(done))).toBe(true);
  });

  it('cancelled stays cancelled', async () => {
    const s = rt();
    const id = await start(s, 'Fase 2');
    await s.runtime.advance(id);
    expect(taskPhase(await view(s, id))).toBe('waiting_for_approval');
    await cancelExecution(db, principalId, id, 'não preciso mais', clock.now());
    const v = await view(s, id);
    expect(v.status).toBe('cancelled');
    expect(taskPhase(v)).toBe('cancelled');
  });
});

describe('the mapping itself (pure)', () => {
  const node = (status: WebView['status'], approvalStates: string[] = [], children: PhaseInput[] = []): PhaseInput => ({ status, approvals: approvalStates.map((state) => ({ state })), children });

  it('maps every real runtime status; terminal ones ignore any approval', () => {
    const expected: Record<WebView['status'], TaskPhase> = { queued: 'queued', running: 'running', waiting_child: 'running', waiting_permission: 'running', completed: 'completed', failed: 'failed', cancelled: 'cancelled' };
    for (const [status, phase] of Object.entries(expected)) expect(taskPhase(node(status as WebView['status'])), status).toBe(phase);
    expect(taskPhase(node('completed', ['AWAITING_APPROVAL']))).toBe('completed');
    expect(taskPhase(node('failed', ['AWAITING_APPROVAL']))).toBe('failed');
  });

  it('an approval waiting in a CHILD run makes the parent "needs you", even though the parent itself is waiting_child', () => {
    const child = node('waiting_permission', ['AWAITING_APPROVAL']);
    expect(taskPhase(node('waiting_child', [], [child]))).toBe('waiting_for_approval');
    expect(taskPhase(node('waiting_child', [], [node('running')]))).toBe('running');
  });

  it('only states the runtime really has: no "blocked" and no "retrying" are invented', () => {
    expect(Object.keys(PHASE_LABEL).sort()).toEqual(['cancelled', 'completed', 'failed', 'queued', 'running', 'waiting_for_approval']);
    expect(Object.keys(PHASE_MEANING).sort()).toEqual(Object.keys(PHASE_LABEL).sort());
  });
});
