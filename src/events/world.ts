/**
 * Writes to Wendy's model of the world (people, relationships, messages, meetings, commitments).
 * Providers and dev fixtures both come through here; `source` labels where each record came from.
 */
import type { Queryable, Tx } from '../db/db.js';
import { normalizeAddress } from '../repositories/pg.js';
import { newId } from '../util/hash.js';
import type { CalendarEventInput, InboundEmail } from '../providers/interfaces.js';

export async function createPrincipal(
  q: Queryable,
  p: { displayName: string; primaryEmail: string; timezone: string; locale: string; id?: string },
): Promise<string> {
  const id = p.id ?? newId();
  await q.query('INSERT INTO principals(id, display_name, primary_email, timezone, locale) VALUES ($1,$2,$3,$4,$5)', [
    id,
    p.displayName,
    normalizeAddress(p.primaryEmail),
    p.timezone,
    p.locale,
  ]);
  return id;
}

export async function createOrganization(q: Queryable, principalId: string, o: { name: string; domain?: string; source: string }): Promise<string> {
  const id = newId();
  await q.query('INSERT INTO organizations(id, principal_id, name, domain, source) VALUES ($1,$2,$3,$4,$5)', [id, principalId, o.name, o.domain ?? null, o.source]);
  return id;
}

export async function createPerson(
  q: Queryable,
  principalId: string,
  p: {
    fullName: string;
    emails: string[];
    title?: string;
    organizationId?: string;
    birthdate?: string | null;
    source: string;
    relationship?: { kind: string; explicitImportance?: number | null; notes?: string };
  },
): Promise<string> {
  const id = newId();
  await q.query(
    'INSERT INTO people(id, principal_id, full_name, title, organization_id, birthdate, source) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, principalId, p.fullName, p.title ?? null, p.organizationId ?? null, p.birthdate ?? null, p.source],
  );
  for (const email of p.emails) {
    await q.query('INSERT INTO person_identifiers(principal_id, kind, value, person_id) VALUES ($1,$2,$3,$4)', [principalId, 'email', normalizeAddress(email), id]);
  }
  if (p.relationship) {
    await q.query(
      'INSERT INTO relationships(id, principal_id, person_id, kind, explicit_importance, notes, source) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [newId(), principalId, id, p.relationship.kind, p.relationship.explicitImportance ?? null, p.relationship.notes ?? null, p.source],
    );
  }
  return id;
}

async function personIdFor(q: Queryable, principalId: string, address: string): Promise<string | null> {
  const r = await q.query<{ person_id: string }>(
    `SELECT person_id FROM person_identifiers WHERE principal_id = $1 AND kind = 'email' AND value = $2`,
    [principalId, normalizeAddress(address)],
  );
  return r.rows[0]?.person_id ?? null;
}

/**
 * Stores a message (idempotent on provider + external id) and links known participants.
 * Direction is derived from whether the principal sent it.
 */
export async function storeMessage(tx: Tx, principalId: string, m: InboundEmail): Promise<{ messageId: string; inserted: boolean; senderPersonId: string | null }> {
  const principal = (await tx.query<{ primary_email: string }>('SELECT primary_email FROM principals WHERE id = $1', [principalId])).rows[0];
  if (!principal) throw new Error(`Unknown principal ${principalId}`);
  const direction = normalizeAddress(m.from) === principal.primary_email ? 'OUTBOUND' : 'INBOUND';

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO messages(id, principal_id, provider, external_id, thread_external_id, direction, from_address, to_addresses, subject, body, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (principal_id, provider, external_id) DO NOTHING RETURNING id`,
    [newId(), principalId, m.provider, m.externalId, m.threadExternalId ?? null, direction, normalizeAddress(m.from), m.to.map(normalizeAddress), m.subject, m.body, m.sentAt],
  );
  const messageId =
    inserted.rows[0]?.id ??
    (await tx.query<{ id: string }>('SELECT id FROM messages WHERE principal_id = $1 AND provider = $2 AND external_id = $3', [principalId, m.provider, m.externalId])).rows[0]!.id;

  const senderPersonId = await personIdFor(tx, principalId, m.from);
  if (inserted.rows[0]) {
    if (senderPersonId) await tx.query(`INSERT INTO message_participants VALUES ($1,$2,'FROM') ON CONFLICT DO NOTHING`, [messageId, senderPersonId]);
    for (const to of m.to) {
      const pid = await personIdFor(tx, principalId, to);
      if (pid) await tx.query(`INSERT INTO message_participants VALUES ($1,$2,'TO') ON CONFLICT DO NOTHING`, [messageId, pid]);
    }
  }
  return { messageId, inserted: !!inserted.rows[0], senderPersonId };
}

export async function upsertMeeting(tx: Tx, principalId: string, e: CalendarEventInput): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO meetings(id, principal_id, provider, external_id, title, description, starts_at, ends_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (principal_id, provider, external_id)
     DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, starts_at = EXCLUDED.starts_at,
                   ends_at = EXCLUDED.ends_at, status = EXCLUDED.status, updated_at = now()
     RETURNING id`,
    [newId(), principalId, e.provider, e.externalId, e.title, e.description ?? '', e.startsAt, e.endsAt, e.status],
  );
  const meetingId = r.rows[0]!.id;
  await tx.query('DELETE FROM meeting_attendees WHERE meeting_id = $1', [meetingId]);
  for (const address of e.attendees) {
    await tx.query('INSERT INTO meeting_attendees(meeting_id, address, person_id) VALUES ($1,$2,$3)', [meetingId, normalizeAddress(address), await personIdFor(tx, principalId, address)]);
  }
  return meetingId;
}

export async function createCommitment(
  q: Queryable,
  principalId: string,
  c: { owner: 'PRINCIPAL' | 'COUNTERPARTY'; counterpartyPersonId: string; description: string; dueAt: Date; createdAt: Date; sourceMessageId?: string; source: string },
): Promise<string> {
  const id = newId();
  await q.query(
    `INSERT INTO commitments(id, principal_id, owner, counterparty_person_id, description, due_at, status, source_message_id, source, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'OPEN',$7,$8,$9)`,
    [id, principalId, c.owner, c.counterpartyPersonId, c.description, c.dueAt, c.sourceMessageId ?? null, c.source, c.createdAt],
  );
  return id;
}

export async function completeCommitment(q: Queryable, principalId: string, id: string, at: Date): Promise<void> {
  await q.query(`UPDATE commitments SET status = 'DONE', completed_at = $3 WHERE principal_id = $1 AND id = $2`, [principalId, id, at]);
}
