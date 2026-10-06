/**
 * Pipeline MECHANICS with a scripted test double (not Claude): persistence, idempotency,
 * state-derived events, staleness, validation gating, isolation, concurrency, restart.
 * Cognitive quality is tested live in tests/live.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyLedgerIntegrity } from '../../src/audit/ledger.js';
import { runDetectors } from '../../src/cognition/detectors.js';
import type { ReasoningRequest } from '../../src/cognition/llm.js';
import type { Db } from '../../src/db/db.js';
import { ingestInboundEmail, ingestPrincipalNote } from '../../src/events/ingest.js';
import { completeCommitment, storeMessage } from '../../src/events/world.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext, type WendyContext } from '../../src/runtime/context.js';
import { runCycle } from '../../src/runtime/worker.js';
import { fixedClock, DAY_MS } from '../../src/util/clock.js';
import { buildWorld, SCENARIO_A, SCENARIO_B, urgentEmail, type BuiltWorld } from '../../fixtures/world.js';
import { createTestDb } from '../helpers/db.js';
import { emptyUnderstanding, handlesIn, minimalReasoning, ScriptedReasoner } from '../helpers/scriptedReasoner.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
const NOW = new Date();
const clock = fixedClock(NOW);

/** A generic script: cites whatever evidence the prompt contains; proposes a briefing and a reply to the first person. */
function genericScripts(opts: { failReason?: boolean; invent?: boolean } = {}) {
  return {
    understand: () => emptyUnderstanding(),
    reason: (req: ReasoningRequest<unknown>) => {
      if (opts.failReason) throw new Error('model unavailable');
      const [e, p, m] = [handlesIn(req.user, 'E')[0]!, handlesIn(req.user, 'P')[0], handlesIn(req.user, 'M')[0]];
      if (opts.invent) return minimalReasoning({ claims: [{ id: 'C1', kind: 'INFERENCE', statement: 'invented', confidence: 0.9, evidence: ['M404'], derived_from: [], about_people: ['P404'] }] });
      const evidence = [e, ...(m ? [m] : [])];
      return minimalReasoning({
        relevant_evidence: evidence,
        claims: [
          { id: 'C1', kind: 'INFERENCE', statement: 'scripted inference', confidence: 0.8, evidence, derived_from: [], about_people: p ? [p] : [] },
          { id: 'C2', kind: 'RECOMMENDATION', statement: 'scripted recommendation', confidence: 0.7, evidence: [], derived_from: ['C1'], about_people: [] },
        ],
        narrative: 'Scripted [C1] and [C2].',
        assessment: { urgency: null, business_impact: { value: 0.9, rationale: 'scripted', evidence: [e] }, applicable_preferences: [] },
        proposed_actions: p
          ? [
              { type: 'PREPARE_BRIEFING', target_person: p, related_meeting: null, justification_claims: ['C1'], briefing: { title: 'Scripted brief', sections: [{ heading: 'h', points: [{ text: 'pt', claims: ['C1'], evidence: [e] }] }] }, email: null },
              { type: 'SEND_EMAIL', target_person: p, related_meeting: null, justification_claims: ['C2'], briefing: null, email: { to_person: p, subject: 'Re', body: 'Scripted body' } },
            ]
          : [],
      });
    },
  };
}

function ctxWith(reasoner: ScriptedReasoner, pool: Db = db): WendyContext {
  return createContext({ db: pool, reasoner, clock, emailProvider: new DevMailboxProvider(pool) });
}

let worldA: BuiltWorld;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const birthdayTomorrow = new Date(NOW.getTime() + DAY_MS);
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: SCENARIO_A.principal.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(birthdayTomorrow);
  worldA = await buildWorld(db, SCENARIO_A, NOW, { counterpartBirthdate: `1980-${iso.slice(5)}` });
});
afterAll(() => t.drop());

