/**
 * PHASE 2 LIVE TESTS — real Claude (claude-opus-5-5), real Postgres, no test doubles.
 * Written ahead of the gate; they run only with ANTHROPIC_API_KEY and credit:
 *
 *   npm run test:live:phase2
 *
 * They assert structure and grounding (which records reached the model, what was cited, which
 * state transitions happened), never exact wording. Every scenario runs twice with a different
 * person, company, topic and language (metamorphic), so no code path can depend on a name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyLedgerIntegrity } from '../../src/audit/ledger.js';
import { answerQuestion } from '../../src/cognition/ask.js';
import { ClaudeReasoningClient, hasClaudeCredentials } from '../../src/cognition/llm.js';
import { loadEnv } from '../../src/config.js';
import type { Db } from '../../src/db/db.js';
import { ingestInboundEmail, ingestPrincipalNote } from '../../src/events/ingest.js';
import { MemoryService } from '../../src/memory/memoryService.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext, type WendyContext } from '../../src/runtime/context.js';
import { runCycle } from '../../src/runtime/worker.js';
import { DAY_MS, systemClock } from '../../src/util/clock.js';
import { buildWorld, SCENARIO_A, SCENARIO_B, urgentEmail, type BuiltWorld, type ScenarioParams } from '../../fixtures/world.js';
import { createTestDb } from '../helpers/db.js';

loadEnv();
const LIVE_TIMEOUT = 600_000;
const NOW = new Date();

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
const live = (pool: Db = db): WendyContext => createContext({ db: pool, reasoner: new ClaudeReasoningClient(pool), clock: systemClock, emailProvider: new DevMailboxProvider(pool) });

beforeAll(async () => {
  if (!hasClaudeCredentials()) throw new Error('LIVE TESTS REQUIRE Claude credentials (.env): ANTHROPIC_API_KEY, or CLAUDE_PROVIDER=vertex + GOOGLE_CLOUD_PROJECT. They are not skipped silently.');
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => {
  if (process.env.WENDY_KEEP_LIVE_SCHEMA) console.log(`kept schema ${t.schema}`);
  else await t?.drop();
});

/** Per-variant inputs: the same behavior is expected from both. */
interface Variant {
  label: string;
  scenario: ScenarioParams;
  /** An email in which the counterpart states a durable communication preference. */
  preferenceEmail: { subject: string; body: string };
  question: string;
  /** Two contradictory things the principal dictates about the counterpart. */
  notes: [string, string];
}

const VARIANTS: Variant[] = [
  {
    label: 'A · investor · English email, Portuguese principal',
    scenario: { ...SCENARIO_A, key: 'p2a', principal: { ...SCENARIO_A.principal, email: 'p2a@mendes-partners.com' } },
    preferenceEmail: {
      subject: 'A small request',
      body: 'João, one request going forward: please always send me bullet-point summaries instead of long emails. I read everything on my phone between meetings. Thanks, Carlos',
    },
    question: 'Como devo escrever para o Carlos?',
    notes: ['Carlos gosta de ligações rápidas em vez de e-mail.', 'Carlos não aceita ligações; só fala por e-mail.'],
  },
  {
    label: 'B · client · Portuguese email, other person and topic',
    scenario: { ...SCENARIO_B, key: 'p2b', principal: { ...SCENARIO_B.principal, email: 'p2b@costa-ventures.com' } },
    preferenceEmail: {
      subject: 'Pedido sobre os relatórios',
      body: 'Helena, a partir de agora prefiro receber os relatórios sempre em PDF anexado, nunca como link para pasta compartilhada — nossa política de TI bloqueia esses links. Obrigada, Ingrid',
    },
    question: 'How should I send documents to Ingrid?',
    notes: ['Ingrid prefere reuniões presenciais em Oslo.', 'Ingrid só faz reuniões por vídeo; nunca presenciais.'],
  },
];

const memoriesAbout = async (world: BuiltWorld, status?: string) =>
  (
    await db.query(`SELECT * FROM memories WHERE principal_id = $1 AND subject_person_id = $2 AND written_by = 'WENDY' ${status ? 'AND status = $3' : ''} ORDER BY created_at`, [
      world.principalId,
      world.counterpartId,
      ...(status ? [status] : []),
    ])
  ).rows;

