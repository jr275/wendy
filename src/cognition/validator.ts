/**
 * EVIDENCE VALIDATION. Claude reasons; the system decides whether the reasoning is supported.
 *
 * Rejects: unknown evidence handles (invented sources/records/events/people), claims with no
 * support, derivations from rejected or later claims, person references that are not people,
 * quotes that are not in the source text, impossible timestamps, actions targeting people who do
 * not exist or cannot be reached, and narrative sentences citing rejected claims.
 * FACT claims are never accepted from the model: they are generated here, by code, from records.
 */
import type { ClaimKind, EvidenceRef } from '../domain/types.js';
import type { EvidenceItem, EvidenceRegistry } from './context.js';
import type { Answer, Reasoning, Understanding } from './schemas.js';

export interface ValidatedClaim {
  ordinal: number;
  label: string;
  kind: ClaimKind;
  statement: string;
  confidence: number;
  evidence: (EvidenceRef & { handle: string })[];
  derivedFrom: number[];
  producedBy: 'CODE' | 'CLAUDE';
  valid: boolean;
  errors: string[];
}

export interface ValidatedAction {
  type: 'PREPARE_BRIEFING' | 'SEND_EMAIL';
  targetPersonId: string | null;
  relatedMeetingId: string | null;
  justificationOrdinals: number[];
  content: Record<string, unknown>;
}

export interface ValidationReport {
  claims: ValidatedClaim[];
  narrative: { text: string; valid: boolean; errors: string[] };
  urgency: { value: number; quotes: string[]; rationale: string } | null;
  urgencyErrors: string[];
  businessImpact: { value: number | null; rationale: string; evidence: string[]; errors: string[] };
  preferences: { memoryId: string; handle: string; effect: 'RAISE' | 'LOWER' }[];
  conflicts: { description: string; evidence: string[] }[];
  gaps: string[];
  completion: { status: string; evidence: string[]; valid: boolean };
  actions: ValidatedAction[];
  rejectedActions: { type: string; errors: string[] }[];
  memoryProposals: { kind: 'PREFERENCE' | 'FACT'; subjectPersonId: string | null; content: string; evidence: EvidenceRef[]; confidence: number }[];
  rejectedMemoryProposals: { content: string; errors: string[] }[];
  summary: { claimsTotal: number; claimsRejected: number; actionsRejected: number; memoryRejected: number };
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : NaN);
const FUTURE_TOLERANCE_MS = 5 * 60_000;

export function quoteInSource(quote: string, sourceText: string | null): boolean {
  if (!sourceText || !quote.trim()) return false;
  return norm(sourceText).includes(norm(quote));
}

/** Records that already happened (messages, events, memories) cannot be dated after `now`. */
function impossibleTimestamp(item: EvidenceItem, now: Date): boolean {
  if (!item.at) return false;
  const pastOnly = item.ref.kind === 'message' || item.ref.kind === 'event' || item.ref.kind === 'memory' || item.ref.kind === 'insight';
  return pastOnly && item.at.getTime() > now.getTime() + FUTURE_TOLERANCE_MS;
}

/** Drops understanding signals whose quotes are not in the text or whose dates are impossible. */
export function validateUnderstanding(u: Understanding, sourceText: string, occurredAt: Date): { understanding: Understanding; errors: string[] } {
  const errors: string[] = [];
  const keepQuoted = <T extends { quote: string }>(xs: T[], label: string) =>
    xs.filter((x) => {
      const ok = quoteInSource(x.quote, sourceText);
      if (!ok) errors.push(`${label}: quote not found in source: "${x.quote}"`);
      return ok;
    });
  const minDate = occurredAt.getTime() - 86_400_000;
  const maxDate = occurredAt.getTime() + 2 * 365 * 86_400_000;
  const timeRefs = keepQuoted(u.time_references, 'time_reference').map((t) => {
    if (t.resolved_iso == null) return t;
    const ms = Date.parse(t.resolved_iso);
    if (!Number.isFinite(ms) || ms < minDate || ms > maxDate) {
      errors.push(`time_reference: impossible or unparseable date "${t.resolved_iso}" dropped`);
      return { ...t, resolved_iso: null };
    }
    return t;
  });
  return {
    understanding: {
      ...u,
      requests: keepQuoted(u.requests, 'request'),
      time_references: timeRefs,
      urgency_signals: keepQuoted(u.urgency_signals, 'urgency_signal').map((s) => ({ ...s, strength: clamp01(s.strength) || 0 })),
    },
    errors,
  };
}