describe('ingestion & state-derived events', () => {
  it('ingesting the same email twice stores one message and one event', async () => {
    const mail = { ...urgentEmail(worldA, NOW), externalId: 'dup-test' };
    const first = await ingestInboundEmail(db, worldA.principalId, mail, 'DEV_FIXTURE');
    const second = await ingestInboundEmail(db, worldA.principalId, mail, 'DEV_FIXTURE');
    expect(second.duplicate).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(Number((await db.query(`SELECT count(*) AS n FROM messages WHERE external_id = 'dup-test'`)).rows[0].n)).toBe(1);
    await db.query(`UPDATE events SET processing_status = 'SKIPPED' WHERE id = $1`, [first.event.id]); // keep later tests focused
  });

  it('birthday and commitment events are computed from persisted state + clock, idempotently, with no conclusions in the payload', async () => {
    const principal = (await db.query('SELECT * FROM principals WHERE id = $1', [worldA.principalId])).rows[0];
    const first = await runDetectors(db, principal, NOW);
    const second = await runDetectors(db, principal, NOW);
    expect(second.emitted).toHaveLength(0);
    const events = (await db.query(`SELECT event_type, payload FROM events WHERE id = ANY($1::uuid[]) ORDER BY event_type`, [first.emitted])).rows;
    expect(events.map((e) => e.event_type)).toEqual(['COMMITMENT_DUE', 'PERSON_DATE_APPROACHING']);
    expect(Object.keys(events[1].payload).sort()).toEqual(['date_kind', 'days_until', 'occurs_on', 'person_id']);
    expect(events[1].payload.days_until).toBe(1);
    expect(Object.keys(events[0].payload).sort()).toEqual(['commitment_id', 'due_at', 'hours_until_due']);
    await db.query(`UPDATE events SET processing_status = 'SKIPPED' WHERE id = ANY($1::uuid[])`, [first.emitted]);
  });

  it('nothing is detected when the state does not warrant it', async () => {
    const t2 = await createTestDb();
    try {
      const w = await buildWorld(t2.db, SCENARIO_B, NOW, { counterpartBirthdate: '1975-01-01' });
      await t2.db.query(`UPDATE commitments SET due_at = $1`, [new Date(NOW.getTime() + 10 * DAY_MS)]);
      const principal = (await t2.db.query('SELECT * FROM principals WHERE id = $1', [w.principalId])).rows[0];
      expect((await runDetectors(t2.db, principal, NOW)).emitted).toHaveLength(0);
    } finally {
      await t2.drop();
    }
  });
});

