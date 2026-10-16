/**
 * The real proxy (web/proxy.ts) and login/logout routes, called in-process with Request objects and stubbed environment
 * variables. No server, no network, no database; the password and secret are throwaway test values.
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { proxy } from '../../web/proxy.js';
import { POST as login, GET as loginPage } from '../../web/app/login/route.js';
import { POST as logout } from '../../web/app/logout/route.js';
import { hashPassword, SESSION_COOKIE } from '../../web/lib/auth.js';

const SECRET = 'route-test-secret-route-test-secret-12345';
const PASSWORD = 'throwaway-password-1';
let HASH = '';
beforeAll(async () => void (HASH = await hashPassword(PASSWORD, new Uint8Array(16).fill(9), 100_000)));
afterEach(() => vi.unstubAllEnvs());

const prodEnv = () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('WENDY_WEB_PASSWORD_HASH', HASH);
  vi.stubEnv('WENDY_SESSION_SECRET', SECRET);
};
const page = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) => new NextRequest(`https://wendy.example${path}`, { method: init.method, headers: { accept: 'text/html', ...init.headers } });
const form = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request('https://wendy.example/login', { method: 'POST', body: new URLSearchParams(fields), headers: { origin: 'https://wendy.example', host: 'wendy.example', ...headers } });
const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0]!;
const next = (r: Response) => r.headers.get('x-middleware-next') === '1';

describe('proxy', () => {
  it('production, signed out: a page redirects to /login (with the path), an API call is 401, /dev is 404', async () => {
    prodEnv();
    const r = await proxy(page('/memoria?x=1'));
    expect(r.status).toBe(307);
    expect(new URL(r.headers.get('location')!).pathname + new URL(r.headers.get('location')!).search).toBe('/login?next=%2Fmemoria%3Fx%3D1');
    expect((await proxy(page('/'))).headers.get('location')).toBe('https://wendy.example/login');
    expect((await proxy(new NextRequest('https://wendy.example/api/copilotkit/agent/wendy/run', { method: 'POST', headers: { accept: 'application/json' } }))).status).toBe(401);
    expect((await proxy(page('/dev/acoes'))).status).toBe(404);
    expect(next(await proxy(page('/login')))).toBe(true);
  });
  it('production without the secrets answers 503 everywhere', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect((await proxy(page('/'))).status).toBe(503);
    expect((await proxy(page('/login'))).status).toBe(503);
  });
  it('development without WENDY_AUTH lets everything through', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(next(await proxy(page('/memoria')))).toBe(true);
    expect(next(await proxy(page('/dev/acoes')))).toBe(true);
  });
});

describe('login and logout', () => {
  it('the right password sets a signed HttpOnly SameSite=Strict Secure cookie and redirects to the same-site path; that cookie then opens the proxy', async () => {
    prodEnv();
    const r = await login(form({ password: PASSWORD, next: '/memoria' }));
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/memoria');
    const set = r.headers.get('set-cookie')!;
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/', 'Max-Age=604800']) expect(set).toContain(attr);
    expect(next(await proxy(page('/memoria', { headers: { cookie: cookieOf(r) } })))).toBe(true);
    expect(next(await proxy(new NextRequest('https://wendy.example/api/x', { method: 'POST', headers: { cookie: cookieOf(r) } })))).toBe(true);
  });
  it('a wrong or empty password is 401 with no cookie; five failures from one address are then 429 even for the right password', async () => {
    prodEnv();
    const h = { 'x-forwarded-for': '203.0.113.9' };
    for (let i = 0; i < 5; i++) {
      const r = await login(form({ password: i % 2 ? '' : 'wrong' }, h));
      expect(r.status).toBe(401);
      expect(r.headers.get('set-cookie')).toBeNull();
    }
    const blocked = await login(form({ password: PASSWORD }, h));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('set-cookie')).toBeNull();
    expect((await login(form({ password: PASSWORD }, { 'x-forwarded-for': '203.0.113.10' }))).status).toBe(303); // another address is unaffected
  });
  it('a cross-site or origin-less POST is refused before the password is looked at', async () => {
    prodEnv();
    expect((await login(form({ password: PASSWORD }, { origin: 'https://evil.example' }))).status).toBe(403);
    const noOrigin = new Request('https://wendy.example/login', { method: 'POST', body: new URLSearchParams({ password: PASSWORD }), headers: { host: 'wendy.example' } });
    expect((await login(noOrigin)).status).toBe(403);
  });
  it('a real browser POST without Origin but with Sec-Fetch-Site: same-origin signs in; cross-site and bare ones are refused', async () => {
    prodEnv();
    const post = (headers: Record<string, string>) => new Request('https://wendy.example/login', { method: 'POST', body: new URLSearchParams({ password: PASSWORD }), headers: { host: 'wendy.example', 'x-forwarded-for': '198.51.100.77', ...headers } });
    expect((await login(post({ 'sec-fetch-site': 'same-origin' }))).status).toBe(303);
    expect((await login(post({ 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await login(post({}))).status).toBe(403);
  });
  it('the login page does not set Referrer-Policy: no-referrer (it makes browsers drop Origin on the form POST)', async () => {
    expect((await loginPage(new Request('https://wendy.example/login'))).headers.get('referrer-policy')).toBe('same-origin');
  });
  it('a hostile next never leaves the site', async () => {
    prodEnv();
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      const r = await login(form({ password: PASSWORD, next: bad }, { 'x-forwarded-for': `198.51.100.${bad.length}` }));
      expect(r.headers.get('location'), bad).toBe('/');
    }
  });
  it('answers 503 on login when the secrets are missing, and the page escapes what it echoes', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect((await login(form({ password: PASSWORD }, { 'x-forwarded-for': '192.0.2.1' }))).status).toBe(503);
    const html = await (await loginPage(new Request('https://wendy.example/login?next=/a%22%3E%3Cscript%3E'))).text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('name="next" value="/a&#34;&#62;&#60;script&#62;"');
  });
  it('logout clears the cookie, POST from this site only', async () => {
    prodEnv();
    const ok = await logout(new Request('https://wendy.example/logout', { method: 'POST', headers: { origin: 'https://wendy.example', host: 'wendy.example' } }));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=;`);
    expect(ok.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await logout(new Request('https://wendy.example/logout', { method: 'POST', headers: { origin: 'https://evil.example', host: 'wendy.example' } }))).status).toBe(403);
  });
});
