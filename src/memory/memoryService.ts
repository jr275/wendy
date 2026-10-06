/**
 * Memory lifecycle with the principal in the loop.
 *
 *   PROPOSED (deduced by Wendy) ──confirm──▶ ACTIVE ──supersede──▶ SUPERSEDED
 *        └──────────retract──────────▶ RETRACTED ◀──retract──┘
 *
 * Only ACTIVE memories reach reasoning. Every transition is principal-scoped, row-locked and audited.
 */
import { appendAudit } from '../audit/ledger.js';
import { withTx, type Db, type Tx } from '../db/db.js';
import type { Memory } from '../domain/types.js';
import { newId } from '../util/hash.js';

export class MemoryTransitionError extends Error {}

const ALLOWED: Record<Memory['status'], Memory['status'][]> = {
  PROPOSED: ['ACTIVE', 'RETRACTED'],
  ACTIVE: ['SUPERSEDED', 'RETRACTED', 'ACTIVE'], // ACTIVE→ACTIVE = reconfirmation
  SUPERSEDED: [],
  RETRACTED: [],
};

async function lockMemory(tx: Tx, principalId: string, id: string): Promise<Memory> {
  const m = (await tx.query<Memory>('SELECT * FROM memories WHERE principal_id = $1 AND id = $2 FOR UPDATE', [principalId, id])).rows[0];
  if (!m) throw new MemoryTransitionError(`memory ${id} not found for principal`);
  return m;
}

async function move(tx: Tx, m: Memory, to: Memory['status'], actor: string, reason: string | null, now: Date): Promise<void> {
  if (!ALLOWED[m.status].includes(to)) throw new MemoryTransitionError(`illegal memory transition ${m.status} -> ${to}`);
  await tx.query(
    `UPDATE memories SET status = $3, status_changed_at = $4, status_reason = $5,
            last_confirmed_at = CASE WHEN $3 = 'ACTIVE' THEN $4 ELSE last_confirmed_at END,
            confirmed_by = CASE WHEN $3 = 'ACTIVE' THEN $6 ELSE confirmed_by END
     WHERE principal_id = $1 AND id = $2`,
    [m.principal_id, m.id, to, now, reason, actor],
  );
  await appendAudit(tx, { principalId: m.principal_id, eventType: `MEMORY_${to}`, actor, subjectType: 'memory', subjectId: m.id, payload: { from: m.status, to, reason } });
}

export class MemoryService {
  constructor(private readonly db: Db) {}

  /** Principal confirms a proposed memory (or reconfirms an active one). */
  confirm(principalId: string, memoryId: string, now: Date) {
    return withTx(this.db, async (tx) => move(tx, await lockMemory(tx, principalId, memoryId), 'ACTIVE', 'PRINCIPAL', 'confirmed by principal', now));
  }

  /** Principal discards a memory (proposed or active). */
  retract(principalId: string, memoryId: string, reason: string | null, now: Date) {
    return withTx(this.db, async (tx) => move(tx, await lockMemory(tx, principalId, memoryId), 'RETRACTED', 'PRINCIPAL', reason, now));
  }

  /** Records a contradiction between memories (from validated reasoning); idempotent per memory set. */
  async recordConflict(tx: Tx, principalId: string, memoryIds: string[], description: string, source: { kind: string; id: string }, now: Date): Promise<string | null> {
    const ids = [...new Set(memoryIds)].sort();
    if (ids.length < 2) return null;
    const existing = (await tx.query<{ id: string }>(`SELECT id FROM memory_conflicts WHERE principal_id = $1 AND status = 'OPEN' AND memory_ids @> $2::uuid[] AND memory_ids <@ $2::uuid[]`, [principalId, ids])).rows[0];
    if (existing) return existing.id;
    const id = newId();
    await tx.query(
      `INSERT INTO memory_conflicts(id, principal_id, memory_ids, description, source, status, detected_at) VALUES ($1,$2,$3,$4,$5,'OPEN',$6)`,
      [id, principalId, ids, description, JSON.stringify(source), now],
    );
    await appendAudit(tx, { principalId, eventType: 'MEMORY_CONFLICT_DETECTED', actor: 'WENDY', subjectType: 'memory_conflict', subjectId: id, payload: { memoryIds: ids, source } });
    return id;
  }

  /** Principal resolves a conflict: kept memories become (or stay) ACTIVE, the others are SUPERSEDED. */
  resolveConflict(principalId: string, conflictId: string, keepIds: string[], now: Date) {
    return withTx(this.db, async (tx) => {
      const c = (await tx.query<{ id: string; memory_ids: string[]; status: string }>('SELECT * FROM memory_conflicts WHERE principal_id = $1 AND id = $2 FOR UPDATE', [principalId, conflictId])).rows[0];
      if (!c) throw new MemoryTransitionError('conflict not found for principal');
      if (c.status !== 'OPEN') throw new MemoryTransitionError('conflict already resolved');
      if (keepIds.length === 0 || keepIds.some((k) => !c.memory_ids.includes(k))) throw new MemoryTransitionError('keep ids must be a non-empty subset of the conflict');
      for (const id of c.memory_ids) {
        const m = await lockMemory(tx, principalId, id);
        if (keepIds.includes(id)) {
          if (m.status !== 'ACTIVE') await move(tx, m, 'ACTIVE', 'PRINCIPAL', `kept in conflict ${conflictId}`, now);
        } else if (m.status === 'ACTIVE') {
          await move(tx, m, 'SUPERSEDED', 'PRINCIPAL', `superseded in conflict ${conflictId}`, now);
          await tx.query('UPDATE memories SET superseded_by = $3 WHERE principal_id = $1 AND id = $2', [principalId, id, keepIds[0]]);
        } else if (m.status === 'PROPOSED') {
          await move(tx, m, 'RETRACTED', 'PRINCIPAL', `rejected in conflict ${conflictId}`, now);
        }
      }
      await tx.query(`UPDATE memory_conflicts SET status = 'RESOLVED', resolved_at = $3, resolution = $4 WHERE principal_id = $1 AND id = $2`, [principalId, conflictId, now, JSON.stringify({ keep: keepIds })]);
      await appendAudit(tx, { principalId, eventType: 'MEMORY_CONFLICT_RESOLVED', actor: 'PRINCIPAL', subjectType: 'memory_conflict', subjectId: conflictId, payload: { keep: keepIds } });
    });
  }
}
