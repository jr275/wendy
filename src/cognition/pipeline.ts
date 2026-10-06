/**
 * THE COGNITIVE LOOP for one event:
 *
 *   EVENT → NORMALIZATION (focus from persisted state, stale check) → UNDERSTANDING (Claude)
 *   → ENTITY RESOLUTION → CONTEXT RETRIEVAL (memory, relationships, history, meetings, commitments)
 *   → REASONING (Claude) → VALIDATION → SALIENCE → PROACTIVE INSIGHT → ACTION (policy) → PERSISTENCE
 *
 * Everything decided here is persisted in one transaction together with the event's status, so a
 * crash either leaves the event to be retried or fully processed — never half-applied.
 */
import { appendAudit } from '../audit/ledger.js';
import { proposeAction, type ActionType } from '../actions/actions.js';
import { withTx, type Queryable, type Tx } from '../db/db.js';
import type { EvidenceRef, Person, Principal, WendyEvent } from '../domain/types.js';
import type { WendyContext } from '../runtime/context.js';
import { DAY_MS, HOUR_MS } from '../util/clock.js';
import { hashOf, newId } from '../util/hash.js';
import { renderEvidence, renderMessage, renderCommitment, retrieveContext, type ContextBundle } from './context.js';
import { personDateFacts } from './detectors.js';
import { resolveMentions, type Mention } from './entityResolution.js';
import { describeTime, REASON_SYSTEM, UNDERSTAND_SYSTEM } from './prompts.js';
import { renderInsight } from './render.js';
import { computeSalience, type SalienceResult } from './salience.js';
import { ReasoningSchema, UnderstandingSchema, type Reasoning, type Understanding } from './schemas.js';
import { validateReasoning, validateUnderstanding, type ValidationReport } from './validator.js';

export type PipelineOutcome =
  | { status: 'PROCESSED'; eventId: string; insightId: string; insightStatus: string; actionIds: string[] }
  | { status: 'SKIPPED'; eventId: string; reason: string };

interface Focus {
  sourceText: string | null;
  sourceKind: 'TEXT' | 'STATE';
  eventText: string;
  personIds: string[];
  mentions: Mention[];
  extraRefs: { ref: EvidenceRef; at: Date | null; text: string; meta?: Record<string, unknown> }[];
  deadlines: { at: Date; basis: string }[];
  defaultExpiry: Date | null;
}

export class StaleContextError extends Error {}

const SKIP = (reason: string) => ({ skip: reason }) as const;

async function addressesOf(q: Queryable, principalId: string, personId: string): Promise<string[]> {
  return (await q.query<{ value: string }>(`SELECT value FROM person_identifiers WHERE principal_id = $1 AND person_id = $2 AND kind='email'`, [principalId, personId])).rows.map((r) => r.value);
}