type ModelClaim = Reasoning['claims'][number];

/** Turns cited evidence into CODE-produced FACT claims, then checks every model claim against them. */
function validateClaims(modelClaims: ModelClaim[], extraFactHandles: string[], registry: EvidenceRegistry, now: Date): ValidatedClaim[] {
  const claims: ValidatedClaim[] = [];
  const factOrdinalByHandle = new Map<string, number>();

  const factFor = (handle: string): number | null => {
    const item = registry.get(handle);
    if (!item) return null;
    const existing = factOrdinalByHandle.get(item.handle);
    if (existing) return existing;
    const ordinal = claims.length + 1;
    const errors = impossibleTimestamp(item, now) ? [`impossible timestamp ${item.at?.toISOString()} for ${item.handle}`] : [];
    claims.push({
      ordinal,
      label: `F:${item.handle}`,
      kind: 'FACT',
      statement: item.text,
      confidence: 1,
      evidence: [{ ...item.ref, handle: item.handle }],
      derivedFrom: [],
      producedBy: 'CODE',
      valid: errors.length === 0,
      errors,
    });
    factOrdinalByHandle.set(item.handle, ordinal);
    return ordinal;
  };

  const handlesCited = new Set<string>(extraFactHandles.map((h) => h.trim()));
  for (const c of modelClaims) for (const h of c.evidence) handlesCited.add(h.trim());
  for (const h of handlesCited) factFor(h);

  const ordinalByLabel = new Map<string, number>();
  for (const c of modelClaims) {
    const errors: string[] = [];
    const label = c.id.trim();
    if (ordinalByLabel.has(label)) errors.push(`duplicate claim id ${label}`);

    const evidence: ValidatedClaim['evidence'] = [];
    const derivedFrom: number[] = [];
    for (const h of c.evidence) {
      const item = registry.get(h);
      if (!item) {
        errors.push(`unknown evidence handle "${h}"`);
        continue;
      }
      const factOrdinal = factOrdinalByHandle.get(item.handle)!;
      const fact = claims[factOrdinal - 1]!;
      if (!fact.valid) errors.push(`evidence ${item.handle} is invalid: ${fact.errors.join('; ')}`);
      evidence.push({ ...item.ref, handle: item.handle });
      derivedFrom.push(factOrdinal);
    }
    for (const d of c.derived_from) {
      const ord = ordinalByLabel.get(d.trim());
      if (ord === undefined) {
        errors.push(`derived_from "${d}" is not an earlier claim`);
        continue;
      }
      if (!claims[ord - 1]!.valid) errors.push(`derived_from ${d} was rejected`);
      derivedFrom.push(ord);
    }
    for (const p of c.about_people) {
      const item = registry.get(p);
      if (!item || item.ref.kind !== 'person') errors.push(`about_people "${p}" is not a known person`);
      else if (!evidence.some((e) => e.handle === item.handle)) {
        evidence.push({ ...item.ref, handle: item.handle });
        derivedFrom.push(factFor(item.handle)!);
      }
    }

    const confidence = clamp01(c.confidence);
    if (Number.isNaN(confidence)) errors.push('confidence is not a number');
    const hasEvidence = c.evidence.length > 0;
    const hasDerivation = c.derived_from.length > 0;
    if (c.kind === 'INFERENCE' && !hasEvidence) errors.push('INFERENCE must cite evidence');
    if ((c.kind === 'HYPOTHESIS' || c.kind === 'ANTICIPATION') && !hasEvidence && !hasDerivation) errors.push(`${c.kind} must cite evidence or earlier claims`);
    if (c.kind === 'RECOMMENDATION' && !hasDerivation) errors.push('RECOMMENDATION must derive from earlier claims');
    if (!c.statement.trim()) errors.push('empty statement');

    const ordinal = claims.length + 1;
    claims.push({
      ordinal,
      label,
      kind: c.kind,
      statement: c.statement.trim(),
      confidence: Number.isNaN(confidence) ? 0 : confidence,
      evidence,
      derivedFrom: [...new Set(derivedFrom)],
      producedBy: 'CLAUDE',
      valid: errors.length === 0,
      errors,
    });
    if (!ordinalByLabel.has(label)) ordinalByLabel.set(label, ordinal);
  }
  return claims;
}

