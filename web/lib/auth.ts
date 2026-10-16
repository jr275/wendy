/**
 * Sign-in for the web (one person: the owner). Pure and runtime-neutral: Web Crypto only, no process.env, no next/*, so the proxy,
 * the login route and the unit tests all use the same code.
 *
 * What it is: a password (stored only as a PBKDF2-SHA256 hash) that opens a signed, expiring session cookie (HMAC-SHA256).
 * What it is not: multi-user, MFA, or a replacement for a network perimeter. Failed-attempt limiting lives in memory of one process,
 * so on a platform that runs many instances it slows guessing down but does not bound it; use a strong password.
 *
 * Mode (decided by decideAccess from NODE_ENV + WENDY_AUTH):
 *   production            sign-in is REQUIRED. If the password hash or the session secret is missing, EVERYTHING answers 503 (fail closed).
 *   development, WENDY_AUTH=on   same as production (to test it locally).
 *   development otherwise        no sign-in: the app behaves as it always did on 127.0.0.1.
 */

export const SESSION_COOKIE = 'wendy_session';
export const SESSION_TTL_S = 7 * 24 * 3600;
export const PBKDF2_ITERATIONS = 310_000;
const VERSION = 'v1';

const enc = new TextEncoder();

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string): Uint8Array => {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(p + '='.repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

/** Constant-time over equal-length inputs; different lengths are simply not equal (length is not a secret here). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256));
}

/** `pbkdf2$<iterations>$<salt>$<hash>` — what goes in WENDY_WEB_PASSWORD_HASH. Used by scripts/web-password-hash.ts. */
export async function hashPassword(password: string, salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)), iterations = PBKDF2_ITERATIONS): Promise<string> {
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(await pbkdf2(password, salt, iterations))}`;
}

export async function verifyPassword(password: string, stored: string | undefined | null): Promise<boolean> {
  const parts = (stored ?? '').trim().split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 5_000_000) return false;
  try {
    return timingSafeEqual(await pbkdf2(password, unb64(parts[2]!), iterations), unb64(parts[3]!));
  } catch {
    return false;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
const sign = async (secret: string, data: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));

/** `v1.<expiry epoch seconds>.<signature>` */
export async function createSession(secret: string, nowMs: number, ttlS = SESSION_TTL_S): Promise<string> {
  const body = `${VERSION}.${Math.floor(nowMs / 1000) + ttlS}`;
  return `${body}.${b64(await sign(secret, body))}`;
}

export async function verifySession(secret: string | undefined, token: string | undefined | null, nowMs: number): Promise<boolean> {
  if (!secret || secret.length < 32 || !token) return false;
  const [v, exp, sig, extra] = token.split('.');
  if (v !== VERSION || !exp || !sig || extra !== undefined || !/^\d{1,12}$/.test(exp)) return false;
  if (Number(exp) * 1000 <= nowMs) return false;
  try {
    return timingSafeEqual(await sign(secret, `${v}.${exp}`), unb64(sig));
  } catch {
    return false;
  }
}

/** A state-changing request must come from this site: its Origin host equals the Host the request was sent to. Missing Origin is refused. */
export function sameOrigin(origin: string | null | undefined, host: string | null | undefined): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Is this state-changing request from this site? Origin is the proof when the browser sends it. Some browsers omit it on a same-origin POST
 * (e.g. when the page sets Referrer-Policy: no-referrer); then Sec-Fetch-Site, which the browser sets and a page cannot forge, must say
 * "same-origin". With neither, the request is refused.
 */
export function requestIsSameSite(h: { origin?: string | null; host?: string | null; secFetchSite?: string | null }): boolean {
  if (h.origin) return sameOrigin(h.origin, h.host);
  return h.secFetchSite === 'same-origin';
}

export interface AuthEnv {
  nodeEnv?: string;
  wendyAuth?: string;
  passwordHash?: string;
  sessionSecret?: string;
}

export type AuthMode = 'required' | 'off';
export const authMode = (e: AuthEnv): AuthMode => (e.nodeEnv === 'production' || (e.wendyAuth ?? '').trim().toLowerCase() === 'on' ? 'required' : 'off');
/** Required but not usable: no hash, a hash that cannot verify, or a secret that is too short to be one. */
export const authMisconfigured = (e: AuthEnv): boolean => !e.passwordHash || e.passwordHash.split('$').length !== 4 || !e.sessionSecret || e.sessionSecret.length < 32;

export type Access = 'allow' | 'login' | 'unauthorized' | 'unavailable';

/**
 * What the proxy does with a request. `/login` is always reachable (when auth is usable) so a person can sign in; everything else,
 * pages and API alike, needs a valid session. A page gets a redirect to /login; an API call or a non-GET gets 401 (never a redirect, never a body).
 */
export async function decideAccess(req: { path: string; method: string; cookie: string | undefined; accept?: string | null }, env: AuthEnv, nowMs: number): Promise<Access> {
  if (authMode(env) === 'off') return 'allow';
  if (authMisconfigured(env)) return 'unavailable';
  if (req.path === '/login') return 'allow';
  if (await verifySession(env.sessionSecret, req.cookie, nowMs)) return 'allow';
  const isPage = req.method === 'GET' && !req.path.startsWith('/api/') && (req.accept ?? '').includes('text/html');
  return isPage ? 'login' : 'unauthorized';
}

/** A same-site path to return to after signing in; anything else (another site, protocol-relative, backslashes, the login page itself) becomes "/". */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\') || /[\u0000-\u001f]/.test(next) || next === '/login' || next.startsWith('/login?')) return '/';
  return next;
}

/** In-memory limiter for failed sign-ins: 5 failures in 15 minutes from one key blocks that key until the window passes. */
export class LoginLimiter {
  private readonly fails = new Map<string, number[]>();
  constructor(private readonly max = 5, private readonly windowMs = 15 * 60_000, private readonly maxKeys = 1000) {}
  private recent(key: string, now: number): number[] {
    const r = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (r.length) this.fails.set(key, r);
    else this.fails.delete(key);
    return r;
  }
  blocked(key: string, now: number): boolean {
    return this.recent(key, now).length >= this.max;
  }
  fail(key: string, now: number): void {
    const r = this.recent(key, now);
    r.push(now);
    this.fails.set(key, r);
    if (this.fails.size > this.maxKeys) this.fails.delete(this.fails.keys().next().value as string);
  }
  reset(key: string): void {
    this.fails.delete(key);
  }
}
