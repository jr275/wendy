/**
 * Commitments with the principal in the loop.
 *
 *   PROPOSED (extracted from a message) ──confirm──▶ OPEN ──complete──▶ DONE
 *        └──discard──▶ CANCELLED ◀──cancel──┘
 *
 * Only OPEN commitments drive detectors and reasoning; PROPOSED ones never reach the model.
 * A proposal is accepted only if its quote appears literally in the source message (code checks
 * it; the model cannot invent a promise). Every transition is principal-scoped, locked and audited.
 */
import { appendAudit } from '../audit/ledger.js';
import { withTx, type Db, type Tx } from '../db/db.js';
import type { Commitment } from '../domain/types.js';
import { newId } from '../util/hash.js';

export class CommitmentTransitionError extends Error {}

type Status = Commitment['status'];
const ALLOWED: Record<Status, Status[]> = {
  PROPOSED: ['OPEN', 'CANCELLED'],
  OPEN: ['DONE', 'CANCELLED'],
  DONE: [],
  CANCELLED: [],
};

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export interface CommitmentProposal {
  principalId: string;
  owner: 'PRINCIPAL' | 'COUNTERPARTY';
  counterpartyPersonId: string;
  description: string;
  dueAt: Date;
  sourceMessageId: string;
  quote: string;
  source: string; // e.g. 'WENDY'
  now: Date;
}

/** Records a proposed commitment. Rejects it unless the quote is literally in the source message. */
export async function proposeCommitment(tx: Tx, p: CommitmentProposal): Promise<string> {
  const msg = (await tx.query<{ subject: string; body: string }>('SELECT subject, body FROM messages WHERE principal_id = $1 AND id = $2', [p.principalId, p.sourceMessageId])).rows[0];
  if (!msg) throw new CommitmentTransitionError('source message not found for principal');
  const quote = p.quote.replace(/\s+/g, ' ').trim();
  if (!quote || !norm(`${msg.subject}\n${msg.body}`).includes(norm(p.quote))) throw new CommitmentTransitionError('quote is not literally present in the source message');
  const person = (await tx.query('SELECT 1 FROM people WHERE principal_id = $1 AND id = $2', [p.principalId, p.counterpartyPersonId])).rows[0];
  if (!person) throw new CommitmentTransitionError('counterparty not found for principal');
  const dup = (
    await tx.query<{ id: string }>(
      `SELECT id FROM commitments WHERE principal_id = $1 AND source_message_id = $2 AND lower(source_quote) = lower($3) AND status IN ('PROPOSED','OPEN')`,
      [p.principalId, p.sourceMessageId, quote],
    )
  ).rows[0];
  if (dup) return dup.id;
  const id = newId();
  await tx.query(
    `INSERT INTO commitments(id, principal_id, owner, counterparty_person_id, description, due_at, status, source_message_id, source_quote, source, created_at, status_changed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'PROPOSED',$7,$8,$9,$10,$10)`,
    [id, p.principalId, p.owner, p.counterpartyPersonId, p.description, p.dueAt, p.sourceMessageId, quote, p.source, p.now],
  );
  await appendAudit(tx, { principalId: p.principalId, eventType: 'COMMITMENT_PROPOSED', actor: p.source, subjectType: 'commitment', subjectId: id, payload: { sourceMessageId: p.sourceMessageId, dueAt: p.dueAt.toISOString() } });
  return id;
}

async function lock(tx: Tx, principalId: string, id: string): Promise<Commitment> {
  const c = (await tx.query<Commitment>('SELECT * FROM commitments WHERE principal_id = $1 AND id = $2 FOR UPDATE', [principalId, id])).rows[0];
  if (!c) throw new CommitmentTransitionError(`commitment ${id} not found for principal`);
  return c;
}

async function move(tx: Tx, c: Commitment, to: Status, reason: string | null, now: Date, dueAt: Date | null = null) {
  if (!ALLOWED[c.status].includes(to)) throw new CommitmentTransitionError(`illegal commitment transition ${c.status} -> ${to}`);
  await tx.query(
    `UPDATE commitments SET status = $3, status_changed_at = $4, status_reason = $5,
            completed_at = CASE WHEN $3 = 'DONE' THEN $4 ELSE completed_at END,
            due_at = coalesce($6, due_at)
     WHERE principal_id = $1 AND id = $2`,
    [c.principal_id, c.id, to, now, reason, dueAt],
  );
  await appendAudit(tx, {
    principalId: c.principal_id,
    eventType: `COMMITMENT_${to}`,
    actor: 'PRINCIPAL',
    subjectType: 'commitment',
    subjectId: c.id,
    payload: { from: c.status, to, reason, dueAt: dueAt?.toISOString() ?? null },
  });
}

export class CommitmentService {
  constructor(private readonly db: Db) {}

  /** Principal confirms a proposed commitment, optionally correcting the due date. */
  confirm(principalId: string, id: string, now: Date, dueAt?: Date) {
    return withTx(this.db, async (tx) => move(tx, await lock(tx, principalId, id), 'OPEN', 'confirmed by principal', now, dueAt ?? null));
  }

  /** Principal rejects a proposed commitment (it was not a real promise). */
  discard(principalId: string, id: string, reason: string | null, now: Date) {
    return withTx(this.db, async (tx) => {
      const c = await lock(tx, principalId, id);
      if (c.status !== 'PROPOSED') throw new CommitmentTransitionError('only proposed commitments can be discarded; cancel an open one instead');
      await move(tx, c, 'CANCELLED', reason ?? 'discarded by principal', now);
    });
  }

  complete(principalId: string, id: string, now: Date) {
    return withTx(this.db, async (tx) => move(tx, await lock(tx, principalId, id), 'DONE', 'marked done by principal', now));
  }

  cancel(principalId: string, id: string, reason: string | null, now: Date) {
    return withTx(this.db, async (tx) => {
      const c = await lock(tx, principalId, id);
      if (c.status !== 'OPEN') throw new CommitmentTransitionError('only open commitments can be cancelled');
      await move(tx, c, 'CANCELLED', reason ?? 'cancelled by principal', now);
    });
  }

  /** Changes the due date of a proposed or open commitment (no state change). */
  reschedule(principalId: string, id: string, dueAt: Date, now: Date) {
    return withTx(this.db, async (tx) => {
      const c = await lock(tx, principalId, id);
      if (c.status !== 'PROPOSED' && c.status !== 'OPEN') throw new CommitmentTransitionError(`cannot reschedule a ${c.status} commitment`);
      await tx.query('UPDATE commitments SET due_at = $3 WHERE principal_id = $1 AND id = $2', [principalId, id, dueAt]);
      await appendAudit(tx, {
        principalId,
        eventType: 'COMMITMENT_RESCHEDULED',
        actor: 'PRINCIPAL',
        subjectType: 'commitment',
        subjectId: id,
        payload: { from: c.due_at.toISOString(), to: dueAt.toISOString(), at: now.toISOString() },
      });
    });
  }
}
