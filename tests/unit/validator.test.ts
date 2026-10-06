import { describe, expect, it } from 'vitest';
import { EvidenceRegistry } from '../../src/cognition/context.js';
import { computeSalience, timeSensitivity } from '../../src/cognition/salience.js';
import { validateReasoning, validateUnderstanding } from '../../src/cognition/validator.js';
import { emptyUnderstanding, minimalReasoning } from '../helpers/scriptedReasoner.js';

const now = new Date('2026-10-06T12:00:00Z');
const SOURCE = 'Subject: Budget\n\nWe must decide the budget before Friday. This is urgent.';

function registry() {
  const r = new EvidenceRegistry();
  r.add({ kind: 'event', id: '00000000-0000-0000-0000-0000000000e1' }, now, 'event');
  r.add({ kind: 'person', id: '00000000-0000-0000-0000-0000000000a1' }, null, 'person A', { full_name: 'A', emails: ['a@x.test'] });
  r.add({ kind: 'person', id: '00000000-0000-0000-0000-0000000000a2' }, null, 'person B (no email)', { full_name: 'B', emails: [] });
  r.add({ kind: 'message', id: '00000000-0000-0000-0000-0000000000b1' }, new Date('2026-10-01T00:00:00Z'), 'old message');
  r.add({ kind: 'message', id: '00000000-0000-0000-0000-0000000000b2' }, new Date('2027-01-01T00:00:00Z'), 'message dated in the future');
  r.add({ kind: 'meeting', id: '00000000-0000-0000-0000-0000000000c1' }, new Date('2026-10-07T12:00:00Z'), 'meeting', { status: 'CONFIRMED' });
  r.add({ kind: 'meeting', id: '00000000-0000-0000-0000-0000000000c2' }, new Date('2026-10-07T15:00:00Z'), 'cancelled meeting', { status: 'CANCELLED' });
  r.add({ kind: 'memory', id: '00000000-0000-0000-0000-0000000000d1' }, now, 'pref', { memory_kind: 'PREFERENCE' });
  return r;
}
// Handles: E1 P1 P2 M1 M2 MT1 MT2 MEM1

const claim = (id: string, kind: 'INFERENCE' | 'HYPOTHESIS' | 'ANTICIPATION' | 'RECOMMENDATION', evidence: string[], derived_from: string[] = [], about_people: string[] = []) => ({
  id,
  kind,
  statement: `${kind} ${id}`,
  confidence: 0.8,
  evidence,
  derived_from,
  about_people,
});

const run = (overrides: Parameters<typeof minimalReasoning>[0]) =>
  validateReasoning({ output: minimalReasoning(overrides), registry: registry(), sourceText: SOURCE, now, reachablePersonIds: new Set(['00000000-0000-0000-0000-0000000000a1']) });

const byLabel = (r: ReturnType<typeof run>, l: string) => r.claims.find((c) => c.label === l)!;

