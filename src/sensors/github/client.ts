/**
 * Reads the principal's pull-request movements from GitHub (GraphQL, one request per cycle), READ ONLY.
 *
 *  - Nothing is requested when the scope is empty or missing (deny by default): no repository → no network call at all.
 *  - `fetch` is injected, so tests run with no network. Nothing here reads a file or a clock; the caller passes the token and the scope.
 *  - The token goes only in the Authorization header. It is never put in an error message, and a response body is never copied into one
 *    (GitHub can echo what it received).
 */
import { buildQuery, deriveMovements, GithubResponseError, type Movement } from './movements.js';
import { type GithubScope } from './scope.js';

export class GithubAuthError extends Error {}
export class GithubRateLimitError extends Error {
  constructor(readonly resetAt: Date | null) {
    super('O GitHub limitou as consultas por agora.');
  }
}
export class GithubUnavailableError extends Error {}

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;
}

export interface GithubFetchInput {
  token: string;
  user: string;
  scope: GithubScope | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const ENDPOINT = 'https://api.github.com/graphql';

export async function fetchMovements(i: GithubFetchInput): Promise<Movement[]> {
  if (!i.scope || !i.scope.owner || !i.scope.repos.size) return []; // nothing in scope: nothing to ask
  const { query, variables } = buildQuery(i.scope.owner);
  const doFetch: FetchLike = i.fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${i.token}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json', 'User-Agent': 'wendy-github-sensor' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(i.timeoutMs ?? 15_000),
    });
  } catch {
    throw new GithubUnavailableError('Não consegui falar com o GitHub agora.');
  }
  if (res.status === 401) throw new GithubAuthError('O token do GitHub foi recusado (expirou ou foi revogado).');
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    throw new GithubRateLimitError(Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null);
  }
  if (res.status === 403) throw new GithubAuthError('O token do GitHub não tem permissão para isto.');
  if (res.status < 200 || res.status >= 300) throw new GithubUnavailableError(`O GitHub respondeu com erro (${res.status}).`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new GithubResponseError('Resposta do GitHub em formato inesperado.');
  }
  if (body && typeof body === 'object' && 'errors' in body && (body as { errors?: unknown }).errors) throw new GithubResponseError('O GitHub recusou a consulta.');
  return deriveMovements(body, i.scope.owner, i.scope);
}
