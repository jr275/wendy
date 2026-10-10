/**
 * Cancelling a skill run at the principal's request — safely, in ONE transaction:
 *   - scoped to the principal (another principal's run is "not found");
 *   - a finished run is left as it is (already_finished); repeating a cancel is harmless;
 *   - if any action of the run (or its children) was already APPROVED and has not finished
 *     (approved / executing / executed-not-verified), nothing is cancelled: an approved effect is
 *     never cancelled or reverted from here (not_cancellable);
 *   - actions still waiting (PROPOSED / STAGED / AWAITING_APPROVAL) are cancelled with the run, so
 *     a later approval can never execute an effect for a run the principal stopped;
 *   - the run and its unfinished children become `cancelled` (skill.cancelled event).
 * Rows are locked (run first, then actions), so a concurrent approval either lands first (and the
 * cancel is refused) or finds its action cancelled (and the approval is refused).
 */
import { transition, type ActionRow } from '../actions/actions.js';
import { withTx, type Db } from '../db/db.js';
import { appendExecutionEvent } from './events.js';
import type { ExecutionError } from './types.js';

export type CancelResult =
  | { status: 'cancelled'; runs: string[]; cancelledActions: string[] }
  | { status: 'already_finished'; state: string }
  | { status: 'not_cancellable'; reason: string; actionId: string }
  | { status: 'not_found' };

const TERMINAL_RUN = ['completed', 'failed', 'cancelled'];
const WAITING_ACTION = ['PROPOSED', 'STAGED', 'AWAITING_APPROVAL'];
const APPROVED_IN_PROGRESS = ['APPROVED', 'EXECUTING', 'EXECUTED'];

export async function cancelExecution(db: Db, principalId: string, executionId: string, reason: string, now: Date): Promise<CancelResult> {
  return withTx(db, async (tx) => {
    const root = (await tx.query<{ id: string; status: string; skill_id: string }>(`SELECT id, status, skill_id FROM skill_executions WHERE id = $1 AND principal_id = $2 FOR UPDATE`, [executionId, principalId])).rows[0];
    if (!root) return { status: 'not_found' };
    if (TERMINAL_RUN.includes(root.status)) return { status: 'already_finished', state: root.status };

    // The run and its descendants (composition), locked.
    const runs = (
      await tx.query<{ id: string; status: string; skill_id: string }>(
        `WITH RECURSIVE tree AS (SELECT id FROM skill_executions WHERE id = $1 UNION ALL SELECT e.id FROM skill_executions e JOIN tree t ON e.parent_id = t.id)
         SELECT s.id, s.status, s.skill_id FROM skill_executions s JOIN tree USING (id) WHERE s.principal_id = $2 FOR UPDATE OF s`,
        [executionId, principalId],
      )
    ).rows;
    const actions = (
      await tx.query<ActionRow>(`SELECT * FROM actions WHERE principal_id = $1 AND skill_execution_id = ANY($2::uuid[]) ORDER BY created_at FOR UPDATE`, [principalId, runs.map((r) => r.id)])
    ).rows;

    const inProgress = actions.find((a) => APPROVED_IN_PROGRESS.includes(a.state));
    if (inProgress) return { status: 'not_cancellable', reason: `an approved action is in progress (${inProgress.action_type}, ${inProgress.state})`, actionId: inProgress.id };

    const cancelledActions: string[] = [];
    for (const a of actions.filter((x) => WAITING_ACTION.includes(x.state))) {
      await transition(tx, a, 'CANCELLED', 'PRINCIPAL', `cancelled with its run: ${reason}`);
      cancelledActions.push(a.id);
    }
    const open = runs.filter((r) => !TERMINAL_RUN.includes(r.status));
    for (const r of open) {
      await tx.query(`UPDATE skill_executions SET status = 'cancelled', error = $2, wait = NULL, locked_until = NULL, updated_at = $3, completed_at = $3 WHERE id = $1`, [
        r.id,
        JSON.stringify({ code: 'REJECTED', message: reason, step: null, retryable: false } satisfies ExecutionError),
        now,
      ]);
      await appendExecutionEvent(tx, r.id, 'skill.cancelled', r.skill_id, { reason, by: 'principal', cancelledActions }, now);
    }
    return { status: 'cancelled', runs: open.map((r) => r.id), cancelledActions };
  });
}
