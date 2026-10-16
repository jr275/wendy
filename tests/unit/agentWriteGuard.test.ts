/**
 * The authoritative write boundary. Pure: every dependency is a spy or a fake (the database, the sessions pool, the
 * writable-pool factory, the http request/response), so no agent, database, network or provider is involved. What is proven:
 *   - WENDY_AGENT=off is refused at the shared entry of ROUTES (performWrite and the inspector's perform) BEFORE
 *     validation and before any database access, with the existing { ok:false, error } shape and HTTP 503;
 *   - authentication is a separate control and comes first (an unauthenticated caller gets 401/403, not the availability);
 *   - validation still runs before any mutation when the agent is not off;
 *   - "on", unset and invalid are NOT treated as off (the request proceeds to the persistence layer);
 *   - the web's run guard refuses a run on the server without ever calling the runtime.
 * The agent's HTTP wiring (server.ts) cannot be imported (it opens a database and listens), so it is covered by the pure
 * gateAgentRequest decision plus a source-order check, and is NOT exercised as a running server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_OFF_MESSAGE, agentOffReason, gateAgentRequest, parseAgentSetting } from '../../src/agent/availability.js';
import { createWriteApi, performWrite, writeErrorStatus } from '../../inspector/writeApi.js';
import { parseAgentSetting as parseWeb } from '../../web/lib/agentConfig.js';
import { describeRunFailure } from '../../web/lib/conversation.js';
import { guardRun, isRunRequest } from '../../web/lib/runGuard.js';
import type { Db } from '../../src/db/db.js';

const ID = '11111111-1111-4111-8111-111111111111';
const GOOD = { principalId: ID, memoryId: ID };
const PATH = '/api/write/memory/confirm' as const;
const spyDb = () => ({ query: vi.fn(), connect: vi.fn() }) as unknown as Db & { query: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> };
const untouched = (db: { query: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }) => expect(db.query.mock.calls.length + db.connect.mock.calls.length).toBe(0);

describe('the agent-side parser keeps the web parser\'s meaning', () => {
  it('identical on every kind of value, including typos and other conventions', () => {
    for (const v of [undefined, null, '', '  ', 'off', 'OFF', ' Off ', 'on', 'ON', 'ofline', '0', 'false', 'disabled', 'no', '1', 'true', 'off,on']) expect(parseAgentSetting(v), String(v)).toBe(parseWeb(v));
  });
  it('only off refuses; on, unset and invalid claim nothing; the invalid value is never echoed', () => {
    expect(agentOffReason({ WENDY_AGENT: 'off' })).toBe(AGENT_OFF_MESSAGE);
    for (const v of ['on', undefined, '', 'ofline', 'SECRET-LOOKING-VALUE']) expect(agentOffReason({ WENDY_AGENT: v } as NodeJS.ProcessEnv), String(v)).toBeUndefined();
    expect(AGENT_OFF_MESSAGE).not.toMatch(/SECRET|ofline/);
  });
});

describe('gateAgentRequest: what the agent HTTP server refuses before reading anything', () => {
  const off = { WENDY_AGENT: 'off' };
  it('refuses a run and a write when off', () => {
    expect(gateAgentRequest('POST', '/agui', off)).toEqual({ kind: 'run', message: AGENT_OFF_MESSAGE });
    expect(gateAgentRequest('POST', '/write/action/approve', off)).toEqual({ kind: 'write', message: AGENT_OFF_MESSAGE });
  });
  it('lets everything through when not off, and ignores what is not a run or a write', () => {
    for (const env of [{}, { WENDY_AGENT: 'on' }, { WENDY_AGENT: 'ofline' }]) {
      expect(gateAgentRequest('POST', '/agui', env)).toBeNull();
      expect(gateAgentRequest('POST', '/write/memory/confirm', env)).toBeNull();
    }
    expect(gateAgentRequest('GET', '/agui', off)).toBeNull();
    expect(gateAgentRequest('POST', '/other', off)).toBeNull();
    expect(gateAgentRequest(undefined, undefined, off)).toBeNull();
  });
});

describe('performWrite (the agent\'s /write/ entry to ROUTES)', () => {
  it('off: refused with 503 before validation and before any database access, for a valid and an invalid body alike', async () => {
    for (const body of [GOOD, { nonsense: true }]) {
      const db = spyDb();
      const err = (await performWrite(db, PATH, body, new Date(), { WENDY_AGENT: 'off' }).catch((e) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(writeErrorStatus(err)).toBe(503);
      expect(err.message).toBe(AGENT_OFF_MESSAGE);
      untouched(db);
    }
  });
  it('not off: an invalid body is a 400 with the database untouched (validation precedes mutation)', async () => {
    const db = spyDb();
    const err = (await performWrite(db, PATH, { nonsense: true }, new Date(), {}).catch((e) => e)) as Error;
    expect(writeErrorStatus(err)).toBe(400);
    untouched(db);
  });
  it('on, unset and an invalid setting are not treated as off: a valid body reaches the persistence layer', async () => {
    for (const env of [{}, { WENDY_AGENT: 'on' }, { WENDY_AGENT: 'ofline' }]) {
      const db = spyDb();
      await performWrite(db, PATH, GOOD, new Date(), env).catch(() => undefined); // the spy db cannot complete it; reaching it is the point
      expect(db.query.mock.calls.length + db.connect.mock.calls.length, JSON.stringify(env)).toBeGreaterThan(0);
    }
  });
});

// ---- the inspector's own entry (createWriteApi.handle → perform), with a fake http request/response
const ORIGIN = 'http://127.0.0.1:3457';
function mkReq(opts: { method?: string; url: string; body?: unknown; headers?: Record<string, string> }) {
  const raw = Buffer.from(JSON.stringify(opts.body ?? {}));
  const req = Object.assign(Readable.from([raw]), {
    method: opts.method ?? 'POST',
    url: opts.url,
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: 'wendy_session=tok', 'x-csrf-token': 'CSRF', ...(opts.headers ?? {}) } as Record<string, string>,
  });
  return req as unknown as import('node:http').IncomingMessage;
}
function mkRes() {
  const out: { status?: number; body?: string } = {};
  const res = { writeHead: vi.fn((s: number) => void (out.status = s)), end: vi.fn((b?: string) => void (out.body = b)) };
  return { res: res as unknown as import('node:http').ServerResponse, out };
}
function api(env: NodeJS.ProcessEnv, session: unknown = { id: 's1', csrf_token: 'CSRF' }) {
  const sessionsDb = { query: vi.fn().mockResolvedValue({ rows: session ? [session] : [] }) };
  const dataDb = vi.fn().mockResolvedValue(spyDb());
  const w = createWriteApi({ sessionsDb: sessionsDb as never, dataDb, allowedOrigins: [ORIGIN], env });
  const call = async (req: ReturnType<typeof mkReq>) => {
    const { res, out } = mkRes();
    await w.handle(req, res, new URL(`http://x${req.url}`), async () => null);
    return { ...out, json: out.body ? JSON.parse(out.body) : null };
  };
  return { call, sessionsDb, dataDb };
}

describe('the inspector write API (perform) under WENDY_AGENT=off', () => {
  it('an authenticated write is refused with 503 and the existing shape; the writable pool is never opened; no session row is written', async () => {
    const { call, sessionsDb, dataDb } = api({ WENDY_AGENT: 'off' });
    const r = await call(mkReq({ url: PATH, body: GOOD }));
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ ok: false, error: AGENT_OFF_MESSAGE });
    expect(dataDb).not.toHaveBeenCalled();
    expect(sessionsDb.query).toHaveBeenCalledTimes(1); // only the session lookup (a SELECT), no INSERT/UPDATE
    expect(String(sessionsDb.query.mock.calls[0]?.[0])).toMatch(/^SELECT/);
  });
  it('availability is a separate control: authentication and CSRF/origin come first and are not masked by it', async () => {
    const off = { WENDY_AGENT: 'off' };
    expect((await api(off, null).call(mkReq({ url: PATH, body: GOOD }))).status).toBe(401); // no valid session
    expect((await api(off).call(mkReq({ url: PATH, body: GOOD, headers: { origin: 'http://evil.invalid' } }))).status).toBe(403);
    expect((await api(off).call(mkReq({ url: PATH, body: GOOD, headers: { 'x-csrf-token': 'WRONG' } }))).status).toBe(403);
    expect((await api(off).call(mkReq({ url: PATH, body: GOOD, headers: { 'content-type': 'text/plain' } }))).status).toBe(415);
  });
  it('the gate comes before body validation (an off environment never reports "invalid body")', async () => {
    const { call, dataDb } = api({ WENDY_AGENT: 'off' });
    const r = await call(mkReq({ url: PATH, body: { nonsense: true } }));
    expect(r.status).toBe(503);
    expect(dataDb).not.toHaveBeenCalled();
  });
  it('not off: validation errors stay 400 with no pool opened; a valid body reaches the persistence layer', async () => {
    for (const env of [{}, { WENDY_AGENT: 'on' }, { WENDY_AGENT: 'ofline' }]) {
      const bad = api(env);
      const rb = await bad.call(mkReq({ url: PATH, body: { nonsense: true } }));
      expect(rb.status, JSON.stringify(env)).toBe(400);
      expect(bad.dataDb).not.toHaveBeenCalled();
      const good = api(env);
      const rg = await good.call(mkReq({ url: PATH, body: GOOD }));
      expect(good.dataDb, JSON.stringify(env)).toHaveBeenCalledTimes(1); // reached: only then could it fail, here on the spy db
      expect(rg.status).not.toBe(503);
    }
  });
  it('session management is not an agent mutation and keeps working', async () => {
    const { call } = api({ WENDY_AGENT: 'off' });
    const r = await call(mkReq({ method: 'GET', url: '/api/session' }));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ authenticated: true, csrf: 'CSRF' });
  });
});

describe("the web's run guard", () => {
  const run = (method = 'POST', p = '/api/copilotkit/agent/wendy/run') => new Request(`http://localhost:3010${p}`, { method, body: method === 'POST' ? '{}' : undefined });
  it('off: a run is refused on the server, the runtime is never called, and the answer is one RUN_ERROR with no code', async () => {
    const next = vi.fn();
    const r = await guardRun(run(), 'O agente está desligado.', next);
    expect(next).not.toHaveBeenCalled();
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    const ev = JSON.parse((await r.text()).replace(/^data: /, ''));
    expect(ev).toEqual({ type: 'RUN_ERROR', message: 'O agente está desligado.' });
    expect(ev.code).toBeUndefined();
    // and the client shows it as the agent's own sentence, never as success and never as a transport failure
    expect(describeRunFailure({ agentEvent: true, message: ev.message, runtimeErrorCode: ev.code })).toBe('O agente está desligado.');
  });
  it('only a POST run is gated: connect, info, stop and GET pass through; and so does everything when nothing says off', async () => {
    for (const [m, p] of [['POST', '/api/copilotkit/agent/wendy/connect'], ['POST', '/api/copilotkit/agent/wendy/stop/main'], ['GET', '/api/copilotkit/info'], ['GET', '/api/copilotkit/agent/wendy/run']] as const) {
      const next = vi.fn().mockResolvedValue(new Response('ok'));
      await guardRun(run(m, p), 'off', next);
      expect(next, `${m} ${p}`).toHaveBeenCalledTimes(1);
    }
    const next = vi.fn().mockResolvedValue(new Response('ok'));
    await guardRun(run(), undefined, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(isRunRequest('POST', '/api/copilotkit/agent/wendy/run/')).toBe(true);
  });
});

describe('source order in the agent server (regression guard, NOT a running server)', () => {
  const s = fs.readFileSync(path.resolve(__dirname, '../../src/agent/server.ts'), 'utf8');
  it('the gate sits after authentication and before the body, the database and the run; the resume timer is gated too', () => {
    const at = (needle: string) => s.indexOf(needle);
    expect(at('authorized(req.headers.authorization)')).toBeGreaterThan(-1);
    expect(at('gateAgentRequest(')).toBeGreaterThan(at('authorized(req.headers.authorization)'));
    for (const later of ['readLimited(req)', 'saveMessages(db, pid, userMessages', 'performWrite(db, path, body)', 'principalId()']) {
      const i = s.indexOf(later, at('gateAgentRequest('));
      expect(i, later).toBeGreaterThan(at('gateAgentRequest('));
    }
    expect(s).toMatch(/if \(resuming \|\| agentOffReason\(\)\) return;/);
  });
  it('both entries of ROUTES call the shared gate', () => {
    const w = fs.readFileSync(path.resolve(__dirname, '../../inspector/writeApi.ts'), 'utf8');
    expect((w.match(/assertWritesAllowed\(/g) ?? []).length).toBe(3); // definition + performWrite + perform
  });
});
