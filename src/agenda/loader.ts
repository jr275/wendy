/** Reads the meetings the agenda analysis is built from. SELECT only, scoped to one principal; cancelled meetings are not read. */
import type { Queryable } from '../db/db.js';
import { analyzeAgenda, type AgendaAnalysis } from './analysis.js';

export async function agendaFor(q: Queryable, principalId: string, timeZone: string, days = 7, now: Date = new Date()): Promise<AgendaAnalysis> {
  const span = Math.min(31, Math.max(1, Math.floor(days)));
  // A day of margin on both sides so a meeting near midnight in the principal's timezone is never cut off by the UTC window.
  const from = new Date(now.getTime() - 86_400_000);
  const to = new Date(now.getTime() + (span + 1) * 86_400_000);
  const rows = (await q.query<{ id: string; title: string; starts_at: Date; ends_at: Date }>(`SELECT id, title, starts_at, ends_at FROM meetings WHERE principal_id = $1 AND status <> 'CANCELLED' AND starts_at >= $2 AND starts_at < $3 ORDER BY starts_at, id`, [principalId, from, to])).rows;
  return analyzeAgenda({ now, timeZone, meetings: rows, days: span });
}
