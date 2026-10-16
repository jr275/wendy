import { maskCardData } from '../security/cardRedaction.js';

/**
 * Resilient model calls: classify a provider failure, retry only what is worth retrying, and time-box
 * every call. Pure (no SDK, no database): the model clients (llm.ts, gemini.ts) use it, never the reverse.
 *
 *   transient       429 / 5xx / network / timeout          → retried with exponential backoff + jitter,
 *                                                            honouring Retry-After (capped)
 *   auth            401 / 403 / expired login              → never retried: retrying cannot fix it
 *   refusal         the model declined                     → never retried: it would decline again
 *   invalid_output  empty / unparseable / off-schema       → retried once (a one-off glitch is common)
 *   unknown         anything else (a bug, a 400)           → never retried and rethrown AS IS, so a
 *                                                            programming error is never disguised
 *
 * Nothing is invented to fill a gap: when the attempts are exhausted the failure is raised, classified.
 */

export type FailureKind = 'transient' | 'auth' | 'refusal' | 'invalid_output' | 'unknown';

/**
 * Raised when the model could not be used. `kind` says why and therefore whether trying again can help;
 * `attempts` is how many calls were made. The legacy default (`unknown`) keeps the old behaviour for
 * code that throws it with just a message.
 */
export class ReasoningUnavailableError extends Error {
  attempts: number;
  constructor(
    message: string,
    readonly kind: FailureKind = 'unknown',
    attempts = 1,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ReasoningUnavailableError';
    this.attempts = attempts;
  }
}