/** Builds the focus of an event from *current* persisted state; detects stale events. */
async function buildFocus(ctx: WendyContext, principal: Principal, event: WendyEvent, now: Date): Promise<Focus | { skip: string }> {
  const { db, repos } = ctx;
  const p = event.payload;
  switch (event.event_type) {
    case 'EMAIL_RECEIVED': {
      const message = await repos.messages.get(db, principal.id, String(p.message_id));
      if (!message) return SKIP('message no longer exists');
      const sender = await repos.entities.findPersonByIdentifier(db, principal.id, 'email', message.from_address);
      const names = new Map<string, string>([[principal.primary_email, `${principal.display_name} (principal)`]]);
      if (sender) names.set(message.from_address, sender.full_name);
      return {
        sourceText: `Subject: ${message.subject}\n\n${message.body}`,
        sourceKind: 'TEXT',
        eventText: `EMAIL_RECEIVED\n${renderMessage(message, names)}${sender ? '' : '\n(sender is not a known contact)'}`,
        personIds: sender ? [sender.id] : [],
        mentions: [],
        extraRefs: [],
        deadlines: [],
        defaultExpiry: new Date(now.getTime() + 3 * DAY_MS),
      };
    }
    case 'COMMITMENT_DUE': {
      const c = await repos.commitments.get(db, principal.id, String(p.commitment_id));
      if (!c) return SKIP('commitment no longer exists');
      if (c.status !== 'OPEN') return SKIP(`commitment is ${c.status} (stale event)`);
      if (c.due_at.toISOString() !== p.due_at) return SKIP('commitment due date changed (stale event)');
      const counterparty = await repos.entities.getPerson(db, principal.id, c.counterparty_person_id);
      const outbound = await repos.messages.outboundToPersonSince(db, principal.id, c.counterparty_person_id, c.created_at);
      const names = new Map<string, string>([[principal.primary_email, `${principal.display_name} (principal)`]]);
      if (counterparty) for (const a of await addressesOf(db, principal.id, counterparty.id)) names.set(a, counterparty.full_name);
      const hours = (c.due_at.getTime() - now.getTime()) / HOUR_MS;
      return {
        sourceText: null,
        sourceKind: 'STATE',
        eventText: `COMMITMENT_DUE (computed by detector from persisted state)\n${renderCommitment(c, counterparty?.full_name ?? 'unknown person')}\nhours until due: ${hours.toFixed(1)}\noutbound messages to the counterparty since the commitment was recorded: ${outbound.length} (listed as evidence)`,
        personIds: [c.counterparty_person_id],
        mentions: [],
        extraRefs: [
          { ref: { kind: 'commitment', id: c.id }, at: c.due_at, text: renderCommitment(c, counterparty?.full_name ?? 'unknown person'), meta: { status: c.status, due_at: c.due_at.toISOString() } },
          ...outbound.map((m) => ({ ref: { kind: 'message' as const, id: m.id }, at: m.sent_at, text: renderMessage(m, names), meta: { direction: m.direction } })),
        ],
        deadlines: [{ at: c.due_at, basis: 'prazo do compromisso' }],
        defaultExpiry: new Date(c.due_at.getTime() + DAY_MS),
      };
    }
    case 'PERSON_DATE_APPROACHING': {
      const person = await repos.entities.getPerson(db, principal.id, String(p.person_id));
      if (!person) return SKIP('person no longer exists');
      const facts = personDateFacts(person, principal, now);
      if (!facts || facts.occursOn !== p.occurs_on) return SKIP('person date changed (stale event)');
      const occursAt = new Date(`${facts.occursOn}T12:00:00Z`);
      return {
        sourceText: null,
        sourceKind: 'STATE',
        eventText: `PERSON_DATE_APPROACHING (computed by detector from persisted state)\nperson: ${person.full_name}\ndate kind: ${facts.kind}\nrecorded birthdate: ${person.birthdate}\nnext occurrence: ${facts.occursOn} (in ${facts.daysUntil} day(s); principal's local date today: ${facts.today})`,
        personIds: [person.id],
        mentions: [],
        extraRefs: [],
        deadlines: [{ at: occursAt, basis: 'data da pessoa' }],
        defaultExpiry: new Date(occursAt.getTime() + 12 * HOUR_MS),
      };
    }
    case 'PRINCIPAL_NOTE': {
      const text = String(p.text ?? '');
      return {
        sourceText: text,
        sourceKind: 'TEXT',
        eventText: `PRINCIPAL_NOTE (written by the principal at ${event.occurred_at.toISOString()})\n${text}`,
        personIds: [],
        mentions: [],
        extraRefs: [],
        deadlines: [],
        defaultExpiry: new Date(now.getTime() + 3 * DAY_MS),
      };
    }
    default:
      return SKIP(`no handler for event type ${event.event_type}`);
  }
}

async function understand(ctx: WendyContext, principal: Principal, event: WendyEvent, sourceText: string): Promise<{ understanding: Understanding; errors: string[]; modelCallId: string }> {
  const user = [
    `Principal: ${principal.display_name} <${principal.primary_email}>, time zone ${principal.timezone}.`,
    `Text timestamp: ${describeTime(event.occurred_at, principal.timezone)}`,
    `Text type: ${event.event_type}`,
    '',
    '<text>',
    sourceText,
    '</text>',
  ].join('\n');
  const { output, modelCallId } = await ctx.reasoner.generate({
    purpose: 'understand',
    principalId: principal.id,
    system: UNDERSTAND_SYSTEM,
    user,
    schema: UnderstandingSchema,
    effort: 'medium',
    evidenceRefs: [{ kind: 'event', id: event.id }],
  });
  const v = validateUnderstanding(output, sourceText, event.occurred_at);
  return { understanding: v.understanding, errors: v.errors, modelCallId };
}

