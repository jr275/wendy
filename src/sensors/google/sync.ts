/**
 * Google sync (read-only). First run: the last BACKFILL_DAYS of mail and calendar become CONTEXT
 * (no events, so nothing is sent to a model because of old mail). Afterwards: new mail since the last
 * sync is stored, and mail from a known person becomes EMAIL_RECEIVED (the proactive pipeline decides
 * whether it matters); the calendar window (yesterday → +60 days) is refreshed every time.
 * Everything goes through the Takeout importer's core (same people rule, same idempotency).
 */
import { appendAudit } from '../../audit/ledger.js';
import { withTx, type Db } from '../../db/db.js';
import type { ParsedMail } from '../../importers/mbox.js';
import { ExclusionsSchema, importItems, type ImportReport } from '../../importers/takeout.js';
import type { GoogleApi } from './api.js';

export const GOOGLE_SYNC = { backfillDays: 90, calendarAheadDays: 60, overlapMs: 10 * 60_000, concurrency: 8 };
export const PROVIDERS = { mail: 'GMAIL', calendar: 'GCAL' };
const DAY = 86_400_000;

export interface SyncResult {
  mode: 'backfill' | 'incremental';
  messagesListed: number;
  report: ImportReport;
}

/** Records (or refreshes) that this principal connected this Google account. */
export async function registerConnection(db: Db, principalId: string, account: string, scopes: string[], now: Date): Promise<void> {
  await withTx(db, async (tx) => {
    await tx.query(
      `INSERT INTO connected_sources(principal_id, provider, account_email, scopes, status, connected_at, updated_at)
       VALUES ($1,'google',$2,$3,'CONNECTED',$4,$4)
       ON CONFLICT (principal_id, provider) DO UPDATE SET account_email = EXCLUDED.account_email, scopes = EXCLUDED.scopes, status = 'CONNECTED', last_error = NULL, updated_at = EXCLUDED.updated_at`,
      [principalId, account, scopes, now],
    );
    await appendAudit(tx, { principalId, eventType: 'SOURCE_CONNECTED', actor: 'PRINCIPAL', subjectType: 'source', subjectId: 'google', payload: { account, scopes } });
  });
}

async function fetchAll(api: GoogleApi, ids: string[]): Promise<ParsedMail[]> {
  const out: ParsedMail[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      const m = await api.getMessage(id);
      if (m) out.push(m);
    }
  };
  await Promise.all(Array.from({ length: Math.min(GOOGLE_SYNC.concurrency, ids.length) }, worker));
  return out;
}

export async function syncGoogle(db: Db, api: GoogleApi, principalId: string, now: Date): Promise<SyncResult> {
  const src = (
    await db.query<{ account_email: string; backfill_completed_at: Date | null; mail_synced_until: Date | null }>(
      `SELECT account_email, backfill_completed_at, mail_synced_until FROM connected_sources WHERE principal_id = $1 AND provider = 'google' AND status = 'CONNECTED'`,
      [principalId],
    )
  ).rows[0];
  if (!src) throw new Error('Google is not connected for this principal');

  const backfill = !src.backfill_completed_at;
  const since = backfill ? new Date(now.getTime() - GOOGLE_SYNC.backfillDays * DAY) : new Date((src.mail_synced_until ?? now).getTime() - GOOGLE_SYNC.overlapMs);
  const calFrom = backfill ? since : new Date(now.getTime() - DAY);
  const calTo = new Date(now.getTime() + GOOGLE_SYNC.calendarAheadDays * DAY);

  try {
    const ids = await api.listMessageIds(since);
    const mails = await fetchAll(api, ids);
    const meetings = await api.listEvents(calFrom, calTo);
    const report = await importItems(db, {
      principalId,
      mails,
      meetings,
      since,
      until: now,
      meetingLookaheadDays: GOOGLE_SYNC.calendarAheadDays,
      aliases: [src.account_email],
      exclusions: ExclusionsSchema.parse({}), // the principal chose: read everything
      providers: PROVIDERS,
      origin: [`google:${src.account_email}`, backfill ? 'backfill' : 'incremental'],
      emitInboundEvents: !backfill,
    });
    await db.query(
      `UPDATE connected_sources SET mail_synced_until = $2, calendar_synced_at = $2, backfill_since = coalesce(backfill_since, $3),
              backfill_completed_at = coalesce(backfill_completed_at, $2), last_error = NULL, updated_at = $2
        WHERE principal_id = $1 AND provider = 'google'`,
      [principalId, now, backfill ? since : null],
    );
    return { mode: backfill ? 'backfill' : 'incremental', messagesListed: ids.length, report };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const reauth = /invalid_grant|unauthorized_client|401/.test(msg);
    await db.query(`UPDATE connected_sources SET last_error = $2, status = CASE WHEN $3 THEN 'NEEDS_REAUTH' ELSE status END, updated_at = $4 WHERE principal_id = $1 AND provider = 'google'`, [
      principalId,
      msg.slice(0, 500),
      reauth,
      now,
    ]);
    throw e;
  }
}