for (const v of VARIANTS) {
  describe(`LIVE PHASE 2 — ${v.label}`, () => {
    let world: BuiltWorld;
    let proposedId: string;

    it('a preference the counterpart states in an email becomes a PROPOSED memory, grounded in that email', async () => {
      world = await buildWorld(db, v.scenario, NOW);
      // keep the commitment detector quiet so the run is about the email
      await db.query('UPDATE commitments SET due_at = $2 WHERE principal_id = $1', [world.principalId, new Date(NOW.getTime() + 30 * DAY_MS)]);
      const { messageId } = await ingestInboundEmail(
        db,
        world.principalId,
        { provider: 'DEV_FIXTURE_MAIL', externalId: `${v.scenario.key}-pref`, from: v.scenario.counterpart.email, to: [v.scenario.principal.email], subject: v.preferenceEmail.subject, body: v.preferenceEmail.body, sentAt: new Date(NOW.getTime() - 3600_000) },
        'DEV_FIXTURE',
      );
      expect((await runCycle(live())).failures).toEqual([]);
      const proposed = await memoriesAbout(world, 'PROPOSED');
      expect(proposed.length, 'Claude should propose at least one memory about the counterpart').toBeGreaterThanOrEqual(1);
      expect(await memoriesAbout(world, 'ACTIVE')).toHaveLength(0); // nothing deduced is active without the principal
      const grounded = proposed.find((m) => (m.evidence as { kind: string; id: string }[]).some((e) => e.kind === 'message' && e.id === messageId) || (m.evidence as { kind: string }[]).some((e) => e.kind === 'event'));
      expect(grounded, 'the proposed memory must cite the email (or its event)').toBeTruthy();
      proposedId = grounded!.id;
      console.log(`\nPROPOSED: ${grounded!.content}\n`);
    }, LIVE_TIMEOUT);

    it('a PROPOSED memory never reaches the model; after the principal confirms it, it does and is cited', async () => {
      const before = await answerQuestion(live(), world.principalId, v.question);
      expect(before.evidenceSentToModel).not.toContainEqual({ kind: 'memory', id: proposedId });

      await new MemoryService(db).confirm(world.principalId, proposedId, new Date());
      const after = await answerQuestion(live(t.reconnect()), world.principalId, v.question); // across a restart
      console.log(`\nANSWER (after confirmation): ${after.answer}\n`);
      expect(after.evidenceSentToModel).toContainEqual({ kind: 'memory', id: proposedId });
      expect(after.answerValid).toBe(true);
      expect(after.claims.some((c) => c.valid && c.producedBy === 'CLAUDE' && c.evidence.some((e) => e.kind === 'memory' && e.id === proposedId))).toBe(true);
    }, LIVE_TIMEOUT);

    it('derived relationship metrics (not typed by hand) are part of the person evidence the model receives', async () => {
      const { event } = await ingestInboundEmail(db, world.principalId, urgentEmail(world, NOW), 'DEV_FIXTURE');
      expect((await runCycle(live())).failures).toEqual([]);
      const insight = (await db.query('SELECT model_call_ids FROM insights WHERE event_id = $1', [event.id])).rows[0];
      const reason = (await db.query(`SELECT input FROM model_calls WHERE id = ANY($1::uuid[]) AND purpose = 'reason'`, [insight.model_call_ids])).rows[0];
      expect(reason.input.user).toMatch(/median reply time/);
      expect(reason.input.user).toMatch(/days since last contact/);
    }, LIVE_TIMEOUT);

    it('two contradictory dictated preferences become an OPEN conflict; after the principal picks one, only it reaches the model', async () => {
      for (const [i, text] of v.notes.entries()) await ingestPrincipalNote(db, world.principalId, { text, externalId: `${v.scenario.key}-note-${i}`, at: new Date() });
      expect((await runCycle(live())).failures).toEqual([]);
      const dictated = (
        await db.query(`SELECT id, content FROM memories WHERE principal_id = $1 AND subject_person_id = $2 AND status = 'ACTIVE' AND evidence @> '[{"kind":"event"}]'::jsonb AND written_by = 'WENDY' ORDER BY created_at DESC LIMIT 2`, [
          world.principalId,
          world.counterpartId,
        ])
      ).rows;
      expect(dictated, 'each note should become an ACTIVE memory').toHaveLength(2);

      const r = await answerQuestion(live(), world.principalId, v.question);
      console.log(`\nANSWER (conflict): ${r.answer}\n`);
      expect(r.conflicts.length).toBeGreaterThanOrEqual(1);
      const open = (await db.query(`SELECT id, memory_ids FROM memory_conflicts WHERE principal_id = $1 AND status = 'OPEN'`, [world.principalId])).rows;
      const conflict = open.find((c) => dictated.every((d) => (c.memory_ids as string[]).includes(d.id)));
      expect(conflict, 'the contradiction should be recorded between the two dictated memories').toBeTruthy();

      const [keep, drop] = [dictated[0]!.id, dictated[1]!.id];
      await new MemoryService(db).resolveConflict(world.principalId, conflict!.id, [keep], new Date());
      const again = await answerQuestion(live(), world.principalId, v.question);
      expect(again.evidenceSentToModel).toContainEqual({ kind: 'memory', id: keep });
      expect(again.evidenceSentToModel).not.toContainEqual({ kind: 'memory', id: drop });
    }, LIVE_TIMEOUT);

    // 3.3 (commitments extracted from messages) is NOT IMPLEMENTED yet: kept as a todo, never reported as passing.
    it.todo('a promise in an email ("I will send the proposal by Friday") becomes a PROPOSED commitment with a literal quote and a resolved due date');
  });
}

describe('LIVE PHASE 2 — integrity', () => {
  it('the ledger is intact after the whole run', async () => {
    expect((await verifyLedgerIntegrity(db)).valid).toBe(true);
  });
});
