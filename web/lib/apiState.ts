/**
 * How the web talks to Wendy's read API, kept free of `server-only` so it can be tested. Two small, honest rules:
 *  - when a token is configured it travels in the Authorization header (and only there);
 *  - if the API cannot be reached, the page says so. "Nobody registered" and "could not ask" are different states and are never mixed.
 */
export function apiHeaders(token: string | undefined): Record<string, string> {
  const t = (token ?? "").trim();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export type PrincipalState<P> = { status: "ok"; principal: P } | { status: "none" } | { status: "down" };

export async function resolvePrincipalState<P>(load: () => Promise<P | null>): Promise<PrincipalState<P>> {
  try {
    const p = await load();
    return p ? { status: "ok", principal: p } : { status: "none" };
  } catch {
    return { status: "down" };
  }
}

export const API_DOWN_TITLE = "Não consegui falar com a Wendy agora";
export const API_DOWN_BODY = "O serviço que guarda os seus dados não respondeu. Nada foi alterado. Tente de novo em instantes.";
