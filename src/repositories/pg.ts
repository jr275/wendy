import type { Queryable } from '../db/db.js';
import type { Commitment, Meeting, Memory, Message, Person, Principal, Relationship, WendyEvent } from '../domain/types.js';
import { hashOf, newId } from '../util/hash.js';
import type {
  CommitmentRepository,
  EntityRepository,
  EventRepository,
  MeetingRepository,
  MemoryRepository,
  MessageRepository,
  NewEvent,
  RelationshipRepository,
} from './interfaces.js';

export const normalizeAddress = (a: string): string => a.trim().toLowerCase();

/**
 * One term as a query in the four indexed configurations (Portuguese stems with and without
 * accents, English stems, accent-free literal), so "propostas" finds "proposta" and "preco" finds "preço" (migration 004).
 */
const TERM_QUERY = (t: string) => `(websearch_to_tsquery('wendy_pt_stem', ${t}) || websearch_to_tsquery('wendy_pt', ${t}) || websearch_to_tsquery('wendy_en', ${t}) || websearch_to_tsquery('wendy_simple', ${t}))`;
/** Matches rows whose tsvector matches ANY of the terms (each term is a websearch query). */
const ANY_TERM = (col: string, param: string) => `EXISTS (SELECT 1 FROM unnest(${param}::text[]) t WHERE ${col} @@ ${TERM_QUERY('t')})`;
const RANK = (col: string, param: string) => `(SELECT coalesce(max(ts_rank(${col}, ${TERM_QUERY('t')})), 0) FROM unnest(${param}::text[]) t)`;

function cleanTerms(terms: string[]): string[] {
  return [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2))].slice(0, 20);
}

export class PgEntityRepository implements EntityRepository {
  async getPrincipal(q: Queryable, id: string) {
    return (await q.query<Principal>('SELECT * FROM principals WHERE id = $1', [id])).rows[0] ?? null;
  }
  async listPrincipals(q: Queryable) {
    return (await q.query<Principal>('SELECT * FROM principals ORDER BY created_at')).rows;
  }
  async getPerson(q: Queryable, principalId: string, id: string) {
    return (await q.query<Person>('SELECT * FROM people WHERE principal_id = $1 AND id = $2', [principalId, id])).rows[0] ?? null;
  }
  async getPeople(q: Queryable, principalId: string, ids: string[]) {
    if (ids.length === 0) return [];
    return (await q.query<Person>('SELECT * FROM people WHERE principal_id = $1 AND id = ANY($2::uuid[])', [principalId, ids])).rows;
  }
  async findPersonByIdentifier(q: Queryable, principalId: string, kind: string, value: string) {
    return (
      await q.query<Person>(
        `SELECT p.* FROM person_identifiers i JOIN people p ON p.id = i.person_id
         WHERE i.principal_id = $1 AND i.kind = $2 AND i.value = $3`,
        [principalId, kind, normalizeAddress(value)],
      )
    ).rows[0] ?? null;
  }
  async findPeopleByExactName(q: Queryable, principalId: string, name: string) {
    return (await q.query<Person>('SELECT * FROM people WHERE principal_id = $1 AND lower(full_name) = lower($2)', [principalId, name.trim()])).rows;
  }
  async listPeopleWithBirthdates(q: Queryable, principalId: string) {
    return (await q.query<Person>('SELECT * FROM people WHERE principal_id = $1 AND birthdate IS NOT NULL', [principalId])).rows;
  }
}

export class PgRelationshipRepository implements RelationshipRepository {
  async getRelationship(q: Queryable, principalId: string, personId: string) {
    return (await q.query<Relationship>('SELECT * FROM relationships WHERE principal_id = $1 AND person_id = $2', [principalId, personId])).rows[0] ?? null;
  }

}

