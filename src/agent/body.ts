/** Request-body helpers for the agent's HTTP server. Pure, so the failure modes are unit-tested instead of only exercised by a crash. */
export const MAX_BODY_BYTES = 2_000_000;

/** Parses a JSON body without ever throwing: a malformed body is a 400 for the caller, never an unhandled rejection that takes the process down. */
export function safeJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw || '{}') };
  } catch {
    return { ok: false };
  }
}

/** Reads a request stream as text, stopping at `limit` characters (null = too large). */
export async function readLimited(stream: AsyncIterable<string | Uint8Array>, limit = MAX_BODY_BYTES): Promise<string | null> {
  let body = '';
  for await (const chunk of stream) {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (body.length > limit) return null;
  }
  return body;
}
