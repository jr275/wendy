/**
 * TEST DOUBLE — NOT CLAUDE (implementation in src/cognition/scripted.ts). Used only by deterministic tests of pipeline *mechanics* (idempotency,
 * persistence, validation, concurrency). It returns outputs scripted by each test, and its model
 * calls are recorded as model 'TEST_DOUBLE' so they can never be mistaken for real reasoning.
 * Every claim about cognition (understanding, anticipation, memory use) is tested live against Claude.
 */
import type { Reasoning, Understanding } from '../../src/cognition/schemas.js';

export { ScriptedReasoner, type Script } from '../../src/cognition/scripted.js';

/** Handles listed in the evidence section of a prompt, e.g. ["E1","P1","M1",...]. */
export function handlesIn(user: string, prefix?: string): string[] {
  const all = [...user.matchAll(/^\[([A-Z]+\d+)\] \(/gm)].map((m) => m[1]!);
  return prefix ? all.filter((h) => h.replace(/\d+$/, '') === prefix) : all;
}

export const emptyUnderstanding = (overrides: Partial<Understanding> = {}): Understanding => ({
  summary: 'scripted',
  language: 'en',
  mentioned_people: [],
  topics: [],
  requests: [],
  time_references: [],
  urgency_signals: [],
  ...overrides,
});

export const minimalReasoning = (overrides: Partial<Reasoning> = {}): Reasoning => ({
  relevant_evidence: [],
  claims: [],
  headline: 'scripted',
  narrative: 'scripted',
  assessment: { urgency: null, business_impact: { value: 0, rationale: 'scripted', evidence: [] }, applicable_preferences: [] },
  conflicts: [],
  information_gaps: [],
  completion_assessment: { status: 'NOT_APPLICABLE', evidence: [] },
  proposed_actions: [],
  memory_proposals: [],
  ...overrides,
});
