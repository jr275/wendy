/**
 * Answering a direct question from the principal, grounded in persisted memory and records.
 * Same loop as events: understand → resolve → retrieve → reason → validate.
 */
import type { EvidenceRef } from '../domain/types.js';
import type { WendyContext } from '../runtime/context.js';
import { hashOf } from '../util/hash.js';
import { renderEvidence, retrieveContext } from './context.js';
import { resolveMentions } from './entityResolution.js';
import { ANSWER_SYSTEM, describeTime, UNDERSTAND_SYSTEM } from './prompts.js';
import { AnswerSchema, UnderstandingSchema } from './schemas.js';
import { validateAnswer, validateUnderstanding } from './validator.js';
import type { WendyEvent } from '../domain/types.js';
import { ingestEvent } from '../events/ingest.js';
import { withTx } from '../db/db.js';
import { MemoryService } from '../memory/memoryService.js';

export interface AnswerResult {
  answer: string;
  answerValid: boolean;
  claims: ReturnType<typeof validateAnswer>['claims'];
  conflicts: { description: string; evidence: string[] }[];
  gaps: string[];
  evidenceSentToModel: EvidenceRef[];
  modelCallIds: string[];
  eventId: string;
}

export async function answerQuestion(ctx: WendyContext, principalId: string, question: string): Promise<AnswerResult> {
  const { db, repos } = ctx;
  const now = ctx.clock.now();
  const principal = await repos.entities.getPrincipal(db, principalId);
  if (!principal) throw new Error('unknown principal');

  // The question itself is recorded as an event, so the answer's evidence chain has a source.
  const { event } = await ingestEvent(db, {
    principalId,
    eventType: 'PRINCIPAL_QUESTION',
    source: 'PRINCIPAL',
    sourceEventKey: `question:${hashOf({ question, at: now.toISOString() })}`,
    occurredAt: now,
    actor: { kind: 'PRINCIPAL' },
    entityRefs: [],
    payload: { text: question },
    confidence: 1,
    provenance: { origin: 'PRINCIPAL' },
    initialStatus: 'PROCESSED',
  });

  const u = await ctx.reasoner.generate({
    purpose: 'understand-question',
    principalId,
    system: UNDERSTAND_SYSTEM,
    user: `Principal: ${principal.display_name}, time zone ${principal.timezone}.\nText timestamp: ${describeTime(now, principal.timezone)}\nText type: question from the principal\n\n<text>\n${question}\n</text>`,
    schema: UnderstandingSchema,
    effort: 'low',
    evidenceRefs: [{ kind: 'event', id: event.id }],
  });
  const understanding = validateUnderstanding(u.output, question, now).understanding;
  const resolution = await resolveMentions(db, repos, principalId, understanding.mentioned_people.map((m) => ({ name: m.name, email: m.email })));

  const bundle = await retrieveContext(db, repos, {
    principal,
    event: event as WendyEvent,
    now,
    asOf: now,
    focusPersonIds: [...resolution.resolved.map((r) => r.personId), ...resolution.ambiguous.flatMap((a) => a.candidateIds)],
    searchTerms: understanding.topics.flatMap((t) => [t.label, ...t.search_terms]),
    eventText: `Question from the principal at ${now.toISOString()}: ${question}`,
    sourceText: question,
  });

  const r = await ctx.reasoner.generate({
    purpose: 'answer',
    principalId,
    system: ANSWER_SYSTEM,
    user: [
      `Principal: ${principal.display_name}. Principal's language: ${principal.locale}.`,
      `Current time: ${describeTime(now, principal.timezone)}`,
      `Question [${bundle.eventHandle}]: ${question}`,
      resolution.ambiguous.length ? `Ambiguous names: ${resolution.ambiguous.map((a) => a.mention.name).join(', ')}` : '',
      '',
      'Evidence:',
      renderEvidence(bundle.registry),
    ]
      .filter(Boolean)
      .join('\n'),
    schema: AnswerSchema,
    effort: 'medium',
    evidenceRefs: bundle.registry.refs(),
  });

  const v = validateAnswer(r.output, bundle.registry, now);
  for (const c of v.conflicts) {
    const memoryIds = c.evidence.map((h) => bundle.registry.get(h)).filter((i) => i?.ref.kind === 'memory').map((i) => i!.ref.id);
    if (memoryIds.length >= 2) await withTx(db, (tx) => new MemoryService(db).recordConflict(tx, principalId, memoryIds, c.description, { kind: 'question', id: event.id }, now));
  }
  return {
    answer: v.narrative.valid ? r.output.answer : v.claims.filter((c) => c.valid && c.producedBy === 'CLAUDE').map((c) => c.statement).join(' '),
    answerValid: v.narrative.valid,
    claims: v.claims,
    conflicts: v.conflicts,
    gaps: v.gaps,
    evidenceSentToModel: bundle.registry.refs(),
    modelCallIds: [u.modelCallId, r.modelCallId],
    eventId: event.id,
  };
}
