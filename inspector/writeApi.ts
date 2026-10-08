/**
 * Authenticated write API for the local UI (Phase 2, deterministic part).
 *
 * The read side of the inspector stays read-only at the database level; writes go through this
 * module only, on a separate pool, and only through the domain services (which lock, validate,
 * scope by principal and audit). No endpoint writes SQL of its own.
 *
 * Protections:
 *   - login by one-time link printed in the terminal (expires in 10 min, single use)
 *   - session cookie: random token, only its hash is stored (ui_sessions), HttpOnly, SameSite=Strict
 *   - every write needs the session's CSRF token in X-CSRF-Token and a same-origin Origin header
 *   - JSON only, 64 KB max, every body validated with zod
 *   - the only email provider is the local dev mailbox (nothing leaves the machine)
 */
import crypto from 'node:crypto';
import type http from 'node:http';
import type pg from 'pg';
import { z } from 'zod';
import { ActionService, IllegalTransitionError, PolicyService } from '../src/actions/actions.js';
import { ActionExecutor } from '../src/actions/executor.js';
import type { Db } from '../src/db/db.js';
import { CommitmentService, CommitmentTransitionError } from '../src/commitments/commitmentService.js';
import { MemoryService, MemoryTransitionError } from '../src/memory/memoryService.js';
import { PeopleService } from '../src/people/peopleService.js';
import { setSiteImportance } from '../src/sensors/searchConsole.js';
import { DevMailboxProvider } from '../src/providers/devMailbox.js';
import { newId, sha256 } from '../src/util/hash.js';

export const SESSION_COOKIE = 'wendy_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_TTL_MS = 10 * 60 * 1000;
const MAX_BODY = 64 * 1024;

const uuid = z.string().uuid();

/** One write route: its body schema and the domain-service call it maps to. */
function route<S extends z.ZodType>(schema: S, run: (db: Db, body: z.infer<S>, at: Date) => Promise<unknown>) {
  return { schema, run };
}

