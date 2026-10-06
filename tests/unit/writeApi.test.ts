/**
 * The write API must refuse anything that is not an authenticated, same-origin, CSRF-protected JSON
 * request, and must only reach state through the domain services (scoped, audited).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proposeAction } from '../../src/actions/actions.js';
import { verifyLedgerIntegrity } from '../../src/audit/ledger.js';
import { withTx, type Db } from '../../src/db/db.js';
import { createPerson, createPrincipal } from '../../src/events/world.js';
import { pgRepositories } from '../../src/repositories/pg.js';
import { createWriteApi, SESSION_COOKIE } from '../../inspector/writeApi.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let server: http.Server;
let base: string;
let api: ReturnType<typeof createWriteApi>;
let principalId: string;
let otherPrincipalId: string;
let personId: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  principalId = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'UTC', locale: 'en' });
  otherPrincipalId = await createPrincipal(db, { displayName: 'Q', primaryEmail: 'q@example.test', timezone: 'UTC', locale: 'en' });
  personId = await createPerson(db, principalId, { fullName: 'Recipient', emails: ['r@example.test'], source: 'TEST' });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!(await api.handle(req, res, url, async () => null))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api = createWriteApi({ sessionsDb: db, dataDb: async () => db, allowedOrigins: [base] });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await t.drop();
});

async function login(): Promise<{ cookie: string; csrf: string }> {
  const r = await fetch(`${base}/login?t=${api.issueLoginToken()}`, { redirect: 'manual' });
  expect(r.status).toBe(303);
  const setCookie = r.headers.get('set-cookie')!;
  expect(setCookie).toMatch(/HttpOnly/);
  expect(setCookie).toMatch(/SameSite=Strict/);
  const cookie = setCookie.split(';')[0]!;
  const s = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
  expect(s.authenticated).toBe(true);
  return { cookie, csrf: s.csrf };
}

function post(path: string, body: unknown, h: { cookie?: string; csrf?: string; origin?: string | null; type?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': h.type ?? 'application/json' };
  if (h.cookie) headers.cookie = h.cookie;
  if (h.csrf) headers['x-csrf-token'] = h.csrf;
  if (h.origin !== null) headers.origin = h.origin ?? base;
  return fetch(`${base}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

const proposeEmail = () =>
  withTx(db, (tx) =>
    proposeAction(tx, { principalId, insightId: null, type: 'SEND_EMAIL', targetPersonId: personId, content: { to: ['r@example.test'], to_person_id: personId, subject: 'Hi', body: 'v1' }, expiresAt: null }),
  );

describe('authentication', () => {
  it('login links are single-use and unknown tokens are refused', async () => {
    const token = api.issueLoginToken();
    expect((await fetch(`${base}/login?t=${token}`, { redirect: 'manual' })).status).toBe(303);
    expect((await fetch(`${base}/login?t=${token}`, { redirect: 'manual' })).status).toBe(403);
    expect((await fetch(`${base}/login?t=forged`, { redirect: 'manual' })).status).toBe(403);
  });

  it('only the hash of the session token is stored', async () => {
    const { cookie } = await login();
    const raw = cookie.split('=')[1]!;
    const stored = (await db.query('SELECT token_hash FROM ui_sessions')).rows.map((r) => r.token_hash);
    expect(stored).not.toContain(raw);
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  });

  it('writes are refused without session, CSRF token, same origin or JSON', async () => {
    const a = await proposeEmail();
    const body = { principalId, actionId: a.id };
    const s = await login();
    expect((await post('/api/write/action/reject', body)).status).toBe(401);
    expect((await post('/api/write/action/reject', body, { cookie: s.cookie })).status).toBe(403);
    expect((await post('/api/write/action/reject', body, { cookie: s.cookie, csrf: 'wrong-token-wrong-token-wro' })).status).toBe(403);
    expect((await post('/api/write/action/reject', body, { ...s, origin: 'http://evil.example' })).status).toBe(403);
    expect((await post('/api/write/action/reject', body, { ...s, origin: null })).status).toBe(403);
    expect((await post('/api/write/action/reject', body, { ...s, type: 'text/plain' })).status).toBe(415);
    expect((await db.query('SELECT state FROM actions WHERE id = $1', [a.id])).rows[0].state).toBe('AWAITING_APPROVAL');
  });

  it('logout revokes the session', async () => {
    const s = await login();
    expect((await post('/api/logout', {}, s)).status).toBe(200);
    expect((await (await fetch(`${base}/api/session`, { headers: { cookie: s.cookie } })).json()).authenticated).toBe(false);
    expect((await post('/api/write/policy', { principalId, actionType: 'PREPARE_BRIEFING', mode: null }, s)).status).toBe(401);
  });
});

describe('writes through domain services', () => {
  it('approve with edits creates a principal version, executes once in the dev mailbox and verifies', async () => {
    const s = await login();
    const a = await proposeEmail();
    const r = await post('/api/write/action/approve', { principalId, actionId: a.id, edits: { body: 'edited by principal' } }, s);
    expect(r.status).toBe(200);
    expect((await r.json()).result.state).toBe('VERIFIED');
    const mail = (await db.query('SELECT body FROM dev_outbound_mail WHERE idempotency_key = $1', [`wendy-action:${a.id}`])).rows;
    expect(mail).toEqual([{ body: 'edited by principal' }]);
    const v = (await db.query('SELECT author FROM action_versions WHERE action_id = $1 ORDER BY version', [a.id])).rows.map((x) => x.author);
    expect(v.at(-1)).toBe('PRINCIPAL');
    // a second approval is a conflict, not a second send
    expect((await post('/api/write/action/approve', { principalId, actionId: a.id }, s)).status).toBe(409);
    expect((await db.query('SELECT count(*)::int n FROM dev_outbound_mail WHERE idempotency_key = $1', [`wendy-action:${a.id}`])).rows[0].n).toBe(1);
  });

  it('edits may only touch subject and body', async () => {
    const s = await login();
    const a = await proposeEmail();
    const r = await post('/api/write/action/approve', { principalId, actionId: a.id, edits: { to: ['attacker@example.test'] } }, s);
    expect(r.status).toBe(400);
    expect((await db.query('SELECT state FROM actions WHERE id = $1', [a.id])).rows[0].state).toBe('AWAITING_APPROVAL');
  });

  it('another principal cannot act on this principal\'s action or memory', async () => {
    const s = await login();
    const a = await proposeEmail();
    expect([404, 409]).toContain((await post('/api/write/action/reject', { principalId: otherPrincipalId, actionId: a.id }, s)).status);
    expect((await db.query('SELECT state FROM actions WHERE id = $1', [a.id])).rows[0].state).toBe('AWAITING_APPROVAL');
    const m = await pgRepositories().memories.write(db, { principalId, kind: 'PREFERENCE', subjectPersonId: personId, content: 'x', confidence: 0.7, evidence: [], writtenBy: 'WENDY', createdAt: new Date(), status: 'PROPOSED' });
    expect((await post('/api/write/memory/confirm', { principalId: otherPrincipalId, memoryId: m.id }, s)).status).toBe(409);
    expect((await post('/api/write/memory/confirm', { principalId, memoryId: m.id }, s)).status).toBe(200);
  });

  it('policy: external actions cannot be made automatic; invalid importance is rejected', async () => {
    const s = await login();
    expect((await post('/api/write/policy', { principalId, actionType: 'SEND_EMAIL', mode: 'AUTO' }, s)).status).toBe(409);
    expect((await post('/api/write/policy', { principalId, actionType: 'PREPARE_BRIEFING', mode: 'REQUIRE_APPROVAL' }, s)).status).toBe(200);
    expect((await post('/api/write/person/importance', { principalId, personId, importance: 2 }, s)).status).toBe(400);
    expect((await post('/api/write/person/importance', { principalId, personId, importance: 0.8 }, s)).status).toBe(200);
  });

  it('every write is in the ledger and the chain is valid', async () => {
    const types = (await db.query('SELECT DISTINCT event_type FROM audit_blocks')).rows.map((r) => r.event_type);
    expect(types).toEqual(expect.arrayContaining(['APPROVAL_POLICY_SET', 'PERSON_IMPORTANCE_SET', 'MEMORY_ACTIVE']));
    expect((await verifyLedgerIntegrity(db)).valid).toBe(true);
  });
});
