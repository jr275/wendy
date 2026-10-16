/** The Claude reasoner obeys the same resilience contract as Gemini: classified failures, bounded retries, one recorded row per attempt. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClaudeReasoningClient, ReasoningUnavailableError } from '../../src/cognition/llm.js';
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

const Schema = z.object({ answer: z.string() });
const req = { purpose: 'test', principalId: '', system: 's', user: 'u', schema: Schema, effort: 'low' as const, evidenceRefs: [] };
const noWait = { retryDeps: { sleep: async () => {}, random: () => 0.5 } };
const ok = { stop_reason: 'end_turn', parsed_output: { answer: 'ok' }, model: 'claude-test', id: 'msg-1', usage: {} };
const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const fake = (steps: (unknown | Error)[]) => {
  let n = 0;
  const client = { beta: { messages: { parse: async () => { const s = steps[n++]; if (s instanceof Error) throw s; return s; } } }, messages: {} } as never;
  return { client, calls: () => n };
};
const rows = async (model: string) => (await db.query<{ error: string | null; attempt: number }>(`SELECT error, (input->>'attempt')::int AS attempt FROM model_calls WHERE model = $1 ORDER BY started_at, attempt`, [model])).rows;

describe('Claude reasoner', () => {
  it('returns schema-valid output and records the call', async () => {
    const f = fake([ok]);
    const r = await new ClaudeReasoningClient(db, { client: f.client, provider: 'anthropic', model: 'claude-ok', ...noWait }).generate({ ...req, principalId });
    expect(r.output).toEqual({ answer: 'ok' });
    expect((await rows('claude-ok')).map((x) => x.error)).toEqual([null]);
  });

  it('an overloaded API (529) is retried and then succeeds; each attempt is recorded', async () => {
    const f = fake([http(529), http(503), ok]);
    const r = await new ClaudeReasoningClient(db, { client: f.client, provider: 'anthropic', model: 'claude-retry', ...noWait }).generate({ ...req, principalId });
    expect(r.output).toEqual({ answer: 'ok' });
    expect(f.calls()).toBe(3);
    const got = await rows('claude-retry');
    expect(got.map((x) => x.attempt)).toEqual([1, 2, 3]);
    expect(got.slice(0, 2).every((x) => x.error?.startsWith('TRANSIENT: '))).toBe(true);
  });

  it('a refusal is raised as a refusal after ONE call: the model would decline again', async () => {
    const f = fake([{ ...ok, stop_reason: 'refusal', parsed_output: null }, ok]);
    const err = await new ClaudeReasoningClient(db, { client: f.client, provider: 'anthropic', model: 'claude-refuse', ...noWait }).generate({ ...req, principalId }).catch((e) => e);
    expect(err).toBeInstanceOf(ReasoningUnavailableError);
    expect(err).toMatchObject({ kind: 'refusal', attempts: 1 });
    expect(f.calls()).toBe(1);
    expect((await rows('claude-refuse'))[0]!.error).toBe('REFUSAL');
  });

  it('an unparseable output is tried once more, then raised as invalid output', async () => {
    const bad = { ...ok, parsed_output: null };
    const f = fake([bad, bad, ok]);
    const err = await new ClaudeReasoningClient(db, { client: f.client, provider: 'anthropic', model: 'claude-bad', ...noWait }).generate({ ...req, principalId }).catch((e) => e);
    expect(err).toMatchObject({ kind: 'invalid_output', attempts: 2 });
    expect(f.calls()).toBe(2);
    expect((await rows('claude-bad')).every((x) => x.error === 'UNPARSEABLE_OUTPUT')).toBe(true);
  });

  it('a 401 is not retried', async () => {
    const f = fake([http(401), ok]);
    const err = await new ClaudeReasoningClient(db, { client: f.client, provider: 'anthropic', model: 'claude-auth', ...noWait }).generate({ ...req, principalId }).catch((e) => e);
    expect(err).toMatchObject({ kind: 'auth', attempts: 1 });
    expect(f.calls()).toBe(1);
  });
});
