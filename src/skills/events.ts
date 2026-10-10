/** Appends one structured event to a skill run's log (skill.*, tool.*, permission.*, call.*). */
import type { Queryable } from '../db/db.js';

export async function appendExecutionEvent(q: Queryable, executionId: string, type: string, name: string | null, data: unknown, at: Date): Promise<void> {
  await q.query(
    `INSERT INTO skill_execution_events(execution_id, seq, type, name, data, at)
     VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM skill_execution_events WHERE execution_id = $1), $2, $3, $4, $5)`,
    [executionId, type, name, JSON.stringify(data ?? {}), at],
  );
}

export async function executionEvents(q: Queryable, executionId: string, typePrefix: string): Promise<{ seq: number; type: string; name: string | null; data: Record<string, unknown>; at: Date }[]> {
  return (
    await q.query<{ seq: number; type: string; name: string | null; data: Record<string, unknown>; at: Date }>(
      `SELECT seq, type, name, data, at FROM skill_execution_events WHERE execution_id = $1 AND type LIKE $2 ORDER BY seq`,
      [executionId, `${typePrefix}%`],
    )
  ).rows;
}
