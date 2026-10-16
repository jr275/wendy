/** The Gemini reasoner (MVP) obeys the same contract as Claude: schema-valid output or a recorded failure. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GeminiReasoningClient } from '../../src/cognition/gemini.js';
import { ReasoningUnavailableError } from '../../src/cognition/llm.js';
import { ModelTimeoutError } from '../../src/cognition/resilience.js';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let principalId: string;
beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  principalId = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'UTC', locale: 'pt-BR' });
});
afterAll(() => t.drop());

const Schema = z.object({ answer: z.string(), confidence: z.number() });
const fakeAi = (text: string) => ({ models: { generateContent: async () => ({ text, modelVersion: 'gemini-test-version', responseId: 'resp-1', usageMetadata: { totalTokenCount: 10 }, candidates: [{ finishReason: 'STOP' }] }) } }) as never;
const req = { purpose: 'test', principalId: '', system: 's', user: 'u', schema: Schema, effort: 'low' as const, evidenceRefs: [] };

describe('Gemini reasoner (MVP)', () => {
  it('accepts schema-valid output and records the call under the Gemini model name (never as Claude)', async () => {
    const r = await new GeminiReasoningClient(db, 'gemini-x', fakeAi('{"answer":"ok","confidence":0.9}')).generate({ ...req, principalId });
    expect(r.output).toEqual({ answer: 'ok', confidence: 0.9 });
    const row = (await db.query('SELECT model, served_by_model, api_message_id, error FROM model_calls WHERE id = $1', [r.modelCallId])).rows[0];
    expect(row).toEqual({ model: 'gemini-x', served_by_model: 'gemini-test-version', api_message_id: 'resp-1', error: null });
  });

  it('rejects output that does not match the schema, tries ONCE more, and records every attempt (nothing is salvaged)', async () => {
    const noWait = { deps: { sleep: async () => {}, random: () => 0.5 } };
    for (const bad of ['{"answer":"ok"}', 'not json', '']) {
      await expect(new GeminiReasoningClient(db, 'gemini-x', fakeAi(bad), noWait).generate({ ...req, principalId })).rejects.toBeInstanceOf(ReasoningUnavailableError);
    }
    const errors = (await db.query(`SELECT error FROM model_calls WHERE model = 'gemini-x' AND error IS NOT NULL`)).rows.map((r) => r.error);
    expect(errors).toHaveLength(6); // 3 outputs × (first try + one more)
    expect(errors.every((e) => e.startsWith('UNPARSEABLE_OUTPUT'))).toBe(true);
  });
});

describe('Gemini reasoner: provider failures', () => {
  const noWait = { deps: { sleep: async () => {}, random: () => 0.5 } };
  const failing = (errors: unknown[], then = '{"answer":"ok","confidence":0.9}') => {
    let n = 0;
    return { calls: () => n, ai: { models: { generateContent: async () => { const e = errors[n++]; if (e) throw e; return { text: then, modelVersion: 'v', responseId: 'r', usageMetadata: {} }; } } } as never };
  };
  const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
  const rows = async (model: string) => (await db.query<{ error: string | null; attempt: number }>(`SELECT error, (input->>'attempt')::int AS attempt FROM model_calls WHERE model = $1 ORDER BY started_at, attempt`, [model])).rows;

  it('a transient failure is retried: the call succeeds, and every attempt is its own recorded row', async () => {
    const f = failing([http(503), http(429), undefined]);
    const r = await new GeminiReasoningClient(db, 'gemini-retry', f.ai, noWait).generate({ ...req, principalId });
    expect(r.output).toEqual({ answer: 'ok', confidence: 0.9 });
    expect(f.calls()).toBe(3);
    const got = await rows('gemini-retry');
    expect(got.map((x) => x.attempt)).toEqual([1, 2, 3]);
    expect(got[0]!.error).toMatch(/^TRANSIENT: /);
    expect(got[1]!.error).toMatch(/^TRANSIENT: /);
    expect(got[2]!.error).toBeNull();
    expect((await db.query('SELECT error FROM model_calls WHERE id = $1', [r.modelCallId])).rows[0].error).toBeNull(); // the id returned is the successful attempt
  });

  it('when attempts run out the failure is raised classified, with the number of attempts', async () => {
    const f = failing([http(429), http(429), http(429), http(429)]);
    const err = await new GeminiReasoningClient(db, 'gemini-exhaust', f.ai, noWait).generate({ ...req, principalId }).catch((e) => e);
    expect(err).toBeInstanceOf(ReasoningUnavailableError);
    expect(err).toMatchObject({ kind: 'transient', attempts: 3 });
    expect(f.calls()).toBe(3);
    expect((await rows('gemini-exhaust')).every((x) => x.error?.startsWith('TRANSIENT: '))).toBe(true);
  });

  it('an expired login is not retried (one call, recorded as AUTH)', async () => {
    const f = failing([http(401), undefined]);
    const err = await new GeminiReasoningClient(db, 'gemini-auth', f.ai, noWait).generate({ ...req, principalId }).catch((e) => e);
    expect(err).toMatchObject({ kind: 'auth', attempts: 1 });
    expect(f.calls()).toBe(1);
    expect((await rows('gemini-auth'))[0]!.error).toMatch(/^AUTH: /);
  });

  it('a call that never answers is cut off by the time limit and retried like any transient failure', async () => {
    const ai = { models: { generateContent: () => new Promise(() => {}) } } as never;
    const err = await new GeminiReasoningClient(db, 'gemini-hang', ai, { policy: { timeoutMs: 20 }, ...noWait }).generate({ ...req, principalId }).catch((e) => e);
    expect(err).toMatchObject({ kind: 'transient', attempts: 3 });
    expect(err.cause).toBeInstanceOf(ModelTimeoutError);
    expect((await rows('gemini-hang')).map((x) => x.attempt)).toEqual([1, 2, 3]);
  });

  it('a bug that is not a provider failure is rethrown as it is, after one call (never disguised, never retried)', async () => {
    const bug = new TypeError('a real bug');
    const f = failing([bug]);
    const err = await new GeminiReasoningClient(db, 'gemini-bug', f.ai, noWait).generate({ ...req, principalId }).catch((e) => e);
    expect(err).toBe(bug);
    expect(f.calls()).toBe(1);
    expect((await rows('gemini-bug'))[0]!.error).toBe('TypeError: a real bug');
  });
});
