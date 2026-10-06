import type { Db, Queryable, Tx } from '../db/db.js';
import { hashOf } from '../util/hash.js';

export const GENESIS_HASH = 'GENESIS';
const APPEND_LOCK_KEY = 7_746_001; // advisory lock id serializing ledger appends

export interface AuditEntryInput {
  principalId: string | null;
  eventType: string;
  actor: string;
  subjectType: string;
  subjectId: string;
  payload: unknown;
}

export interface AuditBlock {
  seq: number;
  at: string;
  principal_id: string | null;
  event_type: string;
  actor: string;
  subject_type: string;
  subject_id: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
}

export type IntegrityResult = { valid: true; blockCount: number } | { valid: false; error: string; seq?: number };

export class LedgerIntegrityError extends Error {
  constructor(public readonly result: Extract<IntegrityResult, { valid: false }>) {
    super(`Audit ledger integrity failure: ${result.error}`);
  }
}

/** The hash covers every stored field of the block except the hash itself. */
export function blockHash(b: Omit<AuditBlock, 'hash'>): string {
  return hashOf({
    seq: b.seq,
    at: b.at,
    principal_id: b.principal_id,
    event_type: b.event_type,
    actor: b.actor,
    subject_type: b.subject_type,
    subject_id: b.subject_id,
    payload: b.payload,
    prev_hash: b.prev_hash,
  });
}

/**
 * Appends a block inside the caller's transaction, so the audited state change and its
 * audit record commit (or roll back) together. Refuses to append if the tip is inconsistent.
 */
export async function appendAudit(tx: Tx, entry: AuditEntryInput): Promise<AuditBlock> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [APPEND_LOCK_KEY]);
  const head = (await tx.query<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_head WHERE id = 1')).rows[0];
  const last = (await tx.query<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_blocks ORDER BY seq DESC LIMIT 1')).rows[0];

  if (!!head !== !!last || (head && last && (head.seq !== last.seq || head.hash !== last.hash))) {
    throw new LedgerIntegrityError({ valid: false, error: 'Ledger tip does not match head anchor; refusing to append' });
  }

  const seq = last ? last.seq + 1 : 1;
  const unhashed = {
    seq,
    at: new Date().toISOString(),
    principal_id: entry.principalId,
    event_type: entry.eventType,
    actor: entry.actor,
    subject_type: entry.subjectType,
    subject_id: entry.subjectId,
    payload: JSON.parse(JSON.stringify(entry.payload ?? null)),
    prev_hash: last ? last.hash : GENESIS_HASH,
  };
  const block: AuditBlock = { ...unhashed, hash: blockHash(unhashed) };

  await tx.query(
    `INSERT INTO audit_blocks(seq, at, principal_id, event_type, actor, subject_type, subject_id, payload, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [block.seq, block.at, block.principal_id, block.event_type, block.actor, block.subject_type, block.subject_id, JSON.stringify(block.payload), block.prev_hash, block.hash],
  );
  await tx.query(
    `INSERT INTO audit_head(id, seq, hash) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET seq = EXCLUDED.seq, hash = EXCLUDED.hash`,
    [block.seq, block.hash],
  );
  return block;
}

/**
 * Full verification from genesis to head. Detects altered fields, hash or prev_hash; removed,
 * duplicated or reordered blocks (sequence gaps / chain breaks); truncation and tip rewrites
 * (head anchor mismatch).
 */
export async function verifyLedgerIntegrity(db: Queryable): Promise<IntegrityResult> {
  const rows = (
    await db.query<AuditBlock & { at: Date }>(
      'SELECT seq, at, principal_id, event_type, actor, subject_type, subject_id, payload, prev_hash, hash FROM audit_blocks ORDER BY seq ASC',
    )
  ).rows;
  const head = (await db.query<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_head WHERE id = 1')).rows[0];

  if (rows.length === 0) {
    return head ? { valid: false, error: `Ledger empty but head anchor records block #${head.seq}` } : { valid: true, blockCount: 0 };
  }

  let prevHash = GENESIS_HASH;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const block = { ...r, at: new Date(r.at).toISOString() };
    if (block.seq !== i + 1) return { valid: false, error: `Sequence violation: expected #${i + 1}, found #${block.seq}`, seq: block.seq };
    if (block.prev_hash !== prevHash) return { valid: false, error: `Chain broken at #${block.seq}: prev_hash mismatch`, seq: block.seq };
    const { hash, ...unhashed } = block;
    if (blockHash(unhashed) !== hash) return { valid: false, error: `Tampering detected at #${block.seq}: hash mismatch`, seq: block.seq };
    prevHash = hash;
  }

  const last = rows[rows.length - 1]!;
  if (!head) return { valid: false, error: 'Head anchor missing for non-empty ledger' };
  if (head.seq !== last.seq || head.hash !== last.hash) {
    return { valid: false, error: `Head anchor mismatch: anchor #${head.seq}, ledger tip #${last.seq} (truncation or rewrite)` };
  }
  return { valid: true, blockCount: rows.length };
}

/** FAIL CLOSED: throws if the ledger is not intact. Call at boot and before any external execution. */
export async function assertLedgerIntegrity(db: Db | Queryable): Promise<void> {
  const result = await verifyLedgerIntegrity(db);
  if (!result.valid) throw new LedgerIntegrityError(result);
}
