/**
 * Measures the CURRENT lexical retrieval (the same repository search functions the cognitive
 * loop uses; nothing is changed here) against the synthetic evaluation set.
 *
 * recall@K: share of the expected records that come back when each record type is searched with
 * limit K. Reported per case, per category and overall, for literal and instructed terms.
 */
import type { ReasoningClient } from '../cognition/llm.js';
import { describeTime, UNDERSTAND_SYSTEM } from '../cognition/prompts.js';
import { UnderstandingSchema } from '../cognition/schemas.js';
import { withTx, type Db, type Queryable } from '../db/db.js';
import { createCommitment, createPerson, createPrincipal, storeMessage, upsertMeeting } from '../events/world.js';
import { pgRepositories } from '../repositories/pg.js';
import { DAY_MS } from '../util/clock.js';
import { EVAL_CASES, EVAL_PEOPLE, EVAL_RECORDS, type Category, type EvalCase } from '../../fixtures/retrievalEval.js';

export interface CaseResult {
  question: string;
  category: Category;
  expected: string[];
  literal: { found: string[]; recall: number };
  instructed: { found: string[]; recall: number };
  /** Terms produced by the real understanding step (only when a reasoner is given). */
  claude?: { terms: string[]; found: string[]; recall: number };
}

export interface EvalSummary {
  k: number;
  cases: CaseResult[];
  byCategory: Record<string, { n: number; literal: number; instructed: number; claude?: number }>;
  overall: { literal: number; instructed: number; claude?: number };
}

const PRINCIPAL_EMAIL = 'joao@mendes-partners.com';

/** Loads the synthetic corpus into an empty, migrated schema. Returns key → record id. */
export async function loadEvalCorpus(db: Db, now: Date): Promise<{ principalId: string; ids: Map<string, string> }> {
  const principalId = await createPrincipal(db, { displayName: 'João Mendes', primaryEmail: PRINCIPAL_EMAIL, timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
  const people = new Map<string, string>();
  for (const [k, p] of Object.entries(EVAL_PEOPLE)) people.set(k, await createPerson(db, principalId, { fullName: p.name, emails: [p.email], source: 'EVAL_SYNTHETIC' }));
  const ids = new Map<string, string>();
  const repos = pgRepositories();
  await withTx(db, async (tx) => {
    let i = 0;
    for (const r of EVAL_RECORDS) {
      i++;
      const personKey = r.person ?? 'noise';
      const email = EVAL_PEOPLE[personKey].email;
      if (r.kind === 'message') {
        const { messageId } = await storeMessage(tx, principalId, { provider: 'EVAL_SYNTHETIC', externalId: r.key, from: email, to: [PRINCIPAL_EMAIL], subject: r.title, body: r.body ?? '', sentAt: new Date(now.getTime() - i * DAY_MS) });
        ids.set(r.key, messageId);
      } else if (r.kind === 'meeting') {
        const start = new Date(now.getTime() + i * DAY_MS);
        ids.set(r.key, await upsertMeeting(tx, principalId, { provider: 'EVAL_SYNTHETIC', externalId: r.key, title: r.title, startsAt: start, endsAt: new Date(start.getTime() + 3600_000), status: 'CONFIRMED', attendees: [email, PRINCIPAL_EMAIL] }));
      } else if (r.kind === 'commitment') {
        ids.set(r.key, await createCommitment(tx, principalId, { owner: 'PRINCIPAL', counterpartyPersonId: people.get(personKey)!, description: r.title, dueAt: new Date(now.getTime() + i * DAY_MS), createdAt: now, source: 'EVAL_SYNTHETIC' }));
      } else {
        const m = await repos.memories.write(tx, { principalId, kind: 'PREFERENCE', subjectPersonId: people.get(personKey)!, content: r.title, confidence: 1, evidence: [], writtenBy: 'PRINCIPAL', createdAt: now });
        ids.set(r.key, m.id);
      }
    }
  });
  return { principalId, ids };
}

/** Same searches as retrieveContext, each limited to k, over all time (isolates the lexical part). */
export async function searchAll(db: Queryable, principalId: string, terms: string[], k: number): Promise<Set<string>> {
  const repos = pgRepositories();
  const far = [new Date('2000-01-01T00:00:00Z'), new Date('2100-01-01T00:00:00Z')] as const;
  const found = new Set<string>();
  for (const m of await repos.messages.search(db, principalId, terms, far[0], far[1], k)) found.add(m.id);
  for (const m of await repos.meetings.searchBetween(db, principalId, terms, far[0], far[1], k)) found.add(m.id);
  for (const c of await repos.commitments.search(db, principalId, terms, k)) found.add(c.id);
  for (const m of await repos.memories.search(db, principalId, terms, k)) found.add(m.id);
  return found;
}

/** Asks the real understanding step (same prompt and schema as answering a question) for search terms. */
export async function claudeTerms(
  reasoner: ReasoningClient,
  principal: { id: string; name: string; timezone: string },
  question: string,
  now: Date,
): Promise<string[]> {
  const u = await reasoner.generate({
    purpose: 'eval-understand-question',
    principalId: principal.id,
    system: UNDERSTAND_SYSTEM,
    user: `Principal: ${principal.name}, time zone ${principal.timezone}.\nText timestamp: ${describeTime(now, principal.timezone)}\nText type: question from the principal\n\n<text>\n${question}\n</text>`,
    schema: UnderstandingSchema,
    effort: 'low',
    evidenceRefs: [],
  });
  return u.output.topics.flatMap((t) => [t.label, ...t.search_terms]);
}

export async function runRetrievalEval(db: Db, k = 10, now = new Date(), reasoner: ReasoningClient | null = null): Promise<EvalSummary> {
  const { principalId, ids } = await loadEvalCorpus(db, now);
  const measure = async (c: EvalCase, terms: string[]) => {
    const got = await searchAll(db, principalId, terms, k);
    const found = c.expected.filter((key) => got.has(ids.get(key)!));
    return { found, recall: found.length / c.expected.length };
  };
  const cases: CaseResult[] = [];
  for (const c of EVAL_CASES) {
    const row: CaseResult = { question: c.question, category: c.category, expected: c.expected, literal: await measure(c, c.literal), instructed: await measure(c, c.instructed) };
    if (reasoner) {
      const terms = await claudeTerms(reasoner, { id: principalId, name: 'João Mendes', timezone: 'America/Sao_Paulo' }, c.question, now);
      row.claude = { terms, ...(await measure(c, terms)) };
    }
    cases.push(row);
  }
  const byCategory: EvalSummary['byCategory'] = {};
  for (const r of cases) {
    const b = (byCategory[r.category] ??= { n: 0, literal: 0, instructed: 0 });
    b.n++;
    b.literal += r.literal.recall;
    b.instructed += r.instructed.recall;
    if (r.claude) b.claude = (b.claude ?? 0) + r.claude.recall;
  }
  for (const b of Object.values(byCategory)) {
    b.literal /= b.n;
    b.instructed /= b.n;
    if (b.claude !== undefined) b.claude /= b.n;
  }
  const avg = (f: (r: CaseResult) => number) => cases.reduce((s, r) => s + f(r), 0) / cases.length;
  return {
    k,
    cases,
    byCategory,
    overall: { literal: avg((r) => r.literal.recall), instructed: avg((r) => r.instructed.recall), ...(reasoner ? { claude: avg((r) => r.claude!.recall) } : {}) },
  };
}