export class PgEventRepository implements EventRepository {
  async insert(q: Queryable, e: NewEvent) {
    const id = newId();
    const inserted = await q.query<WendyEvent>(
      `INSERT INTO events(id, principal_id, event_type, source, source_event_key, occurred_at, received_at, actor, entity_refs,
                          payload, payload_hash, confidence, provenance, correlation_id, permissions, processing_status, processed_at)
       VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8,$9,$10,$11,$12,$13,$14,$15, CASE WHEN $15 = 'PROCESSED' THEN now() END)
       ON CONFLICT (principal_id, source, source_event_key) DO NOTHING
       RETURNING *`,
      [
        id,
        e.principalId,
        e.eventType,
        e.source,
        e.sourceEventKey,
        e.occurredAt,
        JSON.stringify(e.actor),
        JSON.stringify(e.entityRefs),
        JSON.stringify(e.payload),
        hashOf(e.payload),
        e.confidence,
        JSON.stringify(e.provenance),
        e.correlationId ?? newId(),
        JSON.stringify(e.permissions ?? { scope: 'PRINCIPAL_PRIVATE' }),
        e.initialStatus ?? 'PENDING',
      ],
    );
    if (inserted.rows[0]) return { event: inserted.rows[0], inserted: true };
    const existing = await q.query<WendyEvent>(
      'SELECT * FROM events WHERE principal_id = $1 AND source = $2 AND source_event_key = $3',
      [e.principalId, e.source, e.sourceEventKey],
    );
    return { event: existing.rows[0]!, inserted: false };
  }

  async get(q: Queryable, id: string) {
    return (await q.query<WendyEvent>('SELECT * FROM events WHERE id = $1', [id])).rows[0] ?? null;
  }

  /** Claims work with SKIP LOCKED so concurrent workers never process the same event; stale leases are reclaimable. */
  async claimPending(q: Queryable, now: Date, leaseMs: number, limit: number) {
    return (
      await q.query<WendyEvent>(
        `UPDATE events SET processing_status = 'PROCESSING', processing_attempts = processing_attempts + 1,
                locked_until = $1::timestamptz + ($2 || ' milliseconds')::interval
         WHERE id IN (
           SELECT id FROM events
           WHERE ((processing_status = 'PENDING' AND (locked_until IS NULL OR locked_until <= $1))
                  OR (processing_status = 'PROCESSING' AND locked_until < $1))
             AND processing_attempts < 5
           ORDER BY received_at
           FOR UPDATE SKIP LOCKED
           LIMIT $3)
         RETURNING *`,
        [now, String(leaseMs), limit],
      )
    ).rows;
  }

  async markDone(q: Queryable, id: string, status: 'PROCESSED' | 'SKIPPED', note?: string) {
    await q.query(`UPDATE events SET processing_status = $2, processed_at = now(), locked_until = NULL, last_error = $3 WHERE id = $1`, [id, status, note ?? null]);
  }

  /** Retries with linear backoff (attempts × 1 min from `now`); FAILED after 5 attempts. */
  async markFailed(q: Queryable, id: string, error: string, now: Date) {
    await q.query(
      `UPDATE events SET processing_status = CASE WHEN processing_attempts >= 5 THEN 'FAILED' ELSE 'PENDING' END,
              locked_until = CASE WHEN processing_attempts >= 5 THEN NULL ELSE $3::timestamptz + processing_attempts * interval '1 minute' END,
              last_error = $2 WHERE id = $1`,
      [id, error.slice(0, 2000), now],
    );
  }
}

