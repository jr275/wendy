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

import { buildEveningPlan, type EveningPlan, type PlanTask } from './eveningPlan.js';

/** The 21:00 planning for tomorrow. SELECT only; tasks that are snoozed past now, archived or deleted are not read. */
export async function eveningPlanFor(q: Queryable, principalId: string, timeZone: string, now: Date = new Date()): Promise<EveningPlan> {
  const analysis = await agendaFor(q, principalId, timeZone, 2, now);
  const tasks = (await q.query<PlanTask>(`SELECT id, title, due_at, priority FROM tasks WHERE principal_id = $1 AND status = 'OPEN' AND deleted_at IS NULL AND archived_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= $2) ORDER BY due_at NULLS LAST, id`, [principalId, now])).rows;
  const hm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' });
  return buildEveningPlan({ now, timeZone, tomorrow: analysis.days[1]!, todayKey: analysis.days[0]!.day, tasks, hm });
}
