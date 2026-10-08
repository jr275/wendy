/** The Gemini reasoner (MVP) obeys the same contract as Claude: schema-valid output or a recorded failure. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GeminiReasoningClient } from '../../src/cognition/gemini.js';
import { ReasoningUnavailableError } from '../../src/cognition/llm.js';
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

  it('rejects output that does not match the schema and records the failure (nothing is salvaged)', async () => {
    for (const bad of ['{"answer":"ok"}', 'not json', '']) {
      await expect(new GeminiReasoningClient(db, 'gemini-x', fakeAi(bad)).generate({ ...req, principalId })).rejects.toBeInstanceOf(ReasoningUnavailableError);
    }
    const errors = (await db.query(`SELECT error FROM model_calls WHERE model = 'gemini-x' AND error IS NOT NULL`)).rows.map((r) => r.error);
    expect(errors).toHaveLength(3);
    expect(errors.every((e) => e.startsWith('UNPARSEABLE_OUTPUT'))).toBe(true);
  });
});
