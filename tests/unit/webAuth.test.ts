/**
 * Web sign-in (web/lib/auth.ts). Pure: no database, no network, no process.env, no server. Passwords and secrets here are
 * throwaway test values. The proxy and the login route are thin wrappers over these functions; what they decide is tested here.
 */
import { describe, expect, it } from 'vitest';
import { requestIsSameSite, authMisconfigured, authMode, createSession, decideAccess, hashPassword, LoginLimiter, safeNext, sameOrigin, SESSION_TTL_S, verifyPassword, verifySession, type AuthEnv } from '../../web/lib/auth.js';

const SECRET = 'test-secret-test-secret-test-secret-123456';
const NOW = 1_800_000_000_000;
const FAST = 100_000; // the lowest iteration count verifyPassword accepts

describe('password hash', () => {
  it('verifies the right password and nothing else', async () => {
    const h = await hashPassword('correct horse battery', new Uint8Array(16).fill(7), FAST);
    expect(h).toMatch(/^pbkdf2\$100000\$[\w-]+\$[\w-]+$/);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    for (const bad of ['', 'correct horse batter', 'Correct horse battery', ' correct horse battery']) expect(await verifyPassword(bad, h), JSON.stringify(bad)).toBe(false);
  });
  it('a different salt gives a different hash for the same password', async () => {
    expect(await hashPassword('same-password-12', new Uint8Array(16).fill(1), FAST)).not.toBe(await hashPassword('same-password-12', new Uint8Array(16).fill(2), FAST));
  });
  it('a malformed, missing or weakened stored value never verifies', async () => {
    const h = await hashPassword('pw-pw-pw-pw-pw', new Uint8Array(16).fill(3), FAST);
    const [, , salt, hash] = h.split('$');
    for (const bad of [undefined, null, '', 'plain', 'pbkdf2$100000$x', `sha1$100000$${salt}$${hash}`, `pbkdf2$1$${salt}$${hash}`, `pbkdf2$abc$${salt}$${hash}`, `pbkdf2$999999999$${salt}$${hash}`, `pbkdf2$100000$***$***`]) {
      expect(await verifyPassword('pw-pw-pw-pw-pw', bad as string), String(bad)).toBe(false);
    }
  });
});

describe('session token', () => {
  it('is accepted until it expires, to the second', async () => {
    const t = await createSession(SECRET, NOW);
    expect(await verifySession(SECRET, t, NOW)).toBe(true);
    expect(await verifySession(SECRET, t, NOW + (SESSION_TTL_S - 1) * 1000)).toBe(true);
    expect(await verifySession(SECRET, t, NOW + SESSION_TTL_S * 1000)).toBe(false);
  });
  it('is refused when tampered with, signed by another secret, or malformed', async () => {
    const t = await createSession(SECRET, NOW);
    const [v, exp, sig] = t.split('.');
    const farExp = String(Number(exp) + 10_000_000);
    for (const bad of [`${v}.${farExp}.${sig}`, `v2.${exp}.${sig}`, `${v}.${exp}.${sig}x`, `${v}.${exp}`, `${v}.${exp}.${sig}.extra`, `${v}.abc.${sig}`, '', 'garbage', `${v}.${exp}.`]) {
      expect(await verifySession(SECRET, bad, NOW), bad).toBe(false);
    }
    expect(await verifySession('another-secret-another-secret-another-1', t, NOW)).toBe(false);
  });
  it('is never accepted without a usable secret or a token', async () => {
    const t = await createSession(SECRET, NOW);
    expect(await verifySession(undefined, t, NOW)).toBe(false);
    expect(await verifySession('short', t, NOW)).toBe(false);
    expect(await verifySession(SECRET, undefined, NOW)).toBe(false);
    expect(await verifySession(SECRET, null, NOW)).toBe(false);
  });
});

