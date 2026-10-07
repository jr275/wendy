/**
 * The UI server must never change Wendy's state, and every number it shows must come from
 * persisted records. Uses the same read-only pool factory the server uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readOnlyPool } from '../../inspector/readOnlyPool.js';
import { insightDetail, ontology, radar, today } from '../../inspector/views.js';
import { ingestInboundEmail } from '../../src/events/ingest.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import { runCycle } from '../../src/runtime/worker.js';
import { fixedClock } from '../../src/util/clock.js';
import { buildWorld, SCENARIO_A, urgentEmail, type BuiltWorld } from '../../fixtures/world.js';
import { createTestDb } from '../helpers/db.js';
import { emptyUnderstanding, handlesIn, minimalReasoning, ScriptedReasoner } from '../helpers/scriptedReasoner.js';
import type pg from 'pg';

let t: Awaited<ReturnType<typeof createTestDb>>;
let ro: pg.Pool;
let world: BuiltWorld;
const NOW = new Date();

beforeAll(async () => {
  t = await createTestDb();
  world = await buildWorld(t.db, SCENARIO_A, NOW);
  const reasoner = new ScriptedReasoner(t.db, {
    understand: () => emptyUnderstanding(),
    reason: (req) => {
      const e = handlesIn(req.user, 'E')[0]!;
      const p = handlesIn(req.user, 'P')[0]!;
      return minimalReasoning({
        relevant_evidence: [e],
        claims: [
          { id: 'C1', kind: 'INFERENCE', statement: 'scripted', confidence: 0.8, evidence: [e, p], derived_from: [], about_people: [p] },
          { id: 'C2', kind: 'RECOMMENDATION', statement: 'scripted', confidence: 0.7, evidence: [], derived_from: ['C1'], about_people: [] },
        ],
        narrative: 'x [C1] [C2]',
        assessment: { urgency: null, business_impact: { value: 0.9, rationale: 'r', evidence: [e] }, applicable_preferences: [] },
        proposed_actions: [{ type: 'SEND_EMAIL', target_person: p, related_meeting: null, justification_claims: ['C2'], briefing: null, email: { to_person: p, subject: 's', body: 'b' } }],
      });
    },
  });
  await ingestInboundEmail(t.db, world.principalId, urgentEmail(world, NOW), 'DEV_FIXTURE');
  await runCycle(createContext({ db: t.db, reasoner, clock: fixedClock(NOW), emailProvider: new DevMailboxProvider(t.db) }));
  ro = readOnlyPool(process.env.WENDY_TEST_DATABASE_URL ?? 'postgres:///wendy_test', t.schema);
});
afterAll(async () => {
  await ro?.end();
  await t.drop();
});

describe('inspector (UI server)', () => {
  it('cannot write: every statement through its pool is rejected by Postgres', async () => {
    await expect(ro.query(`UPDATE actions SET state = 'APPROVED'`)).rejects.toThrow(/read-only/);
    await expect(ro.query(`INSERT INTO principals(id, display_name, primary_email, timezone, locale) VALUES (gen_random_uuid(), 'x', 'x', 'UTC', 'en')`)).rejects.toThrow(/read-only/);
    await expect(ro.query(`DELETE FROM audit_blocks`)).rejects.toThrow(/read-only/);
  });

  it('shows numbers that match persisted state', async () => {
    const d = await today(ro, world.principalId);
    const awaiting = Number((await t.db.query(`SELECT count(*) n FROM actions WHERE state = 'AWAITING_APPROVAL'`)).rows[0].n);
    const insights = Number((await t.db.query(`SELECT count(*) n FROM insights`)).rows[0].n);
    expect(d.kpis?.awaiting).toBe(awaiting);
    expect(d.kpis?.insights_total).toBe(insights);
    expect(d.insights?.length).toBe(insights);
  });

  it('radar lists the next 7 days from persisted records only, with each attendee\'s relationship state', async () => {
    const d = await radar(ro, world.principalId);
    const meeting = d.items.find((i) => i.kind === 'meeting' && i.id === world.meetingId) as { people: { id?: string; full_name?: string; daysSinceContact?: number | null }[] } | undefined;
    expect(meeting, 'the scenario meeting is within 7 days').toBeTruthy();
    const carlos = meeting!.people.find((p) => p.id === world.counterpartId)!;
    expect(carlos.full_name).toBe(SCENARIO_A.counterpart.name);
    expect(carlos.daysSinceContact).not.toBeUndefined();
    const meetingsInDb = Number((await t.db.query(`SELECT count(*) n FROM meetings WHERE status <> 'CANCELLED' AND starts_at >= now() AND starts_at < now() + interval '7 days'`)).rows[0].n);
    expect(d.items.filter((i) => i.kind === 'meeting')).toHaveLength(meetingsInDb);
    const open = Number((await t.db.query(`SELECT count(*) n FROM commitments WHERE status = 'OPEN' AND due_at < now() + interval '7 days'`)).rows[0].n);
    expect(d.items.filter((i) => i.kind === 'commitment').length + d.overdue.length).toBe(open);
  });

  it('labels evidence from the real records (no invented text)', async () => {
    const id = (await t.db.query(`SELECT i.id FROM insights i JOIN events e ON e.id = i.event_id WHERE e.event_type = 'EMAIL_RECEIVED'`)).rows[0].id;
    const d = await insightDetail(ro, id);
    const labels = Object.values(d.labels);
    expect(labels).toContain(SCENARIO_A.counterpart.name);
    expect(labels.some((l) => l.startsWith('E-mail recebido'))).toBe(true);
  });

  it('builds the ontology only from existing records and links', async () => {
    const g = await ontology(ro, world.principalId);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    expect(g.nodes.find((n) => n.type === 'person' && n.label === SCENARIO_A.counterpart.name)).toBeTruthy();
    expect(g.nodes.find((n) => n.type === 'meeting' && n.label === SCENARIO_A.meeting.title)).toBeTruthy();
    expect(g.edges.some((e) => e.label === 'participa de')).toBe(true);
  });
});