/** A call that exceeded its time limit. It is transient by nature (the next one may answer). */
export class ModelTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Model call exceeded ${timeoutMs} ms`);
    this.name = 'ModelTimeoutError';
  }
}

export interface RetryPolicy {
  /** Total attempts for a transient failure (first try included). */
  attempts: number;
  /** Extra tries allowed for an invalid output. */
  invalidOutputRetries: number;
  baseMs: number;
  maxMs: number;
  /** ± fraction applied to the computed backoff (0.25 = ±25%). */
  jitter: number;
  /** Longest Retry-After honoured; a provider asking for more is waited for this long only. */
  maxRetryAfterMs: number;
  /** Per-call limit. A hung call must not block the worker cycle or a chat turn forever. */
  timeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  invalidOutputRetries: 1,
  baseMs: 1_000,
  maxMs: 20_000,
  jitter: 0.25,
  maxRetryAfterMs: 30_000,
  timeoutMs: 300_000, // thinking models can legitimately take minutes; this only stops a hang
};

export interface Classified {
  kind: FailureKind;
  retryAfterMs?: number;
}

const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const AUTH_STATUS = new Set([401, 403]);
const NETWORK_CODE = /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_[A-Z_]+)\b/;
const AUTH_TEXT = /invalid_grant|invalid_rapt|reauth|UNAUTHENTICATED|PERMISSION_DENIED|invalid (x-)?api[ _-]?key|authentication/i;
const TRANSIENT_TEXT = /RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|overloaded|rate.?limit|too many requests|fetch failed|socket hang up|timed? ?out|temporarily/i;

const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null);

/** The numeric HTTP status an SDK error carries, wherever it keeps it. */
function statusOf(e: Record<string, unknown>): number | undefined {
  for (const v of [e.status, e.statusCode, asRecord(e.response)?.status, typeof e.code === 'number' ? e.code : undefined]) if (typeof v === 'number' && v >= 100 && v < 600) return v;
  return undefined;
}

/** Retry-After from a Headers instance or a plain object: seconds or an HTTP date; never negative. */
export function retryAfterMs(headers: unknown, now = Date.now()): number | undefined {
  const h = asRecord(headers);
  if (!h) return undefined;
  const raw = typeof h.get === 'function' ? (h.get as (k: string) => unknown).call(h, 'retry-after') : (h['retry-after'] ?? h['Retry-After']);
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** What kind of failure is this, and is it worth another try. Looks through `cause` (fetch failures nest the real code). */
export function classifyFailure(e: unknown, now = Date.now()): Classified {
  if (e instanceof ReasoningUnavailableError) return { kind: e.kind };
  if (e instanceof ModelTimeoutError) return { kind: 'transient' };
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && cur; depth++) {
    const r = asRecord(cur);
    if (!r) break;
    const status = statusOf(r);
    const text = `${r.name ?? ''} ${r.message ?? ''} ${r.code ?? ''}`;
    if (status !== undefined) {
      if (AUTH_STATUS.has(status)) return { kind: 'auth' };
      if (TRANSIENT_STATUS.has(status) || status >= 500) {
        const after = retryAfterMs(r.headers, now);
        return after === undefined ? { kind: 'transient' } : { kind: 'transient', retryAfterMs: after };
      }
      return { kind: 'unknown' }; // another 4xx: the request itself is wrong; retrying repeats the mistake
    }
    if (AUTH_TEXT.test(text)) return { kind: 'auth' };
    if (NETWORK_CODE.test(text) || TRANSIENT_TEXT.test(text)) return { kind: 'transient' };
    cur = r.cause;
  }
  return { kind: 'unknown' };
}

/** Masks anything that looks like a credential, or payment-card data. Provider errors can embed whole requests. */
export function redactSecrets(raw: string): string {
  return maskCardData(
    raw
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>') // the token FOLLOWS the scheme word, so it must be matched first
      .replace(/(refresh_token|access_token|client_secret|api[_-]?key|authorization|bearer)(["'\s:=]+)[^\s"',}]+/gi, '$1$2<redacted>')
      .replace(/\b1\/\/[A-Za-z0-9_-]{20,}/g, '<redacted>')
      .replace(/\bAIza[A-Za-z0-9_-]{30,}/g, '<redacted>') // Google API keys
      .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/g, '<redacted>'), // GitHub personal access / OAuth / app tokens
  );
}

/** What is stored in model_calls.error: the class first (so a failure can be filtered by cause), secrets masked. */
export function recordedError(e: unknown): string {
  const kind = classifyFailure(e).kind;
  const text = redactSecrets(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  return (kind === 'unknown' ? text : `${kind.toUpperCase()}: ${text}`).slice(0, 2000);
}

export interface RetryDeps {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Stops waiting between attempts (the current error is then raised). */
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; kind: FailureKind; delayMs: number }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with jitter; a provider's Retry-After is a floor, capped. */
export function backoffMs(attempt: number, policy: RetryPolicy, retryAfter: number | undefined, random: () => number): number {
  const exp = Math.min(policy.maxMs, policy.baseMs * 2 ** (attempt - 1));
  const jittered = exp * (1 + (random() * 2 - 1) * policy.jitter);
  const floor = retryAfter === undefined ? 0 : Math.min(retryAfter, policy.maxRetryAfterMs);
  return Math.round(Math.max(jittered, floor));
}

/** The classified error to raise once retrying is over (an unknown failure is returned untouched). */
function raised(e: unknown, c: Classified, attempts: number): unknown {
  if (e instanceof ReasoningUnavailableError) {
    e.attempts = attempts;
    return e;
  }
  if (c.kind === 'unknown') return e;
  const text = redactSecrets(`${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}`).slice(0, 300);
  return new ReasoningUnavailableError(`Model call failed (${c.kind}, ${attempts} attempt${attempts === 1 ? '' : 's'}): ${text}`, c.kind, attempts, { cause: e });
}

/** Runs `run(attempt)` until it succeeds or the failure is not worth another try. */
export async function withRetry<T>(run: (attempt: number) => Promise<T>, policy: RetryPolicy = DEFAULT_RETRY_POLICY, deps: RetryDeps = {}): Promise<T> {
  let invalidLeft = policy.invalidOutputRetries;
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(attempt);
    } catch (e) {
      const c = classifyFailure(e);
      const again = attempt < policy.attempts && !deps.signal?.aborted && (c.kind === 'transient' || (c.kind === 'invalid_output' && invalidLeft > 0));
      if (!again) throw raised(e, c, attempt);
      if (c.kind === 'invalid_output') invalidLeft--;
      const delayMs = backoffMs(attempt, policy, c.retryAfterMs, deps.random ?? Math.random);
      deps.onRetry?.({ attempt, kind: c.kind, delayMs });
      await (deps.sleep ?? defaultSleep)(delayMs);
    }
  }
}

/** Fails a call that does not answer within `ms` (the underlying request is abandoned, not cancelled). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!(ms > 0)) return p;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ModelTimeoutError(ms)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}