describe('evidence validation', () => {
  it('turns cited evidence into CODE facts and accepts a properly supported chain', () => {
    const r = run({ claims: [claim('C1', 'INFERENCE', ['M1', 'MT1']), claim('C2', 'ANTICIPATION', [], ['C1']), claim('C3', 'RECOMMENDATION', [], ['C2'])], narrative: 'Thing [C1]. Next [C2][C3].' });
    expect(r.claims.filter((c) => c.producedBy === 'CODE').map((c) => c.kind)).toEqual(['FACT', 'FACT']);
    expect(r.claims.every((c) => c.valid)).toBe(true);
    expect(byLabel(r, 'C3').derivedFrom).toEqual([byLabel(r, 'C2').ordinal]);
    expect(r.narrative.valid).toBe(true);
  });

  it('rejects invented evidence handles (nonexistent source/record/event)', () => {
    const r = run({ claims: [claim('C1', 'INFERENCE', ['M99', 'DOC1'])] });
    expect(byLabel(r, 'C1').valid).toBe(false);
    expect(byLabel(r, 'C1').errors.join()).toMatch(/unknown evidence handle "M99"/);
  });

  it('rejects unsupported claims by kind', () => {
    const r = run({ claims: [claim('C1', 'INFERENCE', []), claim('C2', 'RECOMMENDATION', ['M1']), claim('C3', 'HYPOTHESIS', [])] });
    expect(r.claims.filter((c) => c.producedBy === 'CLAUDE').every((c) => !c.valid)).toBe(true);
  });

  it('cascades rejection to claims derived from rejected claims, and to the narrative citing them', () => {
    const r = run({ claims: [claim('C1', 'INFERENCE', ['M99']), claim('C2', 'RECOMMENDATION', [], ['C1'])], narrative: 'Do it [C2].' });
    expect(byLabel(r, 'C2').valid).toBe(false);
    expect(r.narrative.valid).toBe(false);
  });

  it('rejects forward references and references to unknown claims', () => {
    const r = run({ claims: [claim('C1', 'ANTICIPATION', [], ['C2']), claim('C2', 'INFERENCE', ['M1'])] });
    expect(byLabel(r, 'C1').valid).toBe(false);
  });

  it('rejects "people" that are not person records', () => {
    const r = run({ claims: [claim('C1', 'INFERENCE', ['M1'], [], ['M1', 'P7'])] });
    expect(byLabel(r, 'C1').errors.join()).toMatch(/not a known person/);
  });

  it('rejects evidence with an impossible timestamp (past-only record dated after now)', () => {
    const r = run({ claims: [claim('C1', 'INFERENCE', ['M2'])] });
    expect(r.claims.find((c) => c.label === 'F:M2')!.valid).toBe(false);
    expect(byLabel(r, 'C1').valid).toBe(false);
  });

  it('urgency only counts with verbatim quotes from the source', () => {
    const ok = run({ assessment: { urgency: { value: 0.9, rationale: 'r', quotes: ['This is urgent.'] }, business_impact: { value: 0.5, rationale: 'r', evidence: ['M1'] }, applicable_preferences: [] } });
    const invented = run({ assessment: { urgency: { value: 0.9, rationale: 'r', quotes: ['the CEO is furious'] }, business_impact: { value: 0.5, rationale: 'r', evidence: [] }, applicable_preferences: [] } });
    expect(ok.urgency?.value).toBe(0.9);
    expect(invented.urgency?.value).toBe(0);
    expect(invented.businessImpact.value).toBeNull();
  });

  it('only accepts preference memories as applicable preferences', () => {
    const r = run({ assessment: { urgency: null, business_impact: { value: 0, rationale: '', evidence: [] }, applicable_preferences: [{ memory: 'MEM1', effect: 'RAISE' }, { memory: 'M1', effect: 'RAISE' }] } });
    expect(r.preferences.map((p) => p.handle)).toEqual(['MEM1']);
  });

  it('rejects actions to unknown or unreachable people, cancelled meetings, or without valid justification', () => {
    const base = [claim('C1', 'INFERENCE', ['M1'])];
    const email = (to: string) => ({ type: 'SEND_EMAIL' as const, target_person: to, related_meeting: null, justification_claims: ['C1'], briefing: null, email: { to_person: to, subject: 's', body: 'b' } });
    const r = run({
      claims: base,
      proposed_actions: [
        email('P1'),
        email('P9'),
        email('P2'),
        { ...email('P1'), justification_claims: ['C42'] },
        { type: 'PREPARE_BRIEFING', target_person: 'P1', related_meeting: 'MT2', justification_claims: ['C1'], briefing: { title: 't', sections: [] }, email: null },
      ],
    });
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.content).toMatchObject({ to: ['a@x.test'] });
    expect(r.rejectedActions.map((a) => a.errors.join())).toEqual([
      expect.stringMatching(/not a known person/),
      expect.stringMatching(/no known email/),
      expect.stringMatching(/unknown or rejected/),
      expect.stringMatching(/CANCELLED/),
    ]);
  });

  it('memory proposals need existing evidence and a real subject', () => {
    const r = run({
      memory_proposals: [
        { kind: 'PREFERENCE', about_person: 'P1', content: 'prefers short emails', evidence: ['E1'], confidence: 0.9 },
        { kind: 'PREFERENCE', about_person: 'P1', content: 'invented', evidence: [], confidence: 0.9 },
        { kind: 'FACT', about_person: 'P5', content: 'ghost', evidence: ['E1'], confidence: 0.9 },
      ],
    });
    expect(r.memoryProposals.map((m) => m.content)).toEqual(['prefers short emails']);
    expect(r.rejectedMemoryProposals).toHaveLength(2);
  });

  it('commitment completion claims require evidence', () => {
    expect(run({ completion_assessment: { status: 'DONE', evidence: [] } }).completion.valid).toBe(false);
    expect(run({ completion_assessment: { status: 'DONE', evidence: ['M1'] } }).completion.valid).toBe(true);
  });

  it('drops understanding signals that are not in the text or have impossible dates', () => {
    const u = validateUnderstanding(
      emptyUnderstanding({
        urgency_signals: [{ quote: 'This is urgent.', strength: 0.9 }, { quote: 'made up', strength: 1 }],
        time_references: [
          { description: 'deadline', quote: 'before Friday', resolved_iso: '2026-10-09' },
          { description: 'bogus', quote: 'before Friday', resolved_iso: '1999-01-01' },
        ],
      }),
      SOURCE,
      now,
    );
    expect(u.understanding.urgency_signals).toHaveLength(1);
    expect(u.understanding.time_references.map((t) => t.resolved_iso)).toEqual(['2026-10-09', null]);
    expect(u.errors).toHaveLength(2);
  });
});

