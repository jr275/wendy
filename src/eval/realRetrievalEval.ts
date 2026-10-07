/**
 * Retrieval evaluation on the principal's REAL data (e.g. after `npm run import`), with questions
 * the principal writes. Expected records are identified by a text fragment of their subject /
 * title / description / content, so the principal never has to look up ids.
 *
 * An expected item counts as found when ANY record matching its fragment comes back.
 * Searches run on a read-only connection; nothing is written except model-call records when
 * real Claude terms are requested.
 */
import { z } from 'zod';
import type { ReasoningClient } from '../cognition/llm.js';
import type { Queryable } from '../db/db.js';
import { claudeTerms, searchAll } from './retrievalEval.js';

export const RealCasesSchema = z.array(
  z.object({
    question: z.string().min(3),
    terms: z.array(z.string().min(1)).min(1),
    expected: z.array(z.object({ kind: z.enum(['message', 'meeting', 'commitment', 'memory']), contains: z.string().min(3) })).min(1),
  }),
);
export type RealCase = z.infer<typeof RealCasesSchema>[number];

const MATCH_SQL: Record<RealCase['expected'][number]['kind'], string> = {
  message: `SELECT id FROM messages WHERE principal_id = $1 AND (subject ILIKE $2 OR body ILIKE $2)`,
  meeting: `SELECT id FROM meetings WHERE principal_id = $1 AND (title ILIKE $2 OR description ILIKE $2)`,
  commitment: `SELECT id FROM commitments WHERE principal_id = $1 AND description ILIKE $2`,
  memory: `SELECT id FROM memories WHERE principal_id = $1 AND content ILIKE $2`,
};

export interface RealCaseResult {
  question: string;
  unresolved: string[]; // expected fragments that match no record (fix the cases file)
  literal: { found: number; of: number };
  claude?: { terms: string[]; found: number; of: number };
}

export async function runRealRetrievalEval(
  readDb: Queryable,
  principal: { id: string; name: string; timezone: string },
  cases: RealCase[],
  k = 10,
  reasoner: ReasoningClient | null = null,
): Promise<{ cases: RealCaseResult[]; literal: number; claude?: number }> {
  const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const results: RealCaseResult[] = [];
  for (const c of cases) {
    const resolved: { fragment: string; ids: Set<string> }[] = [];
    const unresolved: string[] = [];
    for (const e of c.expected) {
      const ids = new Set((await readDb.query<{ id: string }>(MATCH_SQL[e.kind], [principal.id, like(e.contains)])).rows.map((r) => r.id));
      if (ids.size) resolved.push({ fragment: e.contains, ids });
      else unresolved.push(`${e.kind}: "${e.contains}"`);
    }
    const score = (got: Set<string>) => resolved.filter((r) => [...r.ids].some((id) => got.has(id))).length;
    const row: RealCaseResult = { question: c.question, unresolved, literal: { found: score(await searchAll(readDb, principal.id, c.terms, k)), of: resolved.length } };
    if (reasoner) {
      const terms = await claudeTerms(reasoner, principal, c.question, new Date());
      row.claude = { terms, found: score(await searchAll(readDb, principal.id, terms, k)), of: resolved.length };
    }
    results.push(row);
  }
  const avg = (f: (r: RealCaseResult) => { found: number; of: number } | undefined) => {
    const xs = results.map(f).filter((x): x is { found: number; of: number } => !!x && x.of > 0);
    return xs.length ? xs.reduce((s, x) => s + x.found / x.of, 0) / xs.length : 0;
  };
  return { cases: results, literal: avg((r) => r.literal), ...(reasoner ? { claude: avg((r) => r.claude) } : {}) };
}
