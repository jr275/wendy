/** Principal-owned settings about people (importance is set by the principal, never inferred). */
import { appendAudit } from '../audit/ledger.js';
import { withTx, type Db } from '../db/db.js';
import { newId } from '../util/hash.js';

export class PeopleService {
  constructor(private readonly db: Db) {}

  async setImportance(principalId: string, personId: string, importance: number | null, now: Date) {
    if (importance !== null && !(Number.isFinite(importance) && importance >= 0 && importance <= 1)) throw new Error('importance must be between 0 and 1, or null');
    return withTx(this.db, async (tx) => {
      const person = (await tx.query('SELECT id FROM people WHERE principal_id = $1 AND id = $2', [principalId, personId])).rows[0];
      if (!person) throw new Error('person not found for principal');
      const rel = (await tx.query<{ id: string; explicit_importance: number | null }>('SELECT id, explicit_importance FROM relationships WHERE principal_id = $1 AND person_id = $2 FOR UPDATE', [principalId, personId])).rows[0];
      if (rel) await tx.query('UPDATE relationships SET explicit_importance = $2 WHERE id = $1', [rel.id, importance]);
      else await tx.query(`INSERT INTO relationships(id, principal_id, person_id, kind, explicit_importance, source) VALUES ($1,$2,$3,'CONTACT',$4,'PRINCIPAL')`, [newId(), principalId, personId, importance]);
      await appendAudit(tx, { principalId, eventType: 'PERSON_IMPORTANCE_SET', actor: 'PRINCIPAL', subjectType: 'person', subjectId: personId, payload: { from: rel?.explicit_importance ?? null, to: importance, at: now.toISOString() } });
    });
  }
}