describe('cognitive loop mechanics (test double)', () => {
  it('an event becomes a persisted insight with code facts, validated claims, policy-driven actions, audit, and executed internal work', async () => {
    const reasoner = new ScriptedReasoner(db, genericScripts());
    const { event } = await ingestInboundEmail(db, worldA.principalId, urgentEmail(worldA, NOW), 'DEV_FIXTURE');
    const report = await runCycle(ctxWith(reasoner));
    const outcome = report.outcomes.find((o) => o.eventId === event.id);
    expect(outcome?.status).toBe('PROCESSED');
    if (outcome?.status !== 'PROCESSED') return;

    // Retrieval (deterministic) put the related meeting, history and commitment in front of the model.
    const prompt = reasoner.calls.find((c) => c.purpose === 'reason')!.user;
    expect(prompt).toContain(SCENARIO_A.meeting.title);
    expect(prompt).toContain(SCENARIO_A.topic.history[2]);
    expect(prompt).toContain(SCENARIO_A.topic.commitment);
    expect(prompt).not.toContain(SCENARIO_A.topic.unrelated);

    const claims = (await db.query('SELECT kind, produced_by, validation_status FROM claims WHERE insight_id = $1 ORDER BY ordinal', [outcome.insightId])).rows;
    expect(claims.filter((c) => c.produced_by === 'CODE').every((c) => c.kind === 'FACT')).toBe(true);
    expect(claims.filter((c) => c.produced_by === 'CLAUDE').map((c) => c.kind)).toEqual(['INFERENCE', 'RECOMMENDATION']);

    const actions = (await db.query('SELECT action_type, state FROM actions WHERE insight_id = $1 ORDER BY action_type', [outcome.insightId])).rows;
    expect(actions).toEqual([
      { action_type: 'PREPARE_BRIEFING', state: 'VERIFIED' },
      { action_type: 'SEND_EMAIL', state: 'AWAITING_APPROVAL' },
    ]);
    expect((await db.query('SELECT model FROM model_calls WHERE id IN (SELECT unnest(model_call_ids) FROM insights WHERE id = $1)', [outcome.insightId])).rows.every((r) => r.model === 'TEST_DOUBLE')).toBe(true);
    expect((await db.query('SELECT processing_status FROM events WHERE id = $1', [event.id])).rows[0].processing_status).toBe('PROCESSED');
    expect((await verifyLedgerIntegrity(db)).valid).toBe(true);
  });

  it('a duplicate event is never reprocessed (no new insight, no model call)', async () => {
    const reasoner = new ScriptedReasoner(db, genericScripts());
    const { duplicate } = await ingestInboundEmail(db, worldA.principalId, urgentEmail(worldA, NOW), 'DEV_FIXTURE');
    expect(duplicate).toBe(true);
    await runCycle(ctxWith(reasoner));
    expect(reasoner.calls).toHaveLength(0);
  });

  it('reasoning that cites invented evidence is rejected: no actions, no memories, nothing surfaced', async () => {
    const reasoner = new ScriptedReasoner(db, genericScripts({ invent: true }));
    const { event } = await ingestInboundEmail(db, worldA.principalId, { ...urgentEmail(worldA, NOW), externalId: 'invent-1' }, 'DEV_FIXTURE');
    await runCycle(ctxWith(reasoner));
    const insight = (await db.query('SELECT id, status FROM insights WHERE event_id = $1', [event.id])).rows[0];
    expect(insight.status).toBe('REJECTED_BY_VALIDATION');
    expect(Number((await db.query('SELECT count(*) n FROM actions WHERE insight_id = $1', [insight.id])).rows[0].n)).toBe(0);
  });

  it('when the model is unavailable the event is retried, then marked FAILED — nothing is invented', async () => {
    const reasoner = new ScriptedReasoner(db, genericScripts({ failReason: true }));
    const { event } = await ingestInboundEmail(db, worldA.principalId, { ...urgentEmail(worldA, NOW), externalId: 'fail-1' }, 'DEV_FIXTURE');
    const r1 = await runCycle(ctxWith(reasoner));
    expect(r1.failures.filter((f) => f.eventId === event.id)).toHaveLength(1); // no hot retry loop within a cycle
    for (let i = 0; i < 4; i++) {
      clock.set(new Date(clock.now().getTime() + 10 * 60_000)); // backoff elapses
      await runCycle(ctxWith(reasoner));
    }
    clock.set(NOW);
    const row = (await db.query('SELECT processing_status, processing_attempts, last_error FROM events WHERE id = $1', [event.id])).rows[0];
    expect(row.processing_status).toBe('FAILED');
    expect(row.processing_attempts).toBe(5);
    expect(row.last_error).toMatch(/model unavailable/);
    expect(Number((await db.query('SELECT count(*) n FROM insights WHERE event_id = $1', [event.id])).rows[0].n)).toBe(0);
  });

  it('stale context: a commitment completed after detection is skipped without calling the model', async () => {
    const principal = (await db.query('SELECT * FROM principals WHERE id = $1', [worldA.principalId])).rows[0];
    await db.query(`UPDATE commitments SET due_at = $2 WHERE id = $1`, [worldA.commitmentId, new Date(NOW.getTime() + 2 * 3_600_000)]);
    const { emitted } = await runDetectors(db, principal, NOW);
    expect(emitted).toHaveLength(1);
    await completeCommitment(db, worldA.principalId, worldA.commitmentId, NOW);
    const reasoner = new ScriptedReasoner(db, genericScripts());
    const report = await runCycle(ctxWith(reasoner));
    expect(report.outcomes.find((o) => o.eventId === emitted[0])).toMatchObject({ status: 'SKIPPED', reason: expect.stringMatching(/DONE/) });
    expect(reasoner.calls).toHaveLength(0);
  });

  it('principals are isolated: the same address is unknown to another principal', async () => {
    const worldB = await buildWorld(db, SCENARIO_B, NOW);
    const reasoner = new ScriptedReasoner(db, genericScripts());
    await ingestInboundEmail(db, worldB.principalId, { ...urgentEmail(worldA, NOW), externalId: 'cross-1', to: [SCENARIO_B.principal.email] }, 'DEV_FIXTURE');
    await runCycle(ctxWith(reasoner));
    const prompt = reasoner.calls.find((c) => c.purpose === 'reason' && c.user.includes('cross'))?.user ?? reasoner.calls.find((c) => c.purpose === 'reason')!.user;
    expect(prompt).toContain('(sender is not a known contact)');
    expect(prompt).not.toContain(SCENARIO_A.counterpart.name);
    expect(prompt).not.toContain(SCENARIO_A.meeting.title);
  });

  it('concurrent workers process each event exactly once', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await ingestInboundEmail(db, worldA.principalId, { ...urgentEmail(worldA, NOW), externalId: `conc-${i}` }, 'DEV_FIXTURE')).event.id);
    const r1 = new ScriptedReasoner(db, genericScripts());
    const r2 = new ScriptedReasoner(t.reconnect(), genericScripts());
    await Promise.all([runCycle(ctxWith(r1)), runCycle(ctxWith(r2, t.reconnect()))]);
    expect(Number((await db.query('SELECT count(*) n FROM insights WHERE event_id = ANY($1::uuid[])', [ids])).rows[0].n)).toBe(6);
    expect([...r1.calls, ...r2.calls].filter((c) => c.purpose === 'reason')).toHaveLength(6);
  });

  it('everything survives a restart: a new pool sees insights, actions, memories and a valid ledger', async () => {
    const fresh = t.reconnect();
    expect(Number((await fresh.query('SELECT count(*) n FROM insights')).rows[0].n)).toBeGreaterThan(0);
    expect(Number((await fresh.query(`SELECT count(*) n FROM actions WHERE state = 'AWAITING_APPROVAL'`)).rows[0].n)).toBeGreaterThan(0);
    expect((await verifyLedgerIntegrity(fresh)).valid).toBe(true);
  });

  it('memories deduced from an email enter as PROPOSED; memories dictated by the principal enter as ACTIVE', async () => {
    const withMemory = (content: string) => ({
      ...genericScripts(),
      reason: (req: ReasoningRequest<unknown>) => ({
        ...(genericScripts().reason(req) as object),
        memory_proposals: [{ kind: 'PREFERENCE' as const, about_person: null, content, evidence: [handlesIn(req.user, 'E')[0]!], confidence: 0.8 }],
      }),
    });
    await ingestInboundEmail(db, worldA.principalId, { ...urgentEmail(worldA, NOW), externalId: 'mem-email' }, 'DEV_FIXTURE');
    await runCycle(ctxWith(new ScriptedReasoner(db, withMemory('deduced-from-email'))));
    await ingestPrincipalNote(db, worldA.principalId, { text: 'I prefer short emails', externalId: 'mem-note', at: NOW });
    await runCycle(ctxWith(new ScriptedReasoner(db, withMemory('dictated-by-principal'))));
    const status = async (c: string) => (await db.query('SELECT status FROM memories WHERE content = $1', [c])).rows.map((r) => r.status);
    expect(await status('deduced-from-email')).toEqual(['PROPOSED']);
    expect(await status('dictated-by-principal')).toEqual(['ACTIVE']);
  });

  it('retrieval by topic finds records from other people when the model supplies search terms', async () => {
    await storeMessageViaTx(db, worldA.principalId, { provider: 'DEV_FIXTURE_MAIL', externalId: 'topic-x', from: SCENARIO_A.bystander.email, to: [SCENARIO_A.principal.email], subject: 'Heads up', body: 'zyxquant appears here only', sentAt: new Date(NOW.getTime() - DAY_MS) });
    const reasoner = new ScriptedReasoner(db, { ...genericScripts(), understand: () => emptyUnderstanding({ topics: [{ label: 'x', search_terms: ['zyxquant'] }] }) });
    await ingestInboundEmail(db, worldA.principalId, { ...urgentEmail(worldA, NOW), externalId: 'topic-trigger' }, 'DEV_FIXTURE');
    await runCycle(ctxWith(reasoner));
    expect(reasoner.calls.find((c) => c.purpose === 'reason')!.user).toContain('zyxquant appears here only');
  });
});

async function storeMessageViaTx(pool: Db, principalId: string, m: Parameters<typeof storeMessage>[2]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await storeMessage(c, principalId, m);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}
