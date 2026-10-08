/**
 * The principal's own tasks. Writes come only from approved actions (tools tasks.create / complete /
 * delete) and are idempotent on the action id, so a retried execution never duplicates a task.
 */
import { appendAudit } from '../audit/ledger.js';
import { withTx, type Db, type Queryable } from '../db/db.js';
import { newId } from '../util/hash.js';

export interface Task {
  id: string;
  title: string;
  notes: string | null;
  status: 'OPEN' | 'DONE' | 'DELETED';
  due_at: Date | null;
  source: Record<string, unknown>;
  created_by: 'PRINCIPAL' | 'WENDY';
  created_by_action: string | null;
  created_at: Date;
}

export interface NewTask {
  title: string;
  notes?: string | null;
  dueAt?: string | null;
  evidence?: { kind: string; id: string }[];
}

export class TaskError extends Error {}

const COLS = 'id, title, notes, status, due_at, source, created_by, created_by_action, created_at';

export async function listTasks(q: Queryable, principalId: string, status: Task['status'] = 'OPEN'): Promise<Task[]> {
  return (await q.query<Task>(`SELECT ${COLS} FROM tasks WHERE principal_id = $1 AND status = $2 ORDER BY due_at NULLS LAST, created_at`, [principalId, status])).rows;
}

export async function tasksByAction(q: Queryable, principalId: string, actionId: string): Promise<Task[]> {
  return (await q.query<Task>(`SELECT ${COLS} FROM tasks WHERE principal_id = $1 AND created_by_action = $2 ORDER BY created_at, title`, [principalId, actionId])).rows;
}

export async function getTask(q: Queryable, principalId: string, id: string): Promise<Task | null> {
  return (await q.query<Task>(`SELECT ${COLS} FROM tasks WHERE principal_id = $1 AND id = $2`, [principalId, id])).rows[0] ?? null;
}

export class TaskService {
  constructor(private readonly db: Db) {}

  /** Creates the tasks of one approved action, once. Returns what is stored for that action. */
  async createForAction(principalId: string, actionId: string, tasks: NewTask[], executionId: string | null, now: Date): Promise<Task[]> {
    return withTx(this.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tasks:${actionId}`]);
      const existing = await tasksByAction(tx, principalId, actionId);
      if (existing.length) return existing;
      for (const t of tasks) {
        await tx.query(
          `INSERT INTO tasks(id, principal_id, title, notes, status, due_at, source, created_by, created_by_action, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'OPEN',$5,$6,'WENDY',$7,$8,$8)`,
          [newId(), principalId, t.title, t.notes ?? null, t.dueAt ?? null, JSON.stringify({ executionId, evidence: t.evidence ?? [] }), actionId, now],
        );
      }
      await appendAudit(tx, { principalId, eventType: 'TASKS_CREATED', actor: 'WENDY', subjectType: 'action', subjectId: actionId, payload: { count: tasks.length, titles: tasks.map((t) => t.title) } });
      return tasksByAction(tx, principalId, actionId);
    });
  }

  /** Moves one task to DONE or DELETED. Idempotent: repeating the same move is a no-op. */
  async setStatus(principalId: string, taskId: string, to: 'DONE' | 'DELETED', actionId: string, now: Date): Promise<Task> {
    return withTx(this.db, async (tx) => {
      const t = (await tx.query<Task>(`SELECT ${COLS} FROM tasks WHERE principal_id = $1 AND id = $2 FOR UPDATE`, [principalId, taskId])).rows[0];
      if (!t) throw new TaskError(`task ${taskId} not found`);
      if (t.status === to) return t;
      if (t.status === 'DELETED') throw new TaskError(`task ${taskId} is deleted`);
      const updated = (
        await tx.query<Task>(
          `UPDATE tasks SET status = $3, updated_at = $4, completed_at = CASE WHEN $3 = 'DONE' THEN $4::timestamptz ELSE completed_at END,
                  deleted_at = CASE WHEN $3 = 'DELETED' THEN $4::timestamptz ELSE deleted_at END
           WHERE id = $1 AND principal_id = $2 RETURNING ${COLS}`,
          [taskId, principalId, to, now],
        )
      ).rows[0]!;
      await appendAudit(tx, { principalId, eventType: to === 'DONE' ? 'TASK_COMPLETED' : 'TASK_DELETED', actor: 'WENDY', subjectType: 'task', subjectId: taskId, payload: { from: t.status, to, actionId, title: t.title } });
      return updated;
    });
  }
}