describe('salience', () => {
  const report = run({ claims: [claim('C1', 'INFERENCE', ['M1'])], assessment: { urgency: { value: 0.9, rationale: 'r', quotes: ['This is urgent.'] }, business_impact: { value: 0.8, rationale: 'r', evidence: ['M1'] }, applicable_preferences: [] } });

  it('is explainable: every factor has a basis and the explanation names top factors', () => {
    const s = computeSalience({ relationship: { explicitImportance: 0.9, interactions90d: 6, lastInteractionAt: now }, deadlines: [{ at: new Date(now.getTime() + 20 * 3_600_000), basis: 'reunião relacionada' }], now, priorSimilarInsights: 0, validation: report, sourceKind: 'TEXT' });
    expect(s.factors.every((f) => f.basis.length > 0)).toBe(true);
    expect(s.explanation[0]).toMatch(/Pontuação/);
    expect(s.explanation.join('\n')).toMatch(/urgency: 0.90 — urgência expressa no texto/);
    expect(s.surfaced).toBe(true);
  });

  it('excludes non-applicable factors (no guessing) and renormalizes weights', () => {
    const s = computeSalience({ relationship: null, deadlines: [], now, priorSimilarInsights: 0, validation: report, sourceKind: 'STATE' });
    expect(s.factors.find((f) => f.name === 'urgency')!.value).toBeNull();
    expect(s.factors.reduce((a, f) => a + f.weight, 0)).toBeCloseTo(1, 6);
  });

  it('scores the same evidence lower for an unknown person and for repeated insights', () => {
    const known = computeSalience({ relationship: { explicitImportance: 0.9, interactions90d: 6, lastInteractionAt: now }, deadlines: [], now, priorSimilarInsights: 0, validation: report, sourceKind: 'TEXT' });
    const unknown = computeSalience({ relationship: null, deadlines: [], now, priorSimilarInsights: 0, validation: report, sourceKind: 'TEXT' });
    const repeated = computeSalience({ relationship: { explicitImportance: 0.9, interactions90d: 6, lastInteractionAt: now }, deadlines: [], now, priorSimilarInsights: 3, validation: report, sourceKind: 'TEXT' });
    expect(unknown.score).toBeLessThan(known.score);
    expect(repeated.score).toBeLessThan(known.score);
  });

  it('time sensitivity increases as the deadline approaches', () => {
    expect(timeSensitivity(2)).toBe(1);
    expect(timeSensitivity(24)).toBeGreaterThan(timeSensitivity(72));
    expect(timeSensitivity(500)).toBe(0.1);
  });
});