const ROUTES = {
  '/api/write/action/approve': route(
    z.object({
      principalId: uuid,
      actionId: uuid,
      edits: z.object({ subject: z.string().min(1).max(500).optional(), body: z.string().min(1).max(20_000).optional() }).strict().optional(),
    }),
    async (db, b, at) => {
      const a = await new ActionService(db).approve(b.principalId, b.actionId, at, b.edits);
      // Execute right away. The only email provider is the local dev mailbox (nothing leaves the machine).
      await new ActionExecutor(db, new DevMailboxProvider(db)).runPending();
      const state = (await db.query<{ state: string }>('SELECT state FROM actions WHERE id = $1', [a.id])).rows[0]!.state;
      return { actionId: a.id, state, delivery: 'DEV_MAILBOX' };
    },
  ),
  '/api/write/action/reject': route(z.object({ principalId: uuid, actionId: uuid, reason: z.string().max(2000).nullable().optional() }), async (db, b, at) => ({
    state: (await new ActionService(db).reject(b.principalId, b.actionId, b.reason ?? null, at)).state,
  })),
  '/api/write/memory/confirm': route(z.object({ principalId: uuid, memoryId: uuid }), async (db, b, at) => {
    await new MemoryService(db).confirm(b.principalId, b.memoryId, at);
    return { status: 'ACTIVE' };
  }),
  '/api/write/memory/retract': route(z.object({ principalId: uuid, memoryId: uuid, reason: z.string().max(2000).nullable().optional() }), async (db, b, at) => {
    await new MemoryService(db).retract(b.principalId, b.memoryId, b.reason ?? null, at);
    return { status: 'RETRACTED' };
  }),
  '/api/write/memory/resolve-conflict': route(z.object({ principalId: uuid, conflictId: uuid, keepIds: z.array(uuid).min(1).max(20) }), async (db, b, at) => {
    await new MemoryService(db).resolveConflict(b.principalId, b.conflictId, b.keepIds, at);
    return { status: 'RESOLVED' };
  }),
  '/api/write/person/importance': route(z.object({ principalId: uuid, personId: uuid, importance: z.number().min(0).max(1).nullable() }), async (db, b, at) => {
    await new PeopleService(db).setImportance(b.principalId, b.personId, b.importance, at);
    return { importance: b.importance };
  }),
  '/api/write/policy': route(
    z.object({ principalId: uuid, actionType: z.enum(['PREPARE_BRIEFING', 'SEND_EMAIL']), mode: z.enum(['AUTO', 'REQUIRE_APPROVAL']).nullable() }),
    async (db, b, at) => {
      await new PolicyService(db).set(b.principalId, b.actionType, b.mode, at);
      return { mode: b.mode };
    },
  ),
  '/api/write/commitment/confirm': route(z.object({ principalId: uuid, commitmentId: uuid, dueAt: z.string().datetime({ offset: true }).optional() }), async (db, b, at) => {
    await new CommitmentService(db).confirm(b.principalId, b.commitmentId, at, b.dueAt ? new Date(b.dueAt) : undefined);
    return { status: 'OPEN' };
  }),
  '/api/write/commitment/discard': route(z.object({ principalId: uuid, commitmentId: uuid, reason: z.string().max(2000).nullable().optional() }), async (db, b, at) => {
    await new CommitmentService(db).discard(b.principalId, b.commitmentId, b.reason ?? null, at);
    return { status: 'CANCELLED' };
  }),
  '/api/write/commitment/complete': route(z.object({ principalId: uuid, commitmentId: uuid }), async (db, b, at) => {
    await new CommitmentService(db).complete(b.principalId, b.commitmentId, at);
    return { status: 'DONE' };
  }),
  '/api/write/commitment/cancel': route(z.object({ principalId: uuid, commitmentId: uuid, reason: z.string().max(2000).nullable().optional() }), async (db, b, at) => {
    await new CommitmentService(db).cancel(b.principalId, b.commitmentId, b.reason ?? null, at);
    return { status: 'CANCELLED' };
  }),
  '/api/write/commitment/reschedule': route(z.object({ principalId: uuid, commitmentId: uuid, dueAt: z.string().datetime({ offset: true }) }), async (db, b, at) => {
    await new CommitmentService(db).reschedule(b.principalId, b.commitmentId, new Date(b.dueAt), at);
    return { dueAt: b.dueAt };
  }),
  '/api/write/site/importance': route(z.object({ principalId: uuid, propertyId: uuid, importance: z.number().min(0).max(1).nullable() }), async (db, b, at) => {
    await setSiteImportance(db, b.principalId, b.propertyId, b.importance, at);
    return { importance: b.importance };
  }),
} as const;
export type WritePath = keyof typeof ROUTES;
export const WRITE_PATHS = Object.keys(ROUTES) as WritePath[];

/**
 * Validates and performs one write through the domain services (same table the cookie-authenticated
 * UI API uses). Callers must have authenticated the request and must supply the principal themselves.
 */
