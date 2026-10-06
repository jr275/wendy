import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVAL_CASES, EVAL_RECORDS } from '../../fixtures/retrievalEval.js';
import { runRetrievalEval, type EvalSummary } from '../../src/eval/retrievalEval.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let r: EvalSummary;
beforeAll(async () => {
  t = await createTestDb();
  r = await runRetrievalEval(t.db, 10);
});
afterAll(() => t.drop());

describe('retrieval evaluation harness', () => {
  it('every expected record exists in the corpus', () => {
    const keys = new Set(EVAL_RECORDS.map((x) => x.key));
    for (const c of EVAL_CASES) for (const e of c.expected) expect(keys.has(e), `${c.question}: ${e}`).toBe(true);
  });

  it('measures the real search: exact terms are found, and recall is a fraction of the expected set', () => {
    expect(r.cases).toHaveLength(EVAL_CASES.length);
    expect(r.byCategory['exato']!.literal).toBeGreaterThan(0.5);
    for (const c of r.cases) {
      expect(c.literal.recall).toBeGreaterThanOrEqual(0);
      expect(c.literal.recall).toBeLessThanOrEqual(1);
      expect(c.literal.found.every((f) => c.expected.includes(f))).toBe(true);
      expect(c.claude).toBeUndefined(); // no reasoner given → no Claude column, nothing simulated
    }
  });
});
