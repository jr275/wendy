/**
 * LIVE COGNITIVE TESTS — real Claude (claude-opus-5-5), real Postgres, no test doubles.
 * Requires ANTHROPIC_API_KEY (in .env). Each test asserts structure and grounding, never exact wording.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerQuestion } from '../../src/cognition/ask.js';
import { ClaudeReasoningClient } from '../../src/cognition/llm.js';
import { loadEnv } from '../../src/config.js';
import { verifyLedgerIntegrity } from '../../src/audit/ledger.js';
import type { Db } from '../../src/db/db.js';
import { ingestInboundEmail, ingestPrincipalNote } from '../../src/events/ingest.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext, type WendyContext } from '../../src/runtime/context.js';
import { runCycle } from '../../src/runtime/worker.js';
import { DAY_MS, HOUR_MS, systemClock } from '../../src/util/clock.js';
import { buildWorld, SCENARIO_A, SCENARIO_B, urgentEmail, type BuiltWorld, type ScenarioParams } from '../../fixtures/world.js';
import { createTestDb } from '../helpers/db.js';

loadEnv();
const LIVE_TIMEOUT = 600_000;

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
const NOW = new Date();

const liveContext = (pool: Db = db): WendyContext => createContext({ db: pool, reasoner: new ClaudeReasoningClient(pool), clock: systemClock, emailProvider: new DevMailboxProvider(pool) });

beforeAll(async () => {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('LIVE TESTS REQUIRE ANTHROPIC_API_KEY (.env). They are not skipped silently.');
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => {
  if (process.env.WENDY_KEEP_LIVE_SCHEMA) console.log(`kept schema ${t.schema}`);
  else await t?.drop();
});

interface ClaimRow { kind: string; produced_by: string; validation_status: string; evidence: { kind: string; id: string; handle: string }[]; statement: string }

async function insightFor(eventId: string) {
  const insight = (await db.query('SELECT * FROM insights WHERE event_id = $1', [eventId])).rows[0];
  expect(insight, `no insight for event ${eventId}`).toBeTruthy();
  const claims = (await db.query<ClaimRow>('SELECT * FROM claims WHERE insight_id = $1 ORDER BY ordinal', [insight.id])).rows;
  const actions = (
    await db.query(`SELECT a.action_type, a.state, v.content FROM actions a JOIN action_versions v ON v.action_id = a.id AND v.version = a.current_version WHERE a.insight_id = $1`, [insight.id])
  ).rows;
  const calls = (await db.query('SELECT model, served_by_model, api_message_id, purpose, input_evidence_refs FROM model_calls WHERE id = ANY($1::uuid[])', [insight.model_call_ids])).rows;
  console.log(`\n================ ${insight.status} (salience ${insight.salience.score}) ================\n${insight.rendered}\n`);
  return { insight, claims, actions, calls, valid: claims.filter((c) => c.validation_status === 'VALID' && c.produced_by === 'CLAUDE') };
}

function cites(valid: ClaimRow[], kind: string, id: string) {
  return valid.some((c) => c.evidence.some((e) => e.kind === kind && e.id === id));
}

function expectRealClaude(calls: { model: string; api_message_id: string | null }[]) {
  expect(calls.length).toBeGreaterThanOrEqual(2);
  for (const c of calls) {
    expect(c.model).toBe('claude-opus-5-5');
    expect(c.api_message_id).toMatch(/^msg_/);
  }
}

async function processUrgentEmail(params: ScenarioParams) {
  const world = await buildWorld(db, params, NOW);
  const { event } = await ingestInboundEmail(db, world.principalId, urgentEmail(world, NOW), 'DEV_FIXTURE');
  const report = await runCycle(liveContext());
  expect(report.failures).toEqual([]);
  return { world, ...(await insightFor(event.id)) };
}

function expectProactiveUrgentInsight(r: Awaited<ReturnType<typeof processUrgentEmail>>, world: BuiltWorld) {
  expectRealClaude(r.calls);
  expect(r.insight.status).toBe('SURFACED');
  const kinds = new Set(r.valid.map((c) => c.kind));
  expect(kinds.has('INFERENCE')).toBe(true);
  expect(kinds.has('ANTICIPATION') || kinds.has('HYPOTHESIS')).toBe(true);
  expect(kinds.has('RECOMMENDATION')).toBe(true);
  // connected context: the meeting, the history, the person
  expect(cites(r.valid, 'meeting', world.meetingId)).toBe(true);
  expect(world.historyMessageIds.filter((id) => cites(r.valid, 'message', id)).length).toBeGreaterThanOrEqual(2);
  expect(cites(r.valid, 'person', world.counterpartId)).toBe(true);
  expect(Object.values(r.insight.evidence_map as Record<string, { id: string }>).some((ref) => ref.id === world.commitmentId)).toBe(true);
  expect(cites(r.valid, 'message', world.unrelatedMessageId)).toBe(false);
  // urgency was read from the text, with a verifiable quote
  const urgency = r.insight.salience.factors.find((f: { name: string }) => f.name === 'urgency');
  expect(urgency.value).toBeGreaterThan(0.5);
  // prepared: a briefing (executed + verified) and a reply awaiting approval
  expect(r.actions.find((a) => a.action_type === 'PREPARE_BRIEFING')?.state).toBe('VERIFIED');
  const reply = r.actions.find((a) => a.action_type === 'SEND_EMAIL');
  expect(reply?.state).toBe('AWAITING_APPROVAL');
  expect(reply?.content.to).toEqual([world.params.counterpart.email]);
}

describe('LIVE: proactive insight from a new signal', () => {
  it('Scenario A: urgent email → understands, connects meeting/history/commitment, anticipates, prepares, waits for approval', async () => {
    const r = await processUrgentEmail(SCENARIO_A);
    expectProactiveUrgentInsight(r, r.world);
  }, LIVE_TIMEOUT);

  it('ANTI-HARDCODE: completely different person, company, topic, meeting, timing and language → same behavior', async () => {
    const r = await processUrgentEmail(SCENARIO_B);
    expectProactiveUrgentInsight(r, r.world);
  }, LIVE_TIMEOUT);

  it('unknown person, unknown topic → no crash, no invented contact, no outbound action', async () => {
    const world = await buildWorld(db, { ...SCENARIO_A, key: 'unk', principal: { ...SCENARIO_A.principal, email: 'unk-principal@mendes-partners.com' } }, NOW);
    const { event } = await ingestInboundEmail(
      db,
      world.principalId,
      { provider: 'DEV_FIXTURE_MAIL', externalId: 'unk-1', from: 'r.okafor@lagoon-marine.example', to: ['unk-principal@mendes-partners.com'], subject: 'Coral survey data', body: 'Hello, could you share the 2025 coral survey dataset you mentioned at the conference?', sentAt: new Date(NOW.getTime() - 60_000) },
      'DEV_FIXTURE',
    );
    expect((await runCycle(liveContext())).failures).toEqual([]);
    const r = await insightFor(event.id);
    expectRealClaude(r.calls);
    expect(r.actions.filter((a) => a.action_type === 'SEND_EMAIL')).toEqual([]);
    expect(cites(r.valid, 'meeting', world.meetingId)).toBe(false);
    expect(cites(r.valid, 'commitment', world.commitmentId)).toBe(false);
  }, LIVE_TIMEOUT);

  it('insufficient context (a polite ack) → recorded but not surfaced', async () => {
    const world = await buildWorld(db, { ...SCENARIO_B, key: 'ack', principal: { ...SCENARIO_B.principal, email: 'ack-principal@costa-ventures.com' } }, NOW);
    const { event } = await ingestInboundEmail(
      db,
      world.principalId,
      { provider: 'DEV_FIXTURE_MAIL', externalId: 'ack-1', from: SCENARIO_B.counterpart.email, to: ['ack-principal@costa-ventures.com'], subject: 'Re: almoço', body: 'Ok, obrigada!', sentAt: new Date(NOW.getTime() - 60_000) },
      'DEV_FIXTURE',
    );
    await db.query(`UPDATE commitments SET due_at = $2 WHERE principal_id = $1`, [world.principalId, new Date(NOW.getTime() + 20 * DAY_MS)]);
    expect((await runCycle(liveContext())).failures).toEqual([]);
    const r = await insightFor(event.id);
    expect(r.insight.status).toBe('SUPPRESSED');
  }, LIVE_TIMEOUT);
});

describe('LIVE: state-derived anticipation', () => {
  it('COMMITMENT_DUE: Wendy discovers an open commitment due today with no evidence of completion and prepares a follow-up', async () => {
    const world = await buildWorld(db, { ...SCENARIO_A, key: 'cmt', principal: { ...SCENARIO_A.principal, email: 'cmt-principal@mendes-partners.com' } }, NOW);
    await db.query(`UPDATE commitments SET due_at = $2 WHERE id = $1`, [world.commitmentId, new Date(NOW.getTime() + 3 * HOUR_MS)]);
    await db.query(`UPDATE meetings SET starts_at = starts_at + interval '10 days', ends_at = ends_at + interval '10 days' WHERE principal_id = $1`, [world.principalId]);
    const report = await runCycle(liveContext());
    expect(report.failures).toEqual([]);
    const eventId = (await db.query(`SELECT id FROM events WHERE principal_id = $1 AND event_type = 'COMMITMENT_DUE'`, [world.principalId])).rows[0].id;
    const r = await insightFor(eventId);
    expectRealClaude(r.calls);
    expect(r.insight.status).toBe('SURFACED');
    expect(r.insight.validation.completion.status).toBe('NO_EVIDENCE_OF_COMPLETION');
    expect(cites(r.valid, 'commitment', world.commitmentId)).toBe(true);
    const followUp = r.actions.find((a) => a.action_type === 'SEND_EMAIL');
    expect(followUp?.state).toBe('AWAITING_APPROVAL');
    expect(followUp?.content.to).toEqual([SCENARIO_A.counterpart.email]);
  }, LIVE_TIMEOUT);

  it('PERSON_DATE_APPROACHING: birthday computed from the stored birthdate → relationship context → draft awaiting approval', async () => {
    const tz = SCENARIO_B.principal.timezone;
    const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(NOW.getTime() + DAY_MS));
    const world = await buildWorld(db, { ...SCENARIO_B, key: 'bday', principal: { ...SCENARIO_B.principal, email: 'bday-principal@costa-ventures.com' } }, NOW, { counterpartBirthdate: `1979-${tomorrow.slice(5)}` });
    await db.query(`UPDATE commitments SET due_at = $2 WHERE principal_id = $1`, [world.principalId, new Date(NOW.getTime() + 20 * DAY_MS)]);
    expect((await runCycle(liveContext())).failures).toEqual([]);
    const ev = (await db.query(`SELECT id, payload FROM events WHERE principal_id = $1 AND event_type = 'PERSON_DATE_APPROACHING'`, [world.principalId])).rows[0];
    expect(ev.payload.days_until).toBe(1);
    const r = await insightFor(ev.id);
    expectRealClaude(r.calls);
    expect(cites(r.valid, 'person', world.counterpartId)).toBe(true);
    const draft = r.actions.find((a) => a.action_type === 'SEND_EMAIL');
    expect(draft?.state).toBe('AWAITING_APPROVAL');
    expect(draft?.content.to).toEqual([SCENARIO_B.counterpart.email]);
  }, LIVE_TIMEOUT);
});

describe('LIVE: persistent memory', () => {
  let world: BuiltWorld;
  let memoryId: string;

  it('a principal note becomes a grounded PREFERENCE memory about the right person', async () => {
    world = await buildWorld(db, { ...SCENARIO_A, key: 'mem', principal: { ...SCENARIO_A.principal, email: 'mem-principal@mendes-partners.com' } }, NOW);
    await db.query(`UPDATE commitments SET due_at = $2 WHERE principal_id = $1`, [world.principalId, new Date(NOW.getTime() + 20 * DAY_MS)]);
    const { event } = await ingestPrincipalNote(db, world.principalId, { text: 'Carlos prefere comunicações curtas e objetivas — no máximo três frases.', externalId: 'mem-note-1', at: NOW });
    expect((await runCycle(liveContext())).failures).toEqual([]);
    const mem = (await db.query(`SELECT * FROM memories WHERE principal_id = $1 AND kind = 'PREFERENCE' AND written_by = 'WENDY'`, [world.principalId])).rows;
    expect(mem).toHaveLength(1);
    expect(mem[0].subject_person_id).toBe(world.counterpartId);
    expect(mem[0].evidence).toEqual([{ kind: 'event', id: event.id }]);
    memoryId = mem[0].id;
  }, LIVE_TIMEOUT);

  it('after a restart, a question that depends on it is answered from the persisted memory (and Claude received it)', async () => {
    const restarted = t.reconnect();
    const r = await answerQuestion(liveContext(restarted), world.principalId, 'Como devo me comunicar com o Carlos?');
    console.log(`\nANSWER: ${r.answer}\n`);
    expect(r.evidenceSentToModel).toContainEqual({ kind: 'memory', id: memoryId });
    const call = (await restarted.query(`SELECT model, api_message_id, input_evidence_refs FROM model_calls WHERE id = $1`, [r.modelCallIds[1]])).rows[0];
    expect(call.model).toBe('claude-opus-5-5');
    expect(call.input_evidence_refs).toContainEqual({ kind: 'memory', id: memoryId });
    expect(r.answerValid).toBe(true);
    expect(r.claims.some((c) => c.valid && c.producedBy === 'CLAUDE' && c.evidence.some((e) => e.kind === 'memory' && e.id === memoryId))).toBe(true);
  }, LIVE_TIMEOUT);

  it('the remembered preference reaches the reasoning for a new email from that person', async () => {
    const { event } = await ingestInboundEmail(db, world.principalId, { ...urgentEmail(world, NOW), to: ['mem-principal@mendes-partners.com'] }, 'DEV_FIXTURE');
    expect((await runCycle(liveContext())).failures).toEqual([]);
    const r = await insightFor(event.id);
    expect(r.calls.find((c) => c.purpose === 'reason')!.input_evidence_refs).toContainEqual({ kind: 'memory', id: memoryId });
  }, LIVE_TIMEOUT);

  it('conflicting evidence is surfaced, not silently resolved', async () => {
    await db.query(
      `INSERT INTO memories(id, principal_id, kind, subject_person_id, content, confidence, status, evidence, written_by, created_at)
       VALUES (gen_random_uuid(), $1, 'PREFERENCE', $2, 'Carlos prefere e-mails longos e detalhados, com todo o contexto.', 1, 'ACTIVE', '[]', 'PRINCIPAL', now())`,
      [world.principalId, world.counterpartId],
    );
    const r = await answerQuestion(liveContext(), world.principalId, 'Como devo escrever para o Carlos?');
    console.log(`\nANSWER (conflict): ${r.answer}\n`);
    expect(r.conflicts.length).toBeGreaterThanOrEqual(1);
  }, LIVE_TIMEOUT);

  it('the ledger is intact after the whole live run', async () => {
    expect((await verifyLedgerIntegrity(db)).valid).toBe(true);
  });
});