export class PgMessageRepository implements MessageRepository {
  async get(q: Queryable, principalId: string, id: string) {
    return (await q.query<Message>('SELECT * FROM messages WHERE principal_id = $1 AND id = $2', [principalId, id])).rows[0] ?? null;
  }
  async recentWithPerson(q: Queryable, principalId: string, personId: string, before: Date, limit: number) {
    return (
      await q.query<Message>(
        `SELECT DISTINCT m.* FROM messages m JOIN message_participants mp ON mp.message_id = m.id
         WHERE m.principal_id = $1 AND mp.person_id = $2 AND m.sent_at <= $3
         ORDER BY m.sent_at DESC LIMIT $4`,
        [principalId, personId, before, limit],
      )
    ).rows;
  }
  async search(q: Queryable, principalId: string, terms: string[], since: Date, before: Date, limit: number) {
    const t = cleanTerms(terms);
    if (t.length === 0) return [];
    return (
      await q.query<Message>(
        `SELECT m.* FROM messages m
         WHERE m.principal_id = $1 AND m.sent_at BETWEEN $3 AND $4 AND ${ANY_TERM('m.search', '$2')}
         ORDER BY ${RANK('m.search', '$2')} DESC, m.sent_at DESC LIMIT $5`,
        [principalId, t, since, before, limit],
      )
    ).rows;
  }
  async outboundToPersonSince(q: Queryable, principalId: string, personId: string, since: Date) {
    return (
      await q.query<Message>(
        `SELECT DISTINCT m.* FROM messages m JOIN message_participants mp ON mp.message_id = m.id
         WHERE m.principal_id = $1 AND m.direction = 'OUTBOUND' AND mp.person_id = $2 AND mp.role = 'TO' AND m.sent_at >= $3
         ORDER BY m.sent_at`,
        [principalId, personId, since],
      )
    ).rows;
  }
}

async function attachAttendees(q: Queryable, meetings: Meeting[]): Promise<Meeting[]> {
  if (meetings.length === 0) return meetings;
  const rows = (
    await q.query<{ meeting_id: string; address: string; person_id: string | null }>(
      'SELECT meeting_id, address, person_id FROM meeting_attendees WHERE meeting_id = ANY($1::uuid[])',
      [meetings.map((m) => m.id)],
    )
  ).rows;
  return meetings.map((m) => ({ ...m, attendees: rows.filter((r) => r.meeting_id === m.id).map(({ address, person_id }) => ({ address, person_id })) }));
}

export class PgMeetingRepository implements MeetingRepository {
  async get(q: Queryable, principalId: string, id: string) {
    const m = (await q.query<Meeting>('SELECT * FROM meetings WHERE principal_id = $1 AND id = $2', [principalId, id])).rows;
    return (await attachAttendees(q, m))[0] ?? null;
  }
  async withPersonBetween(q: Queryable, principalId: string, personId: string, from: Date, to: Date) {
    const m = (
      await q.query<Meeting>(
        `SELECT DISTINCT mt.* FROM meetings mt JOIN meeting_attendees a ON a.meeting_id = mt.id
         WHERE mt.principal_id = $1 AND a.person_id = $2 AND mt.starts_at BETWEEN $3 AND $4 ORDER BY mt.starts_at`,
        [principalId, personId, from, to],
      )
    ).rows;
    return attachAttendees(q, m);
  }
  async searchBetween(q: Queryable, principalId: string, terms: string[], from: Date, to: Date, limit: number) {
    const t = cleanTerms(terms);
    if (t.length === 0) return [];
    const m = (
      await q.query<Meeting>(
        `SELECT mt.* FROM meetings mt WHERE mt.principal_id = $1 AND mt.starts_at BETWEEN $3 AND $4 AND ${ANY_TERM('mt.search', '$2')}
         ORDER BY mt.starts_at LIMIT $5`,
        [principalId, t, from, to, limit],
      )
    ).rows;
    return attachAttendees(q, m);
  }
}

