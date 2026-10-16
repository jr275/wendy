/**
 * "Continuar de onde parou" (web/lib/resume.ts). Pure: no database, no network. A question shows a task state only when the server linked it
 * to a task AND that task is among the runs the page has; nothing is read from the text.
 */
import { describe, expect, it } from 'vitest';
import { openCount, resumeEntries, waitingCount } from '../../web/lib/resume.js';

type Run = Parameters<typeof resumeEntries>[1][number];
const run = (id: string, status: Run['status'], approvals: { state: string }[] = [], children: Run[] = []): Run => ({ id, status, approvals, children });
const q = (id: string, runId?: string | null) => ({ id, text: `pergunta ${id}`, at: '2026-10-15T12:00:00.000Z', ...(runId === undefined ? {} : { runId }) });

describe('resumeEntries', () => {
  it('a question with no linked task has no state (never inferred from its text)', () => {
    const e = resumeEntries([q('a'), q('b', null), q('c', undefined)], [run('r1', 'completed')]);
    expect(e.map((x) => [x.question.id, x.phase, x.runId])).toEqual([['a', null, null], ['b', null, null], ['c', null, null]]);
  });
  it('a linked task this page does not have shows no state either (an unknown "done" would be an invention)', () => {
    const e = resumeEntries([q('a', 'gone')], [run('r1', 'completed')]);
    expect(e[0]).toMatchObject({ phase: null, runId: null });
  });
  it('a linked task takes the same state words as everywhere else, from its real status', () => {
    const runs = [run('c', 'completed'), run('f', 'failed'), run('x', 'cancelled'), run('qd', 'queued'), run('rn', 'running'), run('wc', 'waiting_child')];
    const e = resumeEntries(runs.map((r) => q(`q-${r.id}`, r.id)), runs);
    expect(e.map((x) => x.phase)).toEqual(['completed', 'failed', 'cancelled', 'queued', 'running', 'running']);
    expect(e.map((x) => x.runId)).toEqual(['c', 'f', 'x', 'qd', 'rn', 'wc']);
  });
  it('"waiting for approval" only while an approval really awaits the principal (here or in a child); once decided it is working again', () => {
    const awaiting = run('a', 'waiting_permission', [{ state: 'AWAITING_APPROVAL' }]);
    const decided = run('d', 'waiting_permission', [{ state: 'APPROVED' }]);
    const inChild = run('p', 'waiting_child', [], [run('k', 'waiting_permission', [{ state: 'AWAITING_APPROVAL' }])]);
    const e = resumeEntries([q('1', 'a'), q('2', 'd'), q('3', 'p')], [awaiting, decided, inChild]);
    expect(e.map((x) => x.phase)).toEqual(['waiting_for_approval', 'running', 'waiting_for_approval']);
  });
  it('keeps the order and the questions it was given', () => {
    const qs = [q('z'), q('y'), q('x')];
    expect(resumeEntries(qs, []).map((x) => x.question)).toEqual(qs);
    expect(resumeEntries([], [run('r', 'completed')])).toEqual([]);
  });
});

describe('openCount / waitingCount', () => {
  it('counts only what is still open, and those that wait for the principal', () => {
    const runs = [run('c', 'completed'), run('f', 'failed'), run('x', 'cancelled'), run('qd', 'queued'), run('rn', 'running'), run('a', 'waiting_permission', [{ state: 'AWAITING_APPROVAL' }])];
    const e = resumeEntries([...runs.map((r) => q(`q-${r.id}`, r.id)), q('plain')], runs);
    expect(openCount(e)).toBe(3); // queued, running, waiting for approval
    expect(waitingCount(e)).toBe(1);
    expect(openCount(resumeEntries([q('a')], []))).toBe(0);
  });
});
