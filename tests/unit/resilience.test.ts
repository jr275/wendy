/**
 * Resilient model calls (src/cognition/resilience.ts), with no database and no network: failures are
 * classified from the shapes real SDK errors have, retried only when retrying can help, bounded in
 * time, and reported by cause — in skill runs and in the chat.
 */
import { describe, expect, it } from 'vitest';
import { friendlyRunError, loggableError } from '../../src/agent/errors.js';
import {
  DEFAULT_RETRY_POLICY,
  ModelTimeoutError,
  ReasoningUnavailableError,
  backoffMs,
  classifyFailure,
  recordedError,
  retryAfterMs,
  withRetry,
  withTimeout,
  type RetryPolicy,
} from '../../src/cognition/resilience.js';
import { toExecutionError } from '../../src/skills/runtime.js';

const http = (status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });
const policy = (over: Partial<RetryPolicy> = {}): RetryPolicy => ({ ...DEFAULT_RETRY_POLICY, jitter: 0, ...over });
const noWait = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms), random: () => 0.5 };
};

describe('classification: why did it fail, and can another try help?', () => {
  it('rate limits, overload and server errors are transient (Retry-After is read, from Headers or a plain object)', () => {
    for (const s of [408, 429, 500, 502, 503, 504, 529]) expect(classifyFailure(http(s)).kind, String(s)).toBe('transient');
    expect(classifyFailure(http(429, { headers: new Headers({ 'retry-after': '7' }) }))).toEqual({ kind: 'transient', retryAfterMs: 7000 });
    expect(classifyFailure(http(503, { headers: { 'retry-after': '2' } })).retryAfterMs).toBe(2000);
  });

  it('401 / 403 and an expired login are auth: retrying cannot fix them', () => {
    expect(classifyFailure(http(401)).kind).toBe('auth');
    expect(classifyFailure(http(403)).kind).toBe('auth');
    const gaxios = Object.assign(new Error('{"error":"invalid_grant","error_description":"reauth related error (invalid_rapt)"}'), { name: 'GaxiosError' });
    expect(classifyFailure(gaxios).kind).toBe('auth');
  });

  it('another 4xx means the request itself is wrong: unknown, never retried', () => {
    for (const s of [400, 404, 422]) expect(classifyFailure(http(s)).kind, String(s)).toBe('unknown');
  });

  it('network failures are transient, including when the real code is nested in `cause` (fetch failed)', () => {
    expect(classifyFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })).kind).toBe('transient');
    expect(classifyFailure(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).kind).toBe('transient');
    expect(classifyFailure(new Error('RESOURCE_EXHAUSTED: quota exceeded')).kind).toBe('transient');
    expect(classifyFailure(new ModelTimeoutError(1000)).kind).toBe('transient');
  });

  it('anything unrecognised is unknown (a bug is never disguised as a provider problem)', () => {
    expect(classifyFailure(new Error('boom')).kind).toBe('unknown');
    expect(classifyFailure(new TypeError("Cannot read properties of undefined (reading 'x')")).kind).toBe('unknown');
    expect(classifyFailure('a string').kind).toBe('unknown');
    expect(classifyFailure(null).kind).toBe('unknown');
  });

  it('an error already classified keeps its kind', () => {
    for (const kind of ['transient', 'auth', 'refusal', 'invalid_output'] as const) expect(classifyFailure(new ReasoningUnavailableError('x', kind)).kind).toBe(kind);
  });

  it('Retry-After: seconds or an HTTP date, never negative, ignored when absent or unreadable', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    expect(retryAfterMs({ 'retry-after': '3' })).toBe(3000);
    expect(retryAfterMs({ 'retry-after': 'Sat, 10 Oct 2026 12:00:10 GMT' }, now)).toBe(10_000);
    expect(retryAfterMs({ 'retry-after': 'Sat, 10 Oct 2026 11:00:00 GMT' }, now)).toBe(0);
    expect(retryAfterMs({})).toBeUndefined();
    expect(retryAfterMs({ 'retry-after': 'soon' })).toBeUndefined();
    expect(retryAfterMs(undefined)).toBeUndefined();
  });
});

