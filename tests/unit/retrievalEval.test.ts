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

describe('retrieval evaluation on real data (cases written by the principal)', () => {
  it('resolves expected records by text fragment, reports unresolved ones, and measures the same search', async () => {
    const { runRealRetrievalEval } = await import('../../src/eval/realRetrievalEval.js');
    const p = (await t.db.query(`SELECT id, display_name, timezone FROM principals LIMIT 1`)).rows[0];
    const r = await runRealRetrievalEval(t.db, { id: p.id, name: p.display_name, timezone: p.timezone }, [
      { question: 'pricing?', terms: ['pricing'], expected: [{ kind: 'message', contains: 'tiered pricing' }, { kind: 'commitment', contains: 'pricing schedule' }] },
      { question: 'contrato?', terms: ['acordo'], expected: [{ kind: 'message', contains: 'cláusulas do contrato' }, { kind: 'message', contains: 'does not exist anywhere' }] },
    ]);
    expect(r.cases[0]).toMatchObject({ literal: { found: 2, of: 2 }, unresolved: [] });
    expect(r.cases[1]).toMatchObject({ literal: { found: 0, of: 1 }, unresolved: ['message: "does not exist anywhere"'] });
    expect(r.literal).toBe(0.5);
    expect(r.claude).toBeUndefined();
  });
});