export class PgCommitmentRepository implements CommitmentRepository {
  async get(q: Queryable, principalId: string, id: string) {
    return (await q.query<Commitment>('SELECT * FROM commitments WHERE principal_id = $1 AND id = $2', [principalId, id])).rows[0] ?? null;
  }
  async openForPerson(q: Queryable, principalId: string, personId: string) {
    return (
      await q.query<Commitment>(
        `SELECT * FROM commitments WHERE principal_id = $1 AND counterparty_person_id = $2 AND status = 'OPEN' ORDER BY due_at`,
        [principalId, personId],
      )
    ).rows;
  }
  async search(q: Queryable, principalId: string, terms: string[], limit: number) {
    const t = cleanTerms(terms);
    if (t.length === 0) return [];
    return (
      await q.query<Commitment>(
        `SELECT * FROM commitments c WHERE c.principal_id = $1 AND c.status <> 'PROPOSED' AND ${ANY_TERM('c.search', '$2')} ORDER BY c.due_at LIMIT $3`,
        [principalId, t, limit],
      )
    ).rows;
  }
  async openDueBefore(q: Queryable, principalId: string, before: Date) {
    return (
      await q.query<Commitment>(`SELECT * FROM commitments WHERE principal_id = $1 AND status = 'OPEN' AND due_at <= $2 ORDER BY due_at`, [principalId, before])
    ).rows;
  }
}

export class PgMemoryRepository implements MemoryRepository {
  async write(
    q: Queryable,
    m: { principalId: string; kind: Memory['kind']; subjectPersonId: string | null; content: string; confidence: number; evidence: Memory['evidence']; writtenBy: Memory['written_by']; createdAt: Date; status?: 'PROPOSED' | 'ACTIVE' },
  ) {
    return (
      await q.query<Memory>(
        `INSERT INTO memories(id, principal_id, kind, subject_person_id, content, confidence, status, evidence, written_by, created_at, last_confirmed_at, status_changed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $7 = 'ACTIVE' THEN $10::timestamptz END, $10)
         RETURNING *`,
        [newId(), m.principalId, m.kind, m.subjectPersonId, m.content, m.confidence, m.status ?? 'ACTIVE', JSON.stringify(m.evidence), m.writtenBy, m.createdAt],
      )
    ).rows[0]!;
  }
  async get(q: Queryable, principalId: string, id: string) {
    return (await q.query<Memory>('SELECT * FROM memories WHERE principal_id = $1 AND id = $2', [principalId, id])).rows[0] ?? null;
  }
  async activeForPerson(q: Queryable, principalId: string, personId: string, limit: number) {
    return (
      await q.query<Memory>(
        `SELECT * FROM memories WHERE principal_id = $1 AND subject_person_id = $2 AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT $3`,
        [principalId, personId, limit],
      )
    ).rows;
  }
  async activePrincipalLevel(q: Queryable, principalId: string, limit: number) {
    return (
      await q.query<Memory>(
        `SELECT * FROM memories WHERE principal_id = $1 AND subject_person_id IS NULL AND kind = 'PREFERENCE' AND status = 'ACTIVE'
         ORDER BY created_at DESC LIMIT $2`,
        [principalId, limit],
      )
    ).rows;
  }
  async search(q: Queryable, principalId: string, terms: string[], limit: number) {
    const t = cleanTerms(terms);
    if (t.length === 0) return [];
    return (
      await q.query<Memory>(
        `SELECT * FROM memories m WHERE m.principal_id = $1 AND m.status = 'ACTIVE' AND ${ANY_TERM('m.search', '$2')}
         ORDER BY ${RANK('m.search', '$2')} DESC LIMIT $3`,
        [principalId, t, limit],
      )
    ).rows;
  }
}

export interface Repositories {
  entities: PgEntityRepository;
  relationships: PgRelationshipRepository;
  events: PgEventRepository;
  messages: PgMessageRepository;
  meetings: PgMeetingRepository;
  commitments: PgCommitmentRepository;
  memories: PgMemoryRepository;
}

export function pgRepositories(): Repositories {
  return {
    entities: new PgEntityRepository(),
    relationships: new PgRelationshipRepository(),
    events: new PgEventRepository(),
    messages: new PgMessageRepository(),
    meetings: new PgMeetingRepository(),
    commitments: new PgCommitmentRepository(),
    memories: new PgMemoryRepository(),
  };
}
