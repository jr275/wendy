/**
 * Provider boundaries — the sensors and effectors of Wendy's world. The brain never talks to a
 * vendor API directly. Phase 1 ships only local/dev implementations; Gmail, Google Calendar,
 * Contacts and Drive will implement these same interfaces later.
 */

export interface OutboundEmail {
  idempotencyKey: string;
  to: string[];
  subject: string;
  body: string;
}

export interface SentRecord {
  providerRef: string;
  to: string[];
  subject: string;
  body: string;
  acceptedAt: Date;
}

/** Outbound side of an email provider. `send` MUST be idempotent on idempotencyKey. */
export interface EmailProvider {
  readonly name: string;
  /** True only for providers that deliver to real recipients. */
  readonly deliversExternally: boolean;
  send(principalId: string, mail: OutboundEmail): Promise<{ providerRef: string }>;
  /** Read-back used for verification and crash reconciliation. */
  findByIdempotencyKey(principalId: string, idempotencyKey: string): Promise<SentRecord | null>;
}

/** Inbound message as any email provider must normalize it before ingestion. */
export interface InboundEmail {
  provider: string;
  externalId: string;
  threadExternalId?: string | null;
  from: string;
  to: string[];
  subject: string;
  body: string;
  sentAt: Date;
}

export interface CalendarEventInput {
  provider: string;
  externalId: string;
  title: string;
  description?: string;
  startsAt: Date;
  endsAt: Date;
  status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  attendees: string[];
}

/** Read side contracts for future sensors (NOT IMPLEMENTED against real services in Phase 1). */
export interface CalendarProvider {
  readonly name: string;
  listChangedEvents(principalId: string, since: Date): Promise<CalendarEventInput[]>;
}

export interface ContactsProvider {
  readonly name: string;
  listChangedContacts(principalId: string, since: Date): Promise<{ externalId: string; fullName: string; emails: string[]; birthdate: string | null }[]>;
}

export interface DriveProvider {
  readonly name: string;
  search(principalId: string, query: string): Promise<{ id: string; name: string; modifiedAt: Date }[]>;
}
