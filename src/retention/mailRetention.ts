/**
 * Retention of e-mail BODIES (docs/CONCIERGE_2_PLAN.md, risk E). The sender, recipients, subject and date of a message are kept; after N days the
 * BODY is emptied. Emptying is irreversible (the text is not stored anywhere else), so:
 *  - `planMailRetention` only counts, and is always safe;
 *  - `applyMailRetention` changes data and is run ONLY by the person, from scripts/mail-retention.ts with an explicit flag. Wendy never runs it by herself.
 * The ledger records the counts and the number of days — never any content.
 */
import { appendAudit } from '../audit/ledger.js';
import { withTx, type Db } from '../db/db.js';

export const MIN_KEEP_DAYS = 30;
export const MAX_KEEP_DAYS = 3650;

export interface RetentionPlan {
  keepDays: number;
  cutoff: string;
  /** Messages that still have a body. */
  withBody: number;
  /** Of those, the ones older than the cutoff: what would be emptied. */
  wouldEmpty: number;
  wouldFreeChars: number;
  oldest: string | null;
}

export function assertKeepDays(keepDays: number): number {
  if (!Number.isInteger(keepDays) || keepDays < MIN_KEEP_DAYS || keepDays > MAX_KEEP_DAYS) throw new Error(`keepDays precisa ser um número inteiro entre ${MIN_KEEP_DAYS} e ${MAX_KEEP_DAYS}`);
  return keepDays;
}
const cutoffOf = (now: Date, keepDays: number) => new Date(now.getTime() - keepDays * 86_400_000);

export async function planMailRetention(db: Db, principalId: string, keepDays: number, now: Date): Promise<RetentionPlan> {
  assertKeepDays(keepDays);
  const cutoff = cutoffOf(now, keepDays);
  const r = (
    await db.query<{ with_body: string; would_empty: string; chars: string | null; oldest: Date | null }>(
      `SELECT count(*) FILTER (WHERE body <> '') AS with_body,
              count(*) FILTER (WHERE body <> '' AND sent_at < $2) AS would_empty,
              sum(length(body)) FILTER (WHERE body <> '' AND sent_at < $2) AS chars,
              min(sent_at) FILTER (WHERE body <> '') AS oldest
         FROM messages WHERE principal_id = $1`,
      [principalId, cutoff],
    )
  ).rows[0]!;
  return { keepDays, cutoff: cutoff.toISOString(), withBody: Number(r.with_body), wouldEmpty: Number(r.would_empty), wouldFreeChars: Number(r.chars ?? 0), oldest: r.oldest?.toISOString() ?? null };
}

/** Empties the bodies older than `keepDays`. IRREVERSIBLE. Only this principal's messages; the rest of each message stays. */
export async function applyMailRetention(db: Db, principalId: string, keepDays: number, now: Date): Promise<{ emptied: number }> {
  assertKeepDays(keepDays);
  const cutoff = cutoffOf(now, keepDays);
  return withTx(db, async (tx) => {
    const r = await tx.query(`UPDATE messages SET body = '' WHERE principal_id = $1 AND body <> '' AND sent_at < $2`, [principalId, cutoff]);
    const emptied = r.rowCount ?? 0;
    await appendAudit(tx, { principalId, eventType: 'MAIL_BODIES_EMPTIED', actor: 'PRINCIPAL', subjectType: 'messages', subjectId: principalId, payload: { keepDays, emptied } });
    return { emptied };
  });
}