function validateNarrative(text: string, claims: ValidatedClaim[]): ValidationReport['narrative'] {
  const errors: string[] = [];
  const refs = [...text.matchAll(/\[([^\]]+)\]/g)].flatMap((m) => m[1]!.split(/[,\s]+/).filter(Boolean));
  if (refs.length === 0) errors.push('narrative cites no claims');
  for (const r of refs) {
    const claim = claims.find((c) => c.producedBy === 'CLAUDE' && c.label === r);
    if (!claim) errors.push(`narrative cites unknown claim ${r}`);
    else if (!claim.valid) errors.push(`narrative cites rejected claim ${r}`);
  }
  return { text, valid: errors.length === 0, errors };
}

function handlesValid(handles: string[], registry: EvidenceRegistry, kinds?: string[]): string[] {
  return handles.filter((h) => {
    const item = registry.get(h);
    return !!item && (!kinds || kinds.includes(item.ref.kind));
  });
}

export function validateReasoning(args: {
  output: Reasoning;
  registry: EvidenceRegistry;
  sourceText: string | null;
  now: Date;
  reachablePersonIds: Set<string>;
}): ValidationReport {
  const { output, registry, sourceText, now } = args;
  const claims = validateClaims(output.claims, output.relevant_evidence.filter((h) => !!registry.get(h)), registry, now);
  const byLabel = (label: string) => claims.find((c) => c.producedBy === 'CLAUDE' && c.label === label.trim());

  // Urgency: only quotes that really occur in the source text count.
  const urgencyErrors: string[] = [];
  let urgency: ValidationReport['urgency'] = null;
  if (output.assessment.urgency) {
    const quotes = output.assessment.urgency.quotes.filter((q) => {
      const ok = quoteInSource(q, sourceText);
      if (!ok) urgencyErrors.push(`urgency quote not in source: "${q}"`);
      return ok;
    });
    const value = clamp01(output.assessment.urgency.value);
    if (quotes.length === 0 || Number.isNaN(value)) urgencyErrors.push('urgency has no verifiable quote; treated as 0');
    urgency = { value: quotes.length && !Number.isNaN(value) ? value : 0, quotes, rationale: output.assessment.urgency.rationale };
  }

  const biErrors: string[] = [];
  const biEvidence = handlesValid(output.assessment.business_impact.evidence, registry);
  const biValue = clamp01(output.assessment.business_impact.value);
  if (biEvidence.length === 0) biErrors.push('business impact cites no valid evidence; not scored');
  const businessImpact = {
    value: biEvidence.length && !Number.isNaN(biValue) ? biValue : null,
    rationale: output.assessment.business_impact.rationale,
    evidence: biEvidence,
    errors: biErrors,
  };

  const preferences = output.assessment.applicable_preferences.flatMap((p) => {
    const item = registry.get(p.memory);
    if (!item || item.ref.kind !== 'memory' || item.meta.memory_kind !== 'PREFERENCE') return [];
    return [{ memoryId: item.ref.id, handle: item.handle, effect: p.effect }];
  });

  const conflicts = output.conflicts
    .map((c) => ({ description: c.description, evidence: handlesValid(c.evidence, registry) }))
    .filter((c) => c.evidence.length >= 2);

  const completionEvidence = handlesValid(output.completion_assessment.evidence, registry);
  const completionNeedsEvidence = output.completion_assessment.status === 'DONE' || output.completion_assessment.status === 'POSSIBLY_DONE';
  const completion = {
    status: output.completion_assessment.status,
    evidence: completionEvidence,
    valid: !completionNeedsEvidence || completionEvidence.length > 0,
  };

  const actions: ValidatedAction[] = [];
  const rejectedActions: ValidationReport['rejectedActions'] = [];
  for (const a of output.proposed_actions) {
    const errors: string[] = [];
    const personItem = a.target_person ? registry.get(a.target_person) : undefined;
    if (a.target_person && (!personItem || personItem.ref.kind !== 'person')) errors.push(`target_person "${a.target_person}" is not a known person`);
    const meetingItem = a.related_meeting ? registry.get(a.related_meeting) : undefined;
    if (a.related_meeting && (!meetingItem || meetingItem.ref.kind !== 'meeting')) errors.push(`related_meeting "${a.related_meeting}" is not a known meeting`);
    if (meetingItem && meetingItem.meta.status === 'CANCELLED') errors.push(`related meeting ${meetingItem.handle} is CANCELLED`);

    const justification = a.justification_claims.map(byLabel);
    if (justification.length === 0) errors.push('action has no justification claims');
    if (justification.some((c) => !c || !c.valid)) errors.push('action justified by unknown or rejected claims');

    let content: Record<string, unknown> = {};
    if (a.type === 'SEND_EMAIL') {
      const to = a.email ? registry.get(a.email.to_person) : undefined;
      if (!a.email) errors.push('SEND_EMAIL without email content');
      else if (!to || to.ref.kind !== 'person') errors.push(`email recipient "${a.email.to_person}" is not a known person`);
      else if (!args.reachablePersonIds.has(to.ref.id)) errors.push(`recipient ${to.handle} has no known email address`);
      else {
        const emails = (to.meta.emails as string[]) ?? [];
        content = { to: [emails[0]], to_person_id: to.ref.id, subject: a.email.subject, body: a.email.body };
      }
    } else {
      if (!a.briefing) errors.push('PREPARE_BRIEFING without briefing content');
      else {
        for (const s of a.briefing.sections)
          for (const p of s.points) {
            for (const l of p.claims) if (!byLabel(l)?.valid) errors.push(`briefing point cites unknown/rejected claim ${l}`);
            for (const h of p.evidence) if (!registry.get(h)) errors.push(`briefing point cites unknown evidence ${h}`);
          }
        content = {
          title: a.briefing.title,
          sections: a.briefing.sections.map((s) => ({
            heading: s.heading,
            points: s.points.map((p) => ({ text: p.text, claims: p.claims.map((l) => byLabel(l)?.ordinal ?? null), evidence: p.evidence.map((h) => registry.get(h)?.ref ?? null) })),
          })),
        };
      }
    }

    if (errors.length) rejectedActions.push({ type: a.type, errors });
    else
      actions.push({
        type: a.type,
        targetPersonId: personItem?.ref.id ?? null,
        relatedMeetingId: meetingItem?.ref.id ?? null,
        justificationOrdinals: justification.map((c) => c!.ordinal),
        content,
      });
  }

  const memoryProposals: ValidationReport['memoryProposals'] = [];
  const rejectedMemoryProposals: ValidationReport['rejectedMemoryProposals'] = [];
  for (const m of output.memory_proposals) {
    const errors: string[] = [];
    const evidence = m.evidence.map((h) => registry.get(h)).filter((x): x is EvidenceItem => !!x);
    if (evidence.length === 0 || evidence.length !== m.evidence.length) errors.push('memory evidence missing or unknown');
    const subject = m.about_person ? registry.get(m.about_person) : undefined;
    if (m.about_person && (!subject || subject.ref.kind !== 'person')) errors.push(`about_person "${m.about_person}" is not a known person`);
    const confidence = clamp01(m.confidence);
    if (Number.isNaN(confidence)) errors.push('confidence is not a number');
    if (!m.content.trim()) errors.push('empty memory');
    if (errors.length) rejectedMemoryProposals.push({ content: m.content, errors });
    else memoryProposals.push({ kind: m.kind, subjectPersonId: subject?.ref.id ?? null, content: m.content.trim(), evidence: evidence.map((e) => e.ref), confidence });
  }

  return {
    claims,
    narrative: validateNarrative(output.narrative, claims),
    urgency,
    urgencyErrors,
    businessImpact,
    preferences,
    conflicts,
    gaps: output.information_gaps,
    completion,
    actions,
    rejectedActions,
    memoryProposals,
    rejectedMemoryProposals,
    summary: {
      claimsTotal: claims.length,
      claimsRejected: claims.filter((c) => !c.valid).length,
      actionsRejected: rejectedActions.length,
      memoryRejected: rejectedMemoryProposals.length,
    },
  };
}

/** Validation for direct answers (same claim rules, no actions). */
export function validateAnswer(output: Answer, registry: EvidenceRegistry, now: Date) {
  const claims = validateClaims(output.claims, output.used_evidence.filter((h) => !!registry.get(h)), registry, now);
  return {
    claims,
    narrative: validateNarrative(output.answer, claims),
    conflicts: output.conflicts.map((c) => ({ description: c.description, evidence: handlesValid(c.evidence, registry) })).filter((c) => c.evidence.length >= 2),
    gaps: output.information_gaps,
  };
}
