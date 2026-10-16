/**
 * Guards for running Wendy's read API (the inspector) anywhere but the principal's own machine. Pure: no server, no environment, no clock.
 *
 *  - Local (default): bound to 127.0.0.1, no token needed. Nothing changes.
 *  - Hosted (WENDY_API_TOKEN set): only the read API answers, and only with `Authorization: Bearer <token>`.
 *  - It REFUSES to start on any address other than loopback unless the token is set and long enough, so exposing the API without a
 *    credential is not a state the process can get into by a missing variable.
 */
import crypto from 'node:crypto';

export const MIN_API_TOKEN = 32;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export const isLoopback = (host: string): boolean => LOOPBACK.has(host.trim().toLowerCase());

export type Binding = { ok: true; hosted: boolean } | { ok: false; reason: string };

/** May the API start on `host` with this `token`? `hosted` is true when the token is set (the restricted, token-only mode). */
export function checkBinding(host: string, token: string | undefined): Binding {
  const t = (token ?? '').trim();
  if (t && t.length < MIN_API_TOKEN) return { ok: false, reason: `WENDY_API_TOKEN é curto demais (mínimo ${MIN_API_TOKEN} caracteres).` };
  if (!isLoopback(host) && !t) return { ok: false, reason: `Recusado: o inspector não sobe em ${host} sem WENDY_API_TOKEN. Fora de 127.0.0.1 a API de leitura precisa de credencial.` };
  return { ok: true, hosted: !!t };
}

/** Constant-time check of `Authorization: Bearer <token>`. Missing or malformed header is false. */
export function checkBearer(header: string | undefined, token: string): boolean {
  if (!token || !header) return false;
  const got = Buffer.from(header);
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export type HostedDecision = { allow: true } | { allow: false; status: 401 | 404 };

/**
 * What a hosted (token) inspector does with a request. Health is open (no data). Everything outside the read API — the inspector's own pages, its
 * sign-in and its write API (which has a different login for a person at the machine) — does not exist here. Reads need the token.
 */
export function hostedDecision(method: string, pathname: string, header: string | undefined, token: string): HostedDecision | { health: true } {
  if (method === 'GET' && pathname === '/healthz') return { health: true };
  if (!pathname.startsWith('/api/') || pathname === '/api/write' || pathname.startsWith('/api/write/')) return { allow: false, status: 404 };
  if (method !== 'GET') return { allow: false, status: 404 };
  return checkBearer(header, token) ? { allow: true } : { allow: false, status: 401 };
}
