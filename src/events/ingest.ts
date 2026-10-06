/**
 * Event ingestion. Every signal enters Wendy as a canonical, persisted event. Ingestion is
 * idempotent on (principal, source, source_event_key): replays and duplicates return the original.
 */
import { withTx, type Db, type Queryable } from '../db/db.js';
import type { WendyEvent } from '../domain/types.js';
import type { InboundEmail } from '../providers/interfaces.js';
import type { NewEvent } from '../repositories/interfaces.js';
import { PgEventRepository } from '../repositories/pg.js';
import { storeMessage } from './world.js';

const events = new PgEventRepository();

export interface IngestResult {
  event: WendyEvent;
  duplicate: boolean;
}

export async function ingestEvent(q: Queryable, e: NewEvent): Promise<IngestResult> {
  const { event, inserted } = await events.insert(q, e);
  return { event, duplicate: !inserted };
}

/** An email arriving from a provider: store the message and emit EMAIL_RECEIVED atomically. */
export async function ingestInboundEmail(
  db: Db,
  principalId: string,
  mail: InboundEmail,
  origin: 'PROVIDER' | 'DEV_FIXTURE',
): Promise<IngestResult & { messageId: string }> {
  return withTx(db, async (tx) => {
    const { messageId, senderPersonId } = await storeMessage(tx, principalId, mail);
    const result = await ingestEvent(tx, {
      principalId,
      eventType: 'EMAIL_RECEIVED',
      source: mail.provider,
      sourceEventKey: `message:${mail.externalId}`,
      occurredAt: mail.sentAt,
      actor: { kind: 'EMAIL_SENDER', address: mail.from, person_id: senderPersonId },
      entityRefs: [{ kind: 'message', id: messageId }, ...(senderPersonId ? [{ kind: 'person' as const, id: senderPersonId }] : [])],
      payload: { message_id: messageId },
      confidence: 1,
      provenance: { origin, provider: mail.provider },
    });
    return { ...result, messageId };
  });
}

/** Something the principal tells Wendy directly (e.g. "X prefers short emails"). */
export async function ingestPrincipalNote(db: Db, principalId: string, note: { text: string; externalId: string; at: Date }): Promise<IngestResult> {
  return ingestEvent(db, {
    principalId,
    eventType: 'PRINCIPAL_NOTE',
    source: 'PRINCIPAL',
    sourceEventKey: `note:${note.externalId}`,
    occurredAt: note.at,
    actor: { kind: 'PRINCIPAL' },
    entityRefs: [],
    payload: { text: note.text },
    confidence: 1,
    provenance: { origin: 'PRINCIPAL' },
  });
}
