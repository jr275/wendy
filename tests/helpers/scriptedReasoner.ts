/**
 * TEST DOUBLE — NOT CLAUDE. Used only by deterministic tests of pipeline *mechanics* (idempotency,
 * persistence, validation, concurrency). It returns outputs scripted by each test, and its model
 * calls are recorded as model 'TEST_DOUBLE' so they can never be mistaken for real reasoning.
 * Every claim about cognition (understanding, anticipation, memory use) is tested live against Claude.
 */
import type { Db } from '../../src/db/db.js';
import { finishModelCall, recordModelCall, type ReasoningClient, type ReasoningRequest, type ReasoningResult } from '../../src/cognition/llm.js';
import type { Reasoning, Understanding } from '../../src/cognition/schemas.js';
import { newId } from '../../src/util/hash.js';

export type Script = (req: ReasoningRequest<unknown>) => unknown;

export class ScriptedReasoner implements ReasoningClient {
  calls: { purpose: string; user: string }[] = [];
  constructor(
    private readonly db: Db,
    private readonly scripts: Record<string, Script>,
  ) {}

  async generate<T>(req: ReasoningRequest<T>): Promise<ReasoningResult<T>> {
    this.calls.push({ purpose: req.purpose, user: req.user });
    const id = newId();
    await recordModelCall(this.db, { id, principalId: req.principalId, purpose: req.purpose, model: 'TEST_DOUBLE', input: { user: req.user }, evidenceRefs: req.evidenceRefs, startedAt: new Date() });
    const script = this.scripts[req.purpose];
    if (!script) throw new Error(`no script for purpose ${req.purpose}`);
    const output = req.schema.parse(script(req as ReasoningRequest<unknown>));
    await finishModelCall(this.db, id, { output, servedBy: 'TEST_DOUBLE' });
    return { output, modelCallId: id, model: 'TEST_DOUBLE' };
  }
}

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
