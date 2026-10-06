/**
 * Builds a SAMPLE schema for the inspector using the scripted TEST DOUBLE (NOT Claude).
 * It exercises the real mechanics (ingestion, detectors, retrieval, validation, salience, policy,
 * execution, ledger) so the inspector has something to show before live Claude runs exist.
 * Every model-produced sentence is prefixed "(SUBSTITUTO DE TESTE)" and every model call is
 * recorded as model TEST_DOUBLE.
 *   npm run inspector:sample
 */
import type { ReasoningRequest } from '../src/cognition/llm.js';
import { databaseUrl, loadEnv } from '../src/config.js';
import { createPool, migrate } from '../src/db/db.js';
import { ingestInboundEmail } from '../src/events/ingest.js';
import { DevMailboxProvider } from '../src/providers/devMailbox.js';
import { createContext } from '../src/runtime/context.js';
import { runCycle } from '../src/runtime/worker.js';
import { DAY_MS, systemClock } from '../src/util/clock.js';
import { buildWorld, SCENARIO_A, SCENARIO_B, urgentEmail } from '../fixtures/world.js';
import { emptyUnderstanding, handlesIn, minimalReasoning, ScriptedReasoner } from '../tests/helpers/scriptedReasoner.js';

loadEnv();
const SCHEMA = 'sample_test_double';
const TAG = '(SUBSTITUTO DE TESTE)';

const admin = createPool(databaseUrl());
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
await admin.end();
const db = createPool(databaseUrl(), SCHEMA);
await migrate(db);

/** Cites whatever real evidence the prompt contains; never decides anything semantically. */
const reasoner = new ScriptedReasoner(db, {
  understand: () => emptyUnderstanding({ summary: `${TAG} sem entendimento real` }),
  reason: (req: ReasoningRequest<unknown>) => {
    // Only the event whose OWN source text is the 'invented' sample (not history that mentions it).
    const invent = req.user.includes('<source>\nSubject: sample-invented');
    if (invent) {
      return minimalReasoning({
        headline: `${TAG} raciocínio com evidência inventada`,
        narrative: `${TAG} cita um e-mail que não existe [C1].`,
        claims: [{ id: 'C1', kind: 'INFERENCE', statement: `${TAG} afirmação apoiada em evidência inexistente`, confidence: 0.9, evidence: ['M404'], derived_from: [], about_people: ['P99'] }],
      });
    }
    const e = handlesIn(req.user, 'E')[0]!;
    const p = handlesIn(req.user, 'P')[0];
    const ms = handlesIn(req.user, 'M').slice(0, 2);
    const mt = handlesIn(req.user, 'MT')[0];
    const c = handlesIn(req.user, 'C')[0];
    const evidence = [e, ...ms, ...(mt ? [mt] : []), ...(c ? [c] : [])];
    return minimalReasoning({
      relevant_evidence: evidence,
      headline: `${TAG} insight de demonstração da mecânica`,
      narrative: `${TAG} Inferência de exemplo [C1]. Antecipação de exemplo [C2]. Recomendação de exemplo [C3].`,
      claims: [
        { id: 'C1', kind: 'INFERENCE', statement: `${TAG} inferência ligada às evidências citadas`, confidence: 0.7, evidence, derived_from: [], about_people: p ? [p] : [] },
        { id: 'C2', kind: 'ANTICIPATION', statement: `${TAG} antecipação derivada da inferência`, confidence: 0.6, evidence: [], derived_from: ['C1'], about_people: [] },
        { id: 'C3', kind: 'RECOMMENDATION', statement: `${TAG} recomendação derivada da antecipação`, confidence: 0.6, evidence: [], derived_from: ['C2'], about_people: [] },
        { id: 'C4', kind: 'INFERENCE', statement: `${TAG} esta afirmação cita uma reunião inexistente e deve ser rejeitada`, confidence: 0.9, evidence: ['MT77'], derived_from: [], about_people: [] },
      ],
      assessment: { urgency: null, business_impact: { value: 0.8, rationale: `${TAG} valor fixo do substituto`, evidence: [e] }, applicable_preferences: [] },
      proposed_actions: p
        ? [
            { type: 'PREPARE_BRIEFING', target_person: p, related_meeting: mt ?? null, justification_claims: ['C1'], briefing: { title: `${TAG} briefing de exemplo`, sections: [{ heading: 'Contexto', points: [{ text: `${TAG} ponto`, claims: ['C1'], evidence: [e] }] }] }, email: null },
            { type: 'SEND_EMAIL', target_person: p, related_meeting: null, justification_claims: ['C3'], briefing: null, email: { to_person: p, subject: `${TAG} rascunho`, body: `${TAG} corpo do rascunho` } },
          ]
        : [],
    });
  },
});

const now = new Date();
const tz = SCENARIO_A.principal.timezone;
const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now.getTime() + DAY_MS));
const a = await buildWorld(db, SCENARIO_A, now, { counterpartBirthdate: `1980-${tomorrow.slice(5)}` });
const b = await buildWorld(db, SCENARIO_B, now);
await ingestInboundEmail(db, a.principalId, urgentEmail(a, now), 'DEV_FIXTURE');
await ingestInboundEmail(db, b.principalId, urgentEmail(b, now), 'DEV_FIXTURE');
await ingestInboundEmail(db, a.principalId, { ...urgentEmail(a, now), externalId: 'sample-invented', subject: 'sample-invented', body: 'Mensagem usada para demonstrar a rejeição de evidência inventada.' }, 'DEV_FIXTURE');
await ingestInboundEmail(db, a.principalId, { ...urgentEmail(a, now), externalId: 'sample-unknown', from: 'stranger@unknown.example', subject: 'Olá', body: 'Remetente desconhecido.' }, 'DEV_FIXTURE');

const report = await runCycle(createContext({ db, reasoner, clock: systemClock, emailProvider: new DevMailboxProvider(db) }));
console.log(`schema ${SCHEMA}: ${report.outcomes.length} eventos processados, ${report.failures.length} falhas, ${report.executed.length} execuções (TEST_DOUBLE — não é o Claude)`);
await db.end();
