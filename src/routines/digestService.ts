/**
 * What the person sees of the reading digest, and the two things they can do to it: mark an item read, and "update now".
 * Reads are scoped by principal; writes go through the same runner as the 07:30 run (one run per local day, same lease, same ledger).
 */
import { appendAudit } from '../audit/ledger.js';
import { withTx, type Db } from '../db/db.js';
import { researchDigestHandler } from './researchDigest.js';
import { runDueRoutines, type RunReport } from './runner.js';

export interface DigestItemView {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  /** The source's own abstract, shortened — never written by Wendy. */
  summary: string | null;
  why: string | null;
  read: boolean;
  addedAt: string;
}
export interface DigestView {
  routine: { enabled: boolean; localTime: string; timezone: string; pausedUntil: string | null } | null;
  lastRun: { date: string; status: string; error: string | null } | null;
  items: DigestItemView[];
}

export async function digestFor(db: Db, principalId: string, limit = 30): Promise<DigestView> {
  const r = (await db.query<{ enabled: boolean; local_time: string; timezone: string; paused_until: Date | null }>(`SELECT enabled, to_char(local_time, 'HH24:MI') AS local_time, timezone, paused_until FROM routines WHERE principal_id = $1 AND kind = 'research_digest'`, [principalId])).rows[0];
  const run = (await db.query<{ run_date: Date; status: string; error: string | null }>(`SELECT to_char(rr.run_date, 'YYYY-MM-DD') AS run_date, rr.status, rr.error FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id WHERE r.principal_id = $1 AND r.kind = 'research_digest' ORDER BY rr.run_date DESC, rr.started_at DESC LIMIT 1`, [principalId])).rows[0];
  const items = (await db.query(`SELECT id, title, source_url, source_name, published_at, summary, why, read_at, created_at FROM digest_items WHERE principal_id = $1 AND kind = 'article' ORDER BY (read_at IS NULL) DESC, created_at DESC, score DESC NULLS LAST LIMIT $2`, [principalId, limit])).rows as Array<{ id: string; title: string; source_url: string; source_name: string; published_at: Date | null; summary: string | null; why: string | null; read_at: Date | null; created_at: Date }>;
  return {
    routine: r ? { enabled: r.enabled, localTime: r.local_time, timezone: r.timezone, pausedUntil: r.paused_until?.toISOString() ?? null } : null,
    lastRun: run ? { date: String(run.run_date), status: run.status, error: run.error } : null,
    items: items.map((i) => ({ id: i.id, title: i.title, url: i.source_url, source: i.source_name, publishedAt: i.published_at?.toISOString() ?? null, summary: i.summary, why: i.why, read: i.read_at !== null, addedAt: i.created_at.toISOString() })),
  };
}

export async function markDigestRead(db: Db, principalId: string, itemId: string, at: Date): Promise<{ marked: boolean }> {
  return withTx(db, async (tx) => {
    const r = await tx.query(`UPDATE digest_items SET read_at = COALESCE(read_at, $3) WHERE id = $1 AND principal_id = $2`, [itemId, principalId, at]);
    if (!r.rowCount) throw Object.assign(new Error('item not found'), { status: 404 });
    await appendAudit(tx, { principalId, eventType: 'DIGEST_ITEM_READ', actor: 'PRINCIPAL', subjectType: 'digest_item', subjectId: itemId, payload: {} });
    return { marked: true };
  });
}

/** "Atualizar agora": the same run as the scheduled one, now. Still at most one finished run per local day. */
export async function refreshDigest(db: Db, principalId: string, at: Date, handler = researchDigestHandler()): Promise<RunReport | { outcome: 'no_routine' }> {
  const reports = await runDueRoutines(db, { handlers: { research_digest: handler } }, at, { force: true, onlyKind: 'research_digest', principalId });
  return reports[0] ?? { outcome: 'no_routine' };
}

export interface MarketAlertView {
  id: string;
  symbol: string;
  kind: string;
  observedAt: string;
  explanation: string;
  seen: boolean;
}
/** Market observations of the last `days` days (monitoring only), newest first. */
export async function marketAlertsFor(db: Db, principalId: string, days = 7, maxSymbols = 12): Promise<{ routine: DigestView['routine']; lastRun: DigestView['lastRun']; alerts: MarketAlertView[]; symbolsWithAlerts: number }> {
  const r = (await db.query<{ enabled: boolean; local_time: string; timezone: string; paused_until: Date | null }>(`SELECT enabled, to_char(local_time, 'HH24:MI') AS local_time, timezone, paused_until FROM routines WHERE principal_id = $1 AND kind = 'market_watch'`, [principalId])).rows[0];
  const run = (await db.query<{ run_date: Date; status: string; error: string | null }>(`SELECT to_char(rr.run_date, 'YYYY-MM-DD') AS run_date, rr.status, rr.error FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id WHERE r.principal_id = $1 AND r.kind = 'market_watch' ORDER BY rr.run_date DESC, rr.started_at DESC LIMIT 1`, [principalId])).rows[0];
  const rows = (await db.query<{ id: string; symbol: string; kind: string; observed_at: Date; explanation: string; seen_at: Date | null; value: number; threshold: number }>(`SELECT id, symbol, kind, observed_at, explanation, seen_at, value, threshold FROM market_alerts WHERE principal_id = $1 AND created_at > now() - make_interval(days => $2) ORDER BY created_at DESC, symbol LIMIT 500`, [principalId, days])).rows;
  // Strongest first: more kinds of signal on the same asset at once, then how far past its threshold the strongest one went.
  const strength = new Map<string, { kinds: Set<string>; ratio: number }>();
  for (const a of rows) {
    const s = strength.get(a.symbol) ?? { kinds: new Set<string>(), ratio: 0 };
    s.kinds.add(a.kind);
    s.ratio = Math.max(s.ratio, a.threshold > 0 ? Math.abs(a.value) / a.threshold : 0);
    strength.set(a.symbol, s);
  }
  const top = new Set([...strength.entries()].sort((x, y) => y[1].kinds.size - x[1].kinds.size || y[1].ratio - x[1].ratio || x[0].localeCompare(y[0])).slice(0, maxSymbols).map(([s]) => s));
  const order = [...top];
  return {
    symbolsWithAlerts: strength.size,
    routine: r ? { enabled: r.enabled, localTime: r.local_time, timezone: r.timezone, pausedUntil: r.paused_until?.toISOString() ?? null } : null,
    lastRun: run ? { date: String(run.run_date), status: run.status, error: run.error } : null,
    alerts: rows.filter((a) => top.has(a.symbol)).sort((a, b) => order.indexOf(a.symbol) - order.indexOf(b.symbol)).map((a) => ({ id: a.id, symbol: a.symbol, kind: a.kind, observedAt: a.observed_at.toISOString(), explanation: a.explanation, seen: a.seen_at !== null })),
  };
}