describe('same-origin check and the post-login redirect', () => {
  it('accepts only an Origin whose host is the host the request went to', () => {
    expect(sameOrigin('https://wendy.example', 'wendy.example')).toBe(true);
    expect(sameOrigin('http://localhost:3010', 'localhost:3010')).toBe(true);
    for (const [o, h] of [['https://evil.example', 'wendy.example'], ['https://wendy.example.evil.example', 'wendy.example'], [null, 'wendy.example'], ['https://wendy.example', null], ['not a url', 'wendy.example'], ['', 'wendy.example']] as const) {
      expect(sameOrigin(o, h), `${o} ${h}`).toBe(false);
    }
  });
  it('safeNext keeps a same-site path and turns everything else into "/"', () => {
    expect(safeNext('/memoria')).toBe('/memoria');
    expect(safeNext('/insight/abc?x=1')).toBe('/insight/abc?x=1');
    for (const bad of [undefined, null, '', 'https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'memoria', '/login', '/login?next=/', '/a\nb']) expect(safeNext(bad), String(bad)).toBe('/');
  });
});

describe('requestIsSameSite (Origin, or Sec-Fetch-Site when the browser omits Origin)', () => {
  it('Origin decides when present: same host passes, any other fails even if Sec-Fetch-Site claims same-origin', () => {
    expect(requestIsSameSite({ origin: 'https://wendy.example', host: 'wendy.example' })).toBe(true);
    expect(requestIsSameSite({ origin: 'https://evil.example', host: 'wendy.example', secFetchSite: 'same-origin' })).toBe(false);
    expect(requestIsSameSite({ origin: 'null', host: 'wendy.example', secFetchSite: 'same-origin' })).toBe(false);
  });
  it('without Origin (a browser POST under Referrer-Policy: no-referrer) only Sec-Fetch-Site: same-origin passes', () => {
    expect(requestIsSameSite({ host: 'wendy.example', secFetchSite: 'same-origin' })).toBe(true);
    for (const s of ['cross-site', 'same-site', 'none', '', null, undefined]) expect(requestIsSameSite({ host: 'wendy.example', secFetchSite: s }), String(s)).toBe(false);
    expect(requestIsSameSite({})).toBe(false);
  });
});

describe('failed sign-in limiter', () => {
  it('blocks the 5th failure inside the window, per key, and forgets after the window or a success', () => {
    const l = new LoginLimiter(5, 1000);
    for (let i = 0; i < 4; i++) l.fail('a', 0);
    expect(l.blocked('a', 0)).toBe(false);
    l.fail('a', 0);
    expect(l.blocked('a', 500)).toBe(true);
    expect(l.blocked('b', 500)).toBe(false);
    expect(l.blocked('a', 1000)).toBe(false);
    l.fail('c', 0);
    l.reset('c');
    expect(l.blocked('c', 0)).toBe(false);
  });
  it('is bounded in memory', () => {
    const l = new LoginLimiter(5, 60_000, 3);
    for (const k of ['a', 'b', 'c', 'd', 'e']) l.fail(k, 0);
    expect((l as unknown as { fails: Map<string, number[]> }).fails.size).toBeLessThanOrEqual(3);
  });
});

describe('access decision (what the proxy does)', () => {
  const prod: AuthEnv = { nodeEnv: 'production', passwordHash: 'pbkdf2$100000$s$h', sessionSecret: SECRET };
  const html = 'text/html,application/xhtml+xml';
  it('production requires sign-in; development does not unless WENDY_AUTH=on', () => {
    expect(authMode({ nodeEnv: 'production' })).toBe('required');
    expect(authMode({ nodeEnv: 'development' })).toBe('off');
    expect(authMode({})).toBe('off');
    expect(authMode({ nodeEnv: 'development', wendyAuth: ' ON ' })).toBe('required');
    expect(authMode({ nodeEnv: 'production', wendyAuth: 'off' })).toBe('required'); // production cannot be switched off
  });
  it('development with auth off lets everything through, including what production would refuse', async () => {
    for (const path of ['/', '/api/copilotkit/run', '/memoria']) expect(await decideAccess({ path, method: 'POST', cookie: undefined }, { nodeEnv: 'development' }, NOW)).toBe('allow');
  });
  it('production without a hash or with a short secret answers "unavailable" for every path, the login page included (fail closed)', async () => {
    for (const env of [{ nodeEnv: 'production' }, { ...prod, passwordHash: undefined }, { ...prod, passwordHash: 'garbage' }, { ...prod, sessionSecret: undefined }, { ...prod, sessionSecret: 'short' }] as AuthEnv[]) {
      expect(authMisconfigured(env)).toBe(true);
      for (const path of ['/', '/login', '/api/x']) expect(await decideAccess({ path, method: 'GET', cookie: undefined, accept: html }, env, NOW), path).toBe('unavailable');
    }
    expect(authMisconfigured(prod)).toBe(false);
  });
  it('without a session: pages go to /login, everything else is 401, and /login stays open', async () => {
    expect(await decideAccess({ path: '/memoria', method: 'GET', cookie: undefined, accept: html }, prod, NOW)).toBe('login');
    expect(await decideAccess({ path: '/login', method: 'GET', cookie: undefined, accept: html }, prod, NOW)).toBe('allow');
    expect(await decideAccess({ path: '/login', method: 'POST', cookie: undefined }, prod, NOW)).toBe('allow');
    for (const [path, method, accept] of [['/api/copilotkit/run', 'POST', 'application/json'], ['/api/copilotkit/info', 'GET', html], ['/memoria', 'POST', html], ['/memoria', 'GET', 'application/json'], ['/memoria', 'GET', undefined], ['/dev/acoes', 'GET', html]] as const) {
      const r = await decideAccess({ path, method, cookie: undefined, accept }, prod, NOW);
      expect(r, `${method} ${path}`).toBe(path === '/dev/acoes' ? 'login' : 'unauthorized');
    }
  });
  it('a valid session opens every path; an expired, forged or other-secret one does not', async () => {
    const good = await createSession(SECRET, NOW);
    for (const path of ['/', '/memoria', '/api/copilotkit/run']) expect(await decideAccess({ path, method: 'POST', cookie: good }, prod, NOW + 1000)).toBe('allow');
    expect(await decideAccess({ path: '/', method: 'GET', cookie: good, accept: html }, prod, NOW + (SESSION_TTL_S + 1) * 1000)).toBe('login');
    expect(await decideAccess({ path: '/api/x', method: 'GET', cookie: `${good}x` }, prod, NOW)).toBe('unauthorized');
    expect(await decideAccess({ path: '/api/x', method: 'GET', cookie: await createSession('other-secret-other-secret-other-secret-9', NOW) }, prod, NOW)).toBe('unauthorized');
  });
});
