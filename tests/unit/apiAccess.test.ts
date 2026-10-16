/**
 * Running the read API off the principal's machine (src/security/apiAuth.ts) and how the web reaches it (web/lib/apiState.ts).
 * Pure: no server, no network, no environment. Tokens here are synthetic.
 */
import { describe, expect, it } from 'vitest';
import { checkBearer, checkBinding, hostedDecision, isLoopback, MIN_API_TOKEN } from '../../src/security/apiAuth.js';
import { apiHeaders, resolvePrincipalState } from '../../web/lib/apiState.js';

const TOKEN = 'api-token-api-token-api-token-0123456789';

describe('binding: no exposure without a credential', () => {
  it('loopback needs no token and runs in the normal (local) mode', () => {
    for (const h of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', ' 127.0.0.1 ']) expect(checkBinding(h, undefined), h).toEqual({ ok: true, hosted: false });
  });
  it('any other address is refused without a token — an empty or blank one too', () => {
    for (const h of ['0.0.0.0', '::', '10.0.0.5', 'wendy.internal', '192.168.1.2']) {
      for (const t of [undefined, '', '   ']) {
        const r = checkBinding(h, t);
        expect(r.ok, `${h} ${JSON.stringify(t)}`).toBe(false);
      }
    }
  });
  it('a token that is set but short is refused anywhere, even on loopback; a long one switches to hosted mode', () => {
    expect(checkBinding('127.0.0.1', 'short').ok).toBe(false);
    expect(checkBinding('127.0.0.1', 'x'.repeat(MIN_API_TOKEN - 1)).ok).toBe(false);
    expect(checkBinding('0.0.0.0', TOKEN)).toEqual({ ok: true, hosted: true });
    expect(checkBinding('127.0.0.1', TOKEN)).toEqual({ ok: true, hosted: true });
  });
  it('the refusal says what to do and does not contain the token', () => {
    const r = checkBinding('0.0.0.0', undefined);
    expect(r.ok === false && r.reason).toMatch(/WENDY_API_TOKEN/);
    const s = checkBinding('0.0.0.0', 'short');
    expect(JSON.stringify(s)).not.toContain('short');
    expect(isLoopback('0.0.0.0')).toBe(false);
  });
});

describe('bearer check', () => {
  it('accepts exactly "Bearer <token>"', () => {
    expect(checkBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });
  it('refuses missing, empty, wrong, prefixed, suffixed, other-scheme and different-length values', () => {
    for (const h of [undefined, '', TOKEN, `bearer ${TOKEN}`, `Bearer ${TOKEN} `, ` Bearer ${TOKEN}`, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `Basic ${TOKEN}`, 'Bearer ', 'Bearer']) {
      expect(checkBearer(h, TOKEN), String(h)).toBe(false);
    }
    expect(checkBearer(`Bearer ${TOKEN}`, '')).toBe(false); // no configured token never matches anything
  });
});

describe('hosted mode: only the read API, only with the token', () => {
  const bearer = `Bearer ${TOKEN}`;
  it('health answers without a token and carries no data', () => {
    expect(hostedDecision('GET', '/healthz', undefined, TOKEN)).toEqual({ health: true });
    expect(hostedDecision('POST', '/healthz', undefined, TOKEN)).toEqual({ allow: false, status: 404 });
  });
  it('a read route needs the token: without or with a wrong one it is 401, with it it is allowed', () => {
    for (const p of ['/api/principals', '/api/today', '/api/history', '/api/review', '/api/executions', '/api/ledger']) {
      expect(hostedDecision('GET', p, undefined, TOKEN), p).toEqual({ allow: false, status: 401 });
      expect(hostedDecision('GET', p, 'Bearer nope', TOKEN), p).toEqual({ allow: false, status: 401 });
      expect(hostedDecision('GET', p, bearer, TOKEN), p).toEqual({ allow: true });
    }
  });
  it('the inspector pages, its sign-in and its write API do not exist in hosted mode — even with the token', () => {
    for (const p of ['/', '/tecnico', '/login', '/login?t=abc', '/api/write', '/api/write/action/approve', '/index.html', '/favicon.ico']) {
      expect(hostedDecision('GET', p.split('?')[0]!, bearer, TOKEN), p).toEqual({ allow: false, status: 404 });
    }
  });
  it('only GET reaches the read API; any other method is 404 whatever the credentials', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(hostedDecision(m, '/api/today', bearer, TOKEN), m).toEqual({ allow: false, status: 404 });
  });
});

describe('web: how it calls the API', () => {
  it('sends the token in Authorization only when one is configured', () => {
    expect(apiHeaders(TOKEN)).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(apiHeaders(`  ${TOKEN}  `)).toEqual({ Authorization: `Bearer ${TOKEN}` });
    for (const t of [undefined, '', '   ']) expect(apiHeaders(t)).toEqual({});
  });
  it('"nobody registered" and "could not ask" are different states', async () => {
    expect(await resolvePrincipalState(async () => ({ id: 'p' }))).toEqual({ status: 'ok', principal: { id: 'p' } });
    expect(await resolvePrincipalState(async () => null)).toEqual({ status: 'none' });
    expect(await resolvePrincipalState(async () => { throw new Error('ECONNREFUSED'); })).toEqual({ status: 'down' });
    expect(JSON.stringify(await resolvePrincipalState(async () => { throw new Error(`boom ${TOKEN}`); }))).not.toContain(TOKEN);
  });
});