export async function performWrite(db: Db, path: WritePath, body: unknown, now = new Date()): Promise<unknown> {
  const r = ROUTES[path] as { schema: z.ZodType; run: (db: Db, body: unknown, at: Date) => Promise<unknown> };
  const parsed = r.schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, `invalid body: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.run(db, parsed.data, now);
}

/** HTTP status for an error thrown by performWrite / the domain services. */
export function writeErrorStatus(err: unknown): number {
  const e = err as Error & { status?: number };
  return err instanceof HttpError ? err.status : err instanceof IllegalTransitionError || err instanceof MemoryTransitionError || err instanceof CommitmentTransitionError ? 409 : /not found/.test(e.message) ? 404 : (e.status ?? 500);
}

export interface WriteApiOptions {
  /** Pool where ui_sessions live. */
  sessionsDb: pg.Pool;
  /** Writable pool for the data schema the UI is looking at. */
  dataDb: (schema: string | null) => Promise<Db>;
  /** Exact origins allowed to write, e.g. http://127.0.0.1:3457 */
  allowedOrigins: string[];
  now?: () => Date;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function cookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const safeEqual = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createWriteApi(opts: WriteApiOptions) {
  const now = opts.now ?? (() => new Date());
  const loginTokens = new Map<string, number>(); // sha256(token) -> expires (ms)

  /** New one-time login token (only its hash is kept in memory). */
  function issueLoginToken(): string {
    const token = crypto.randomBytes(32).toString('base64url');
    loginTokens.set(sha256(token), now().getTime() + LOGIN_TTL_MS);
    return token;
  }

  async function sessionFor(req: http.IncomingMessage): Promise<{ id: string; csrf_token: string } | null> {
    const token = cookies(req)[SESSION_COOKIE];
    if (!token) return null;
    return (
      (
        await opts.sessionsDb.query<{ id: string; csrf_token: string }>(
          'SELECT id, csrf_token FROM ui_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2',
          [sha256(token), now()],
        )
      ).rows[0] ?? null
    );
  }

  async function login(url: URL, res: http.ServerResponse) {
    const token = url.searchParams.get('t') ?? '';
    const key = sha256(token);
    const exp = loginTokens.get(key);
    loginTokens.delete(key); // single use, even when expired
    if (!token || !exp || exp <= now().getTime()) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Link de acesso inválido ou expirado. Gere um novo reiniciando o servidor.');
    }
    const session = crypto.randomBytes(32).toString('base64url');
    const at = now();
    await opts.sessionsDb.query('INSERT INTO ui_sessions(id, token_hash, csrf_token, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)', [
      newId(),
      sha256(session),
      crypto.randomBytes(24).toString('base64url'),
      at,
      new Date(at.getTime() + SESSION_TTL_MS),
    ]);
    res.writeHead(303, {
      Location: '/',
      'Set-Cookie': `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
      'Cache-Control': 'no-store',
    });
    res.end();
  }

  async function perform(path: WritePath, body: unknown, schema: string | null) {
    const r = ROUTES[path] as { schema: z.ZodType; run: (db: Db, body: unknown, at: Date) => Promise<unknown> };
    const parsed = r.schema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, `invalid body: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return r.run(await opts.dataDb(schema), parsed.data, now());
  }

  /** Returns true when the request was handled here. */
  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, schema: () => Promise<string | null>): Promise<boolean> {
    try {
      if (req.method === 'GET' && url.pathname === '/login') {
        await login(url, res);
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const s = await sessionFor(req);
        json(res, 200, s ? { authenticated: true, csrf: s.csrf_token } : { authenticated: false });
        return true;
      }
      if (req.method !== 'POST') return false;
      if (url.pathname !== '/api/logout' && !(url.pathname in ROUTES)) return false;

      const origin = req.headers.origin;
      if (!origin || !opts.allowedOrigins.includes(origin)) throw new HttpError(403, 'origin not allowed');
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON only');
      const s = await sessionFor(req);
      if (!s) throw new HttpError(401, 'not authenticated');
      const csrf = String(req.headers['x-csrf-token'] ?? '');
      if (!safeEqual(csrf, s.csrf_token)) throw new HttpError(403, 'invalid CSRF token');

      if (url.pathname === '/api/logout') {
        await opts.sessionsDb.query('UPDATE ui_sessions SET revoked_at = $2 WHERE id = $1', [s.id, now()]);
        json(res, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
        return true;
      }
      const body = await readJson(req);
      json(res, 200, { ok: true, result: await perform(url.pathname as WritePath, body, await schema()) });
    } catch (err) {
      const e = err as Error & { status?: number };
      const status =
        err instanceof HttpError ? err.status : err instanceof IllegalTransitionError || err instanceof MemoryTransitionError || err instanceof CommitmentTransitionError ? 409 : /not found/.test(e.message) ? 404 : (e.status ?? 500);
      json(res, status, { ok: false, error: e.message });
    }
    return true;
  }

  return { handle, issueLoginToken };
}
