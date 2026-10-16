/**
 * Runs the daily routines that are due. Called from the worker's clock, never from a browser.
 *
 * Safety properties (each one is tested):
 *  - ONE run per routine per local day, no matter how many processes try at once: whoever inserts the (routine, date) row wins; the others see
 *    no row and do nothing. A restart or a second worker cannot duplicate a delivery.
 *  - A run that dies is recovered, not repeated blindly: its lease expires, it is taken again (up to MAX_ATTEMPTS), and the items already stored
 *    cannot be stored twice (UNIQUE (principal_id, source_url)).
 *  - Failures are recorded (with secrets masked) and retried later the same day; they never leave a half-written list: the items and the end of
 *    the run commit together.
 *  - The audit ledger gets "started" and "finished" with COUNTS only, never the content.
 */
import { appendAudit } from '../audit/ledger.js';
import { redactSecrets } from '../cognition/resilience.js';
import { withTx, type Db } from '../db/db.js';
import { newId } from '../util/hash.js';
import { decide, LEASE_MIN, periodStart, type RoutineRow, type RunRow } from './schedule.js';

export interface NewDigestItem {
  kind: 'article' | 'quote' | 'challenge';
  sourceName: string;
  sourceUrl: string;
  title: string;
  publishedAt: Date | null;
  summary: string | null;
  why: string | null;
  score: number | null;
  evidence: Record<string, unknown>;
}

export interface HandlerResult {
  items: NewDigestItem[];
  /** A note kept with a finished run (for example, which sources failed). */
  note?: string;
}
export type RoutineHandler = (ctx: { db: Db; principalId: string; routine: RoutineRow; config: Record<string, unknown>; now: Date; runDate: string }) => Promise<HandlerResult>;

export interface RunnerDeps {
  /** Only kinds with a handler can run; the others are left alone (no run row is created for them). */
  handlers: Partial<Record<string, RoutineHandler>>;
  /** When a run ENDS (the worker passes the real clock, so `finished_at` minus `started_at` is the real duration). Default: the `now` of the tick, which keeps tests deterministic. */
  clock?: () => Date;
}

export interface RunReport {
  routineId: string;
  kind: string;
  runDate: string;
  outcome: 'done' | 'failed' | 'skipped' | 'lost_race';
  detail?: string;
  stored?: number;
}

const msg = (e: unknown) => redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 500);

export async function runDueRoutines(db: Db, deps: RunnerDeps, now: Date, opts: { force?: boolean; onlyKind?: string; principalId?: string } = {}): Promise<RunReport[]> {
  const routines = (await db.query<RoutineRow & { config: Record<string, unknown> }>(`SELECT id, principal_id, kind, enabled, local_time::text AS local_time, timezone, paused_until, cadence, weekday, day_of_month, config FROM routines WHERE enabled ORDER BY created_at`)).rows;
  const reports: RunReport[] = [];
  for (const r of routines) {
    if (opts.onlyKind && r.kind !== opts.onlyKind) continue;
    if (opts.principalId && r.principal_id !== opts.principalId) continue;
    const handler = deps.handlers[r.kind];
    if (!handler) continue;
    const runDate = periodStart(r, now);
    const today = (await db.query<RunRow & { id: string }>(`SELECT id, status, attempts, lease_until, started_at, finished_at FROM routine_runs WHERE routine_id = $1 AND run_date = $2`, [r.id, runDate])).rows[0] ?? null;
    // "Run now" ignores the time of day but never the one-run-per-day rule.
    const d = decide(opts.force ? { ...r, local_time: '00:00' } : r, now, today);
    if (d.action === 'skip') {
      reports.push({ routineId: r.id, kind: r.kind, runDate, outcome: 'skipped', detail: d.reason });
      continue;
    }
    const lease = new Date(now.getTime() + LEASE_MIN * 60_000);
    let runId: string | null = null;
    if (d.action === 'claim') {
      const ins = await db.query<{ id: string }>(
        `INSERT INTO routine_runs(id, routine_id, principal_id, run_date, status, attempts, lease_until, started_at) VALUES ($1,$2,$3,$4,'RUNNING',1,$5,$6) ON CONFLICT (routine_id, run_date) DO NOTHING RETURNING id`,
        [newId(), r.id, r.principal_id, runDate, lease, now],
      );
      runId = ins.rows[0]?.id ?? null;
    } else {
      // Atomic: only one process can move a FAILED / expired run back to RUNNING.
      const upd = await db.query<{ id: string }>(
        `UPDATE routine_runs SET status = 'RUNNING', attempts = attempts + 1, lease_until = $2, started_at = $3, finished_at = NULL, error = NULL
          WHERE id = $1 AND attempts < 3 AND (status = 'FAILED' OR (status = 'RUNNING' AND lease_until < $3)) RETURNING id`,
        [today!.id, lease, now],
      );
      runId = upd.rows[0]?.id ?? null;
    }
    if (!runId) {
      reports.push({ routineId: r.id, kind: r.kind, runDate, outcome: 'lost_race' });
      continue;
    }
    const id = runId;
    const endedAt = () => (deps.clock ?? (() => now))();
    await withTx(db, (tx) => appendAudit(tx, { principalId: r.principal_id, eventType: 'ROUTINE_RUN_STARTED', actor: 'WENDY', subjectType: 'routine', subjectId: r.id, payload: { kind: r.kind, runDate, runId: id } }));
    try {
      const res = await handler({ db, principalId: r.principal_id, routine: r, config: r.config ?? {}, now, runDate });
      const stored = await withTx(db, async (tx) => {
        let n = 0;
        for (const it of res.items) {
          const ins = await tx.query(
            `INSERT INTO digest_items(id, run_id, principal_id, kind, source_name, source_url, title, published_at, summary, why, score, evidence, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (principal_id, source_url) DO NOTHING`,
            [newId(), id, r.principal_id, it.kind, it.sourceName, it.sourceUrl, it.title, it.publishedAt, it.summary, it.why, it.score, JSON.stringify(it.evidence), now],
          );
          n += ins.rowCount ?? 0;
        }
        await tx.query(`UPDATE routine_runs SET status = 'DONE', finished_at = $2, lease_until = NULL, error = $3 WHERE id = $1`, [id, endedAt(), res.note ? redactSecrets(res.note).slice(0, 500) : null]);
        await appendAudit(tx, { principalId: r.principal_id, eventType: 'ROUTINE_RUN_FINISHED', actor: 'WENDY', subjectType: 'routine', subjectId: r.id, payload: { kind: r.kind, runDate, runId: id, stored: n, offered: res.items.length } });
        return n;
      });
      reports.push({ routineId: r.id, kind: r.kind, runDate, outcome: 'done', stored, ...(res.note ? { detail: res.note } : {}) });
    } catch (e) {
      const m = msg(e);
      await withTx(db, async (tx) => {
        await tx.query(`UPDATE routine_runs SET status = 'FAILED', finished_at = $2, lease_until = NULL, error = $3 WHERE id = $1`, [id, endedAt(), m]);
        await appendAudit(tx, { principalId: r.principal_id, eventType: 'ROUTINE_RUN_FAILED', actor: 'WENDY', subjectType: 'routine', subjectId: r.id, payload: { kind: r.kind, runDate, runId: id } });
      });
      reports.push({ routineId: r.id, kind: r.kind, runDate, outcome: 'failed', detail: m });
    }
  }
  return reports;
}