async function reason(ctx: WendyContext, principal: Principal, event: WendyEvent, now: Date, bundle: ContextBundle, focus: Focus, understanding: Understanding | null, unresolved: string[]) {
  const user = [
    `Principal: ${principal.display_name} <${principal.primary_email}>. Principal's language: ${principal.locale}.`,
    `Current time: ${describeTime(now, principal.timezone)}`,
    `Event handle: [${bundle.eventHandle}]. People in focus: ${bundle.focusPeople.map((h) => `[${h}]`).join(', ') || 'none resolved'}.`,
    focus.sourceText ? `Event source text (quotes for urgency must come from here):\n<source>\n${focus.sourceText}\n</source>` : 'This event has no source text (derived from persisted state).',
    understanding ? `Validated understanding of the source text:\n${JSON.stringify(understanding, null, 2)}` : '',
    unresolved.length ? `Mentioned but not resolved to a known person: ${unresolved.join('; ')}` : '',
    '',
    'Evidence:',
    renderEvidence(bundle.registry),
  ]
    .filter((l) => l !== '')
    .join('\n');

  return ctx.reasoner.generate<Reasoning>({
    purpose: 'reason',
    principalId: principal.id,
    system: REASON_SYSTEM,
    user,
    schema: ReasoningSchema,
    effort: 'high',
    evidenceRefs: bundle.registry.refs(),
  });
}

const REF_TABLES: Partial<Record<EvidenceRef['kind'], string>> = {
  event: 'events',
  message: 'messages',
  meeting: 'meetings',
  commitment: 'commitments',
  memory: 'memories',
  person: 'people',
  relationship: 'relationships',
  insight: 'insights',
  action: 'actions',
};

