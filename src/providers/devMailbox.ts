import type { Db } from '../db/db.js';
import { newId } from '../util/hash.js';
import type { EmailProvider, OutboundEmail, SentRecord } from './interfaces.js';

/**
 * DEV ONLY. A local mailbox that accepts outbound email into the dev_outbound_mail table.
 * Nothing is delivered to any recipient: `deliversExternally` is false and every action executed
 * through it is labeled with this provider's name. Idempotent on the key (UNIQUE constraint).
 */
export class DevMailboxProvider implements EmailProvider {
  readonly name = 'DEV_LOCAL_MAILBOX';
  readonly deliversExternally = false;

  constructor(private readonly db: Db) {}

  async send(principalId: string, mail: OutboundEmail): Promise<{ providerRef: string }> {
    await this.db.query(
      `INSERT INTO dev_outbound_mail(id, principal_id, idempotency_key, to_addresses, subject, body, accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,now()) ON CONFLICT (idempotency_key) DO NOTHING`,
      [newId(), principalId, mail.idempotencyKey, mail.to, mail.subject, mail.body],
    );
    const sent = await this.findByIdempotencyKey(principalId, mail.idempotencyKey);
    if (!sent) throw new Error('Dev mailbox did not record the message');
    return { providerRef: sent.providerRef };
  }

  async findByIdempotencyKey(principalId: string, idempotencyKey: string): Promise<SentRecord | null> {
    const row = (
      await this.db.query<{ id: string; to_addresses: string[]; subject: string; body: string; accepted_at: Date }>(
        'SELECT id, to_addresses, subject, body, accepted_at FROM dev_outbound_mail WHERE principal_id = $1 AND idempotency_key = $2',
        [principalId, idempotencyKey],
      )
    ).rows[0];
    return row ? { providerRef: row.id, to: row.to_addresses, subject: row.subject, body: row.body, acceptedAt: row.accepted_at } : null;
  }
}
