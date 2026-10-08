/** Wendy's AG-UI agent run: protocol shape, validated content only, website card from stored data. */
import type { BaseEvent, RunAgentInput } from '@ag-ui/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWendyAgent } from '../../src/agent/run.js';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import { addWebProperty } from '../../src/sensors/searchConsole.js';
import { fixedClock } from '../../src/util/clock.js';
import { createTestDb } from '../helpers/db.js';
import { emptyUnderstanding, handlesIn, ScriptedReasoner } from '../helpers/scriptedReasoner.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let principalId: string;
const now = new Date('2026-10-08T12:00:00Z');

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  principalId = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'UTC', locale: 'pt-BR' });
  const prop = await addWebProperty(db, principalId, { siteUrl: 'https://www.aeriva.test/', label: 'Aeriva', source: 'TEST' });
  const put = (start: string, end: string, clicks: number, impressions: number) =>
    db.query(
      `INSERT INTO search_metric_windows(id, principal_id, property_id, window_start, window_end, dimension, key, clicks, impressions, ctr, position, row_limit, fetched_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'total', '', $5, $6, 0.01, 11, 5000, now())`,
      [principalId, prop, start, end, clicks, impressions],
    );
  await put('2026-09-01', '2026-09-28', 811, 154061);
  await put('2026-09-29', '2026-10-05', 142, 17589);
});
afterAll(() => t.drop());

const input = (q: string): RunAgentInput => ({ threadId: 't', runId: 'r', state: {}, messages: [{ id: 'm', role: 'user', content: q }], tools: [], context: [], forwardedProps: {} }) as RunAgentInput;

async function collect(reasoner: ScriptedReasoner, q: string) {
  const events: (BaseEvent & Record<string, unknown>)[] = [];
  const ctx = createContext({ db, reasoner, clock: fixedClock(now), emailProvider: new DevMailboxProvider(db) });
  await runWendyAgent({ ctx, db, principalId }, input(q), (e) => events.push(e as BaseEvent & Record<string, unknown>));
  const tools: Record<string, unknown> = {};
  const names: Record<string, string> = {};
  for (const e of events) {
    if (e.type === 'TOOL_CALL_START') names[e.toolCallId as string] = e.toolCallName as string;
    if (e.type === 'TOOL_CALL_ARGS') tools[names[e.toolCallId as string]!] = JSON.parse(e.delta as string);
  }
  return { types: events.map((e) => e.type), tools };
}

describe('Wendy AG-UI agent run', () => {
  it('a question about a website resolves the site by its stored name, cites its records, and emits the site card', async () => {
    const reasoner = new ScriptedReasoner(db, {
      'understand-question': () => emptyUnderstanding({ topics: [{ label: 'Aeriva', search_terms: ['Aeriva', 'cliques'] }] }),
      answer: (req) => {
        const sc = handlesIn(req.user, 'SC');
        return {
          answer: 'Os cliques caíram [C1]. Talvez sazonalidade [C2].',
          claims: [
            { id: 'C1', kind: 'INFERENCE', statement: 'Clicks fell week over week.', confidence: 0.9, evidence: sc, derived_from: [], about_people: [] },
            { id: 'C2', kind: 'HYPOTHESIS', statement: 'Seasonality.', confidence: 0.3, evidence: [], derived_from: ['C1'], about_people: [] },
            { id: 'C3', kind: 'INFERENCE', statement: 'invented', confidence: 0.9, evidence: ['SC99'], derived_from: [], about_people: [] },
          ],
          used_evidence: sc,
          conflicts: [],
          information_gaps: ['Why impressions fell.'],
        };
      },
    });
    const { types, tools } = await collect(reasoner, 'Por que os cliques da Aeriva caíram?');
    expect(types[0]).toBe('RUN_STARTED');
    expect(types.at(-1)).toBe('RUN_FINISHED');
    expect(types).toContain('STEP_STARTED');
    const answer = tools.show_answer as { claims: { statement: string }[]; rejectedClaims: number; evidence: { kind: string; text: string }[]; notClaude: boolean; gaps: string[] };
    expect(answer.claims.map((c) => c.statement)).not.toContain('invented'); // only validated claims reach the UI
    expect(answer.rejectedClaims).toBeGreaterThanOrEqual(1);
    expect(answer.evidence.every((e) => e.kind === 'search_metric')).toBe(true);
    expect(answer.evidence.some((e) => /clicks 811, impressions 154061/.test(e.text))).toBe(true);
    expect(answer.notClaude).toBe(true); // the test double is not Claude, and the UI is told so
    const site = tools.show_site as { label: string; baselineWeekly: { clicks: number }; current: { clicks: number }; direction: string };
    expect(site).toMatchObject({ label: 'Aeriva', baselineWeekly: { clicks: 202.8 }, current: { clicks: 142 }, direction: 'DROP' });
  });

  it('an empty question ends with RUN_ERROR and calls no model', async () => {
    const reasoner = new ScriptedReasoner(db, {});
    const { types } = await collect(reasoner, '   ');
    expect(types).toEqual(['RUN_STARTED', 'RUN_ERROR']);
    expect(reasoner.calls).toHaveLength(0);
  });
});