/** Inside the persisting transaction: every cited record must still exist for this principal. */
async function assertRefsExist(tx: Tx, principalId: string, refs: EvidenceRef[]): Promise<void> {
  const byKind = new Map<string, Set<string>>();
  for (const r of refs) byKind.set(r.kind, (byKind.get(r.kind) ?? new Set()).add(r.id));
  for (const [kind, ids] of byKind) {
    const table = REF_TABLES[kind as EvidenceRef['kind']];
    if (!table) throw new StaleContextError(`unknown evidence kind ${kind}`);
    const found = (await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE principal_id = $1 AND id = ANY($2::uuid[])`, [principalId, [...ids]])).rows[0]!;
    if (Number(found.n) !== ids.size) throw new StaleContextError(`cited ${kind} records changed or disappeared during processing`);
  }
}

function meetingDeadlines(report: ValidationReport, bundle: ContextBundle, now: Date): { at: Date; basis: string }[] {
  const out: { at: Date; basis: string }[] = [];
  for (const c of report.claims.filter((c) => c.valid && c.producedBy === 'CLAUDE'))
    for (const e of c.evidence) {
      const item = bundle.registry.get(e.handle);
      if (item?.ref.kind === 'meeting' && item.meta.status !== 'CANCELLED' && item.at && item.at > now) out.push({ at: item.at, basis: 'reunião relacionada' });
    }
  return out;
}

export async function processEvent(ctx: WendyContext, event: WendyEvent): Promise<PipelineOutcome> {
  const { db, repos } = ctx;
  const now = ctx.clock.now();
  const principal = await repos.entities.getPrincipal(db, event.principal_id);
  if (!principal) throw new Error(`principal ${event.principal_id} not found`);

  const focus = await buildFocus(ctx, principal, event, now);
  if ('skip' in focus) {
    await repos.events.markDone(db, event.id, 'SKIPPED', focus.skip);
    return { status: 'SKIPPED', eventId: event.id, reason: focus.skip };
  }

  const modelCallIds: string[] = [];
  let understanding: Understanding | null = null;
  let understandingErrors: string[] = [];
  if (focus.sourceText) {
    const u = await understand(ctx, principal, event, focus.sourceText);
    understanding = u.understanding;
    understandingErrors = u.errors;
    modelCallIds.push(u.modelCallId);
    focus.mentions = understanding.mentioned_people.map((m) => ({ name: m.name, email: m.email }));
    for (const t of understanding.time_references) if (t.resolved_iso) focus.deadlines.push({ at: new Date(t.resolved_iso), basis: `prazo citado: "${t.quote}"` });
  }

  const resolution = await resolveMentions(db, repos, principal.id, focus.mentions);
  const personIds = [...new Set([...focus.personIds, ...resolution.resolved.map((r) => r.personId)])];
  const unresolved = [
    ...resolution.unresolved.map((m) => m.name ?? m.email ?? '?'),
    ...resolution.ambiguous.map((a) => `${a.mention.name} (ambiguous: ${a.candidateIds.length} candidates)`),
  ];

  const bundle = await retrieveContext(db, repos, {
    principal,
    event,
    now,
    asOf: now,
    focusPersonIds: personIds,
    searchTerms: understanding?.topics.flatMap((t) => [t.label, ...t.search_terms]) ?? [],
    eventText: focus.eventText,
    sourceText: focus.sourceText,
    extraRefs: focus.extraRefs,
  });

  const reasoning = await reason(ctx, principal, event, now, bundle, focus, understanding, unresolved);
  modelCallIds.push(reasoning.modelCallId);

  const reachable = new Set(
    bundle.registry
      .items()
      .filter((i) => i.ref.kind === 'person' && Array.isArray(i.meta.emails) && (i.meta.emails as string[]).length > 0)
      .map((i) => i.ref.id),
  );
  const report = validateReasoning({ output: reasoning.output, registry: bundle.registry, sourceText: focus.sourceText, now, reachablePersonIds: reachable });

  const primary = personIds[0] ?? null;
  let relationshipInput: Parameters<typeof computeSalience>[0]['relationship'] = null;
  if (primary) {
    const rel = await repos.relationships.getRelationship(db, principal.id, primary);
    const stats = await repos.relationships.interactionStats(db, principal.id, primary, new Date(now.getTime() - 90 * DAY_MS));
    relationshipInput = rel || stats.count ? { explicitImportance: rel?.explicit_importance ?? null, interactions90d: stats.count, lastInteractionAt: stats.lastAt } : null;
  }
  const salience = computeSalience({
    relationship: relationshipInput,
    deadlines: [...focus.deadlines, ...meetingDeadlines(report, bundle, now)],
    now,
    priorSimilarInsights: bundle.registry.items().filter((i) => i.ref.kind === 'insight').length,
    validation: report,
    sourceKind: focus.sourceKind,
  });

  const validClaude = report.claims.filter((c) => c.producedBy === 'CLAUDE' && c.valid).length;
  const insightStatus = validClaude === 0 ? 'REJECTED_BY_VALIDATION' : salience.surfaced ? 'SURFACED' : 'SUPPRESSED';

  try {
    return await withTx(db, async (tx) => persist(tx, { ctx, principal, event, now, bundle, focus, understanding, understandingErrors, resolution, reasoning: reasoning.output, report, salience, insightStatus, modelCallIds }));
  } catch (err) {
    if ((err as { code?: string }).code === '23505' && (err as { constraint?: string }).constraint === 'insights_event_id_key') {
      const existing = (await db.query<{ id: string; status: string }>('SELECT id, status FROM insights WHERE event_id = $1', [event.id])).rows[0]!;
      return { status: 'PROCESSED', eventId: event.id, insightId: existing.id, insightStatus: existing.status, actionIds: [] };
    }
    throw err;
  }
}

async function persist(
  tx: Tx,
  a: {
    ctx: WendyContext;
    principal: Principal;
    event: WendyEvent;
    now: Date;
    bundle: ContextBundle;
    focus: Focus;
    understanding: Understanding | null;
    understandingErrors: string[];
    resolution: Awaited<ReturnType<typeof resolveMentions>>;
    reasoning: Reasoning;
    report: ValidationReport;
    salience: SalienceResult;
    insightStatus: string;
    modelCallIds: string[];
  },
): Promise<PipelineOutcome> {
  const { principal, event, report, bundle } = a;
  const validRefs = report.claims.filter((c) => c.valid).flatMap((c) => c.evidence.map(({ kind, id }) => ({ kind, id })));
  await assertRefsExist(tx, principal.id, validRefs);

  const insightId = newId();
  const validation = {
    understandingErrors: a.understandingErrors,
    resolution: a.resolution,
    narrative: { valid: report.narrative.valid, errors: report.narrative.errors },
    urgency: report.urgency,
    urgencyErrors: report.urgencyErrors,
    businessImpact: report.businessImpact,
    preferences: report.preferences,
    conflicts: report.conflicts,
    gaps: report.gaps,
    completion: report.completion,
    rejectedActions: report.rejectedActions,
    rejectedMemoryProposals: report.rejectedMemoryProposals,
    summary: report.summary,
  };
  await tx.query(
    `INSERT INTO insights(id, principal_id, event_id, correlation_id, status, headline, narrative, rendered, salience, validation, understanding, evidence_map, model_call_ids, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'',$8,$9,$10,$11,$12,$13)`,
    [
      insightId,
      principal.id,
      event.id,
      event.correlation_id,
      a.insightStatus,
      a.reasoning.headline,
      report.narrative.valid ? report.narrative.text : null,
      JSON.stringify(a.salience),
      JSON.stringify(validation),
      a.understanding ? JSON.stringify(a.understanding) : null,
      JSON.stringify(bundle.registry.toJSON()),
      a.modelCallIds,
      a.now,
    ],
  );
  for (const c of report.claims) {
    await tx.query(
      `INSERT INTO claims(id, insight_id, ordinal, label, kind, statement, confidence, evidence, derived_from, produced_by, validation_status, validation_errors)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [newId(), insightId, c.ordinal, c.label, c.kind, c.statement, c.confidence, JSON.stringify(c.evidence), c.derivedFrom, c.producedBy, c.valid ? 'VALID' : 'REJECTED', JSON.stringify(c.errors)],
    );
  }

  const actionIds: string[] = [];
  if (a.insightStatus !== 'REJECTED_BY_VALIDATION') {
    for (const act of report.actions) {
      const meetingStart = act.relatedMeetingId ? bundle.registry.get(bundle.registry.handleFor({ kind: 'meeting', id: act.relatedMeetingId })!)?.at : null;
      const expiresAt = act.type === 'SEND_EMAIL' ? (meetingStart ?? a.focus.defaultExpiry) : null;
      const row = await proposeAction(tx, {
        principalId: principal.id,
        insightId,
        type: act.type as ActionType,
        targetPersonId: act.targetPersonId,
        content: { ...act.content, justification_claims: act.justificationOrdinals, related_meeting_id: act.relatedMeetingId },
        expiresAt,
      });
      actionIds.push(row.id);
    }
    for (const m of report.memoryProposals) {
      const mem = await a.ctx.repos.memories.write(tx, {
        principalId: principal.id,
        kind: m.kind,
        subjectPersonId: m.subjectPersonId,
        content: m.content,
        confidence: m.confidence,
        evidence: m.evidence,
        writtenBy: 'WENDY',
        createdAt: a.now,
      });
      await appendAudit(tx, { principalId: principal.id, eventType: 'MEMORY_WRITTEN', actor: 'WENDY', subjectType: 'memory', subjectId: mem.id, payload: { kind: m.kind, evidence: m.evidence, contentHash: hashOf(m.content), insightId } });
    }
  }

  const rendered = await renderInsight(tx, insightId);
  await tx.query('UPDATE insights SET rendered = $2 WHERE id = $1', [insightId, rendered]);
  await appendAudit(tx, {
    principalId: principal.id,
    eventType: 'INSIGHT_RECORDED',
    actor: 'WENDY',
    subjectType: 'insight',
    subjectId: insightId,
    payload: { eventId: event.id, status: a.insightStatus, salience: a.salience.score, claims: report.summary, actionIds, modelCallIds: a.modelCallIds },
  });
  await a.ctx.repos.events.markDone(tx, event.id, 'PROCESSED');
  return { status: 'PROCESSED', eventId: event.id, insightId, insightStatus: a.insightStatus, actionIds };
}

export type { Person };
