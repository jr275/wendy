/**
 * Reads the records the weekly review is built from. Read-only (SELECT only), scoped to one principal. The review itself is pure
 * (weekly.ts); this file only fetches and hands over.
 */
import type { Queryable } from '../db/db.js';
import { buildWeeklyReview, WINDOW_DAYS, type ReviewInput, type WeeklyReview } from './weekly.js';

const DAY = 86_400_000;

export async function loadReviewInput(q: Queryable, principalId: string, timeZone: string, now: Date): Promise<ReviewInput> {
  const end = new Date(now.getTime() + WINDOW_DAYS * DAY);
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const [tasks, commitments, meetings, awaiting, closedTasks, closedCommitments] = await Promise.all([
    q.query<{ id: string; title: string; due_at: Date | null }>(`SELECT id, title, due_at FROM tasks WHERE principal_id = $1 AND status = 'OPEN' AND deleted_at IS NULL`, [principalId]),
    q.query<{ id: string; description: string; due_at: Date | null }>(`SELECT id, description, due_at FROM commitments WHERE principal_id = $1 AND status = 'OPEN'`, [principalId]),
    q.query<{ id: string; title: string; starts_at: Date; ends_at: Date | null }>(
      `SELECT id, title, starts_at, ends_at FROM meetings WHERE principal_id = $1 AND status <> 'CANCELLED' AND starts_at >= $2 AND starts_at <= $3`,
      [principalId, now, end],
    ),
    q.query<{ id: string; action_type: string; subject: string | null }>(
      `SELECT a.id, a.action_type, v.content->>'subject' AS subject
         FROM actions a JOIN action_versions v ON v.action_id = a.id AND v.version = a.current_version
        WHERE a.principal_id = $1 AND a.state = 'AWAITING_APPROVAL' ORDER BY a.expires_at NULLS LAST, a.created_at`,
      [principalId],
    ),
    q.query<{ n: string }>(`SELECT count(*) AS n FROM tasks WHERE principal_id = $1 AND status = 'DONE' AND completed_at >= $2`, [principalId, weekAgo]),
    q.query<{ n: string }>(`SELECT count(*) AS n FROM commitments WHERE principal_id = $1 AND completed_at >= $2`, [principalId, weekAgo]),
  ]);
  return {
    now,
    timeZone,
    tasks: tasks.rows,
    commitments: commitments.rows,
    meetings: meetings.rows,
    awaiting: awaiting.rows.map((a) => ({ id: a.id, label: a.subject ? `${a.action_type}: ${a.subject}` : `${a.action_type} aguardando sua aprovação` })),
    closedLastWeek: { tasks: Number(closedTasks.rows[0]?.n ?? 0), commitments: Number(closedCommitments.rows[0]?.n ?? 0) },
  };
}

export async function weeklyReview(q: Queryable, principalId: string, timeZone: string, now: Date = new Date()): Promise<WeeklyReview> {
  return buildWeeklyReview(await loadReviewInput(q, principalId, timeZone, now));
}
