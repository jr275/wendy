/** Web pages and documents exactly as read, so claims can cite them later (captured_sources). */
import type { Queryable } from '../db/db.js';
import { hashOf, newId } from '../util/hash.js';

export interface CapturedSource {
  id: string;
  kind: 'web_page' | 'document';
  uri: string;
  title: string | null;
  content: string;
  fetched_at: Date;
}

export async function captureSource(
  q: Queryable,
  s: { principalId: string; kind: CapturedSource['kind']; uri: string; title: string | null; content: string; executionId?: string; now: Date },
): Promise<CapturedSource> {
  const contentHash = hashOf({ content: s.content });
  const row = (
    await q.query<CapturedSource>(
      `INSERT INTO captured_sources(id, principal_id, kind, uri, title, content, content_hash, bytes, execution_id, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (principal_id, kind, uri, content_hash) DO UPDATE SET fetched_at = captured_sources.fetched_at
       RETURNING id, kind, uri, title, content, fetched_at`,
      [newId(), s.principalId, s.kind, s.uri, s.title, s.content, contentHash, Buffer.byteLength(s.content), s.executionId ?? null, s.now],
    )
  ).rows[0]!;
  return row;
}

export async function getSources(q: Queryable, principalId: string, ids: string[]): Promise<CapturedSource[]> {
  if (!ids.length) return [];
  return (await q.query<CapturedSource>('SELECT id, kind, uri, title, content, fetched_at FROM captured_sources WHERE principal_id = $1 AND id = ANY($2::uuid[])', [principalId, ids])).rows;
}