describe('backoff', () => {
  it('grows exponentially, is capped, and stays inside the jitter band', () => {
    const p = policy({ baseMs: 1000, maxMs: 5000, jitter: 0.25 });
    expect([1, 2, 3, 4, 5].map((a) => backoffMs(a, p, undefined, () => 0.5))).toEqual([1000, 2000, 4000, 5000, 5000]);
    expect(backoffMs(1, p, undefined, () => 0)).toBe(750); // lowest
    expect(backoffMs(1, p, undefined, () => 1)).toBe(1250); // highest
  });

  it('a provider Retry-After is a floor, but never longer than the cap', () => {
    const p = policy({ baseMs: 1000, maxRetryAfterMs: 30_000 });
    expect(backoffMs(1, p, 8000, () => 0.5)).toBe(8000);
    expect(backoffMs(1, p, 600_000, () => 0.5)).toBe(30_000);
    expect(backoffMs(3, p, 500, () => 0.5)).toBe(4000); // the computed backoff is already larger
  });
});

describe('withRetry', () => {
  it('a transient failure is retried and the call then succeeds', async () => {
    const { waits, sleep, random } = noWait();
    let calls = 0;
    const out = await withRetry(
      async () => {
        if (++calls < 3) throw http(503);
        return 'ok';
      },
      policy(),
      { sleep, random },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it('when the attempts run out the failure is raised, classified, with the cause kept and secrets masked', async () => {
    const { sleep, random } = noWait();
    let calls = 0;
    const err = await withRetry(
      async () => {
        calls++;
        throw http(429, { message: 'Too many requests for api_key=sk-ant-SECRET123 on this model' });
      },
      policy(),
      { sleep, random },
    ).catch((e) => e);
    expect(calls).toBe(3);
    expect(err).toBeInstanceOf(ReasoningUnavailableError);
    expect(err).toMatchObject({ kind: 'transient', attempts: 3 });
    expect(err.message).toContain('3 attempts');
    expect(err.message).not.toContain('SECRET123');
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('auth, refusal and unknown failures are never retried; unknown is rethrown untouched', async () => {
    const { waits, sleep, random } = noWait();
    for (const e of [http(401), new ReasoningUnavailableError('refused', 'refusal'), new ReasoningUnavailableError('login', 'auth')]) {
      let calls = 0;
      const got = await withRetry(async () => { calls++; throw e; }, policy(), { sleep, random }).catch((x) => x);
      expect(calls).toBe(1);
      expect(got).toBeInstanceOf(ReasoningUnavailableError);
    }
    const bug = new TypeError('a bug');
    let calls = 0;
    const got = await withRetry(async () => { calls++; throw bug; }, policy(), { sleep, random }).catch((x) => x);
    expect(calls).toBe(1);
    expect(got).toBe(bug); // the very same object: not wrapped, not disguised
    expect(waits).toEqual([]);
  });

  it('an invalid output is tried once more, no more', async () => {
    const { waits, sleep, random } = noWait();
    let calls = 0;
    const err = await withRetry(async () => { calls++; throw new ReasoningUnavailableError('bad json', 'invalid_output'); }, policy(), { sleep, random }).catch((e) => e);
    expect(calls).toBe(2);
    expect(err).toMatchObject({ kind: 'invalid_output', attempts: 2 });
    expect(waits).toHaveLength(1);

    let n = 0;
    expect(await withRetry(async () => (++n < 2 ? Promise.reject(new ReasoningUnavailableError('bad', 'invalid_output')) : 'fixed'), policy(), { sleep, random })).toBe('fixed');
  });

  it('attempts: 1 turns retrying off; an aborted signal stops waiting and raises the current failure', async () => {
    const { sleep, random } = noWait();
    let calls = 0;
    await withRetry(async () => { calls++; throw http(503); }, policy({ attempts: 1 }), { sleep, random }).catch(() => undefined);
    expect(calls).toBe(1);

    const ctl = new AbortController();
    ctl.abort();
    calls = 0;
    const err = await withRetry(async () => { calls++; throw http(503); }, policy(), { sleep, random, signal: ctl.signal }).catch((e) => e);
    expect(calls).toBe(1);
    expect(err.kind).toBe('transient');
  });

  it('reports each retry (kind, attempt, wait) so it can be logged', async () => {
    const { sleep, random } = noWait();
    const seen: unknown[] = [];
    let n = 0;
    await withRetry(async () => { if (++n < 2) throw http(503); return 1; }, policy(), { sleep, random, onRetry: (i) => seen.push(i) });
    expect(seen).toEqual([{ attempt: 1, kind: 'transient', delayMs: 1000 }]);
  });
});

describe('withTimeout', () => {
  it('a call that never answers fails with a transient timeout instead of hanging', async () => {
    const err = await withTimeout(new Promise(() => {}), 20).catch((e) => e);
    expect(err).toBeInstanceOf(ModelTimeoutError);
    expect(classifyFailure(err).kind).toBe('transient');
  });
  it('a fast call is untouched, and a non-positive limit means no limit', async () => {
    expect(await withTimeout(Promise.resolve('x'), 50)).toBe('x');
    expect(await withTimeout(new Promise((r) => setTimeout(() => r('slow'), 30)), 0)).toBe('slow');
  });
});

describe('what is recorded and what is reported', () => {
  it('model_calls.error carries the cause first and never a secret', () => {
    expect(recordedError(http(503))).toMatch(/^TRANSIENT: /);
    expect(recordedError(http(401))).toMatch(/^AUTH: /);
    expect(recordedError(new Error('plain bug'))).toBe('Error: plain bug');
    expect(recordedError(new Error('failed with authorization: Bearer abc123xyz'))).not.toContain('abc123xyz');
  });

  it('a skill run: transient is retryable; auth and refusal are not; invalid output is not repeated here; a legacy error keeps its old behaviour', () => {
    const e = (kind?: ConstructorParameters<typeof ReasoningUnavailableError>[1]) => toExecutionError(new ReasoningUnavailableError('m', kind), 'step');
    expect(e('transient')).toMatchObject({ code: 'MODEL_UNAVAILABLE', retryable: true });
    expect(e('auth')).toMatchObject({ code: 'MODEL_AUTH', retryable: false });
    expect(e('refusal')).toMatchObject({ code: 'MODEL_REFUSED', retryable: false });
    expect(e('invalid_output')).toMatchObject({ code: 'MODEL_UNAVAILABLE', retryable: false });
    expect(e()).toMatchObject({ code: 'MODEL_UNAVAILABLE', retryable: true }); // no reason given: as before
    expect(toExecutionError(new TypeError('bug'), 'step')).toMatchObject({ code: 'INTERNAL', retryable: false });
  });

  it('the chat tells the cause in pt-BR, with the number of attempts, and keeps the older messages for unclassified errors', () => {
    expect(friendlyRunError(new ReasoningUnavailableError('x', 'transient', 3))).toMatch(/indisponível ou sobrecarregado.*tentei 3 vezes/);
    expect(friendlyRunError(new ReasoningUnavailableError('x', 'transient', 1))).not.toMatch(/tentei/);
    expect(friendlyRunError(new ReasoningUnavailableError('x', 'refusal'))).toMatch(/recusou/);
    expect(friendlyRunError(new ReasoningUnavailableError('x', 'invalid_output'))).toMatch(/não consegui validar/);
    expect(friendlyRunError(new Error('429 RESOURCE_EXHAUSTED'))).toMatch(/limite de uso/);
    expect(friendlyRunError(new ReasoningUnavailableError('login: invalid_grant', 'auth'))).toMatch(/autenticação do Google/);
    expect(loggableError(new Error('boom api_key=sk-ant-ABC'))).not.toContain('sk-ant-ABC');
  });
});
