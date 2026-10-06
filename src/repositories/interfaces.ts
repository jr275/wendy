/**
 * Repository boundaries. The Cognitive Core depends only on these interfaces; the PostgreSQL
 * implementations live in ./pg*.ts. Methods taking a `q` accept either the pool or a
 * transaction client so callers control atomicity.
 */
import type { Queryable } from '../db/db.js';
import type {
  Commitment,
  EvidenceRef,
  Meeting,
  Memory,
  MemoryKind,
  Message,
  Person,
  Principal,
  Relationship,
  WendyEvent,
} from '../domain/types.js';

export interface NewEvent {
  principalId: string;
  eventType: WendyEvent['event_type'];
  source: string;
  sourceEventKey: string;
  occurredAt: Date;
  actor: WendyEvent['actor'];
  entityRefs: EvidenceRef[];
  payload: Record<string, unknown>;
  confidence: number;
  provenance: WendyEvent['provenance'];
  correlationId?: string;
  permissions?: WendyEvent['permissions'];
  /** Events handled synchronously (e.g. questions) are stored already PROCESSED. */
  initialStatus?: 'PENDING' | 'PROCESSED';
}

export interface EntityRepository {
  getPrincipal(q: Queryable, id: string): Promise<Principal | null>;
  getPerson(q: Queryable, principalId: string, id: string): Promise<Person | null>;
  getPeople(q: Queryable, principalId: string, ids: string[]): Promise<Person[]>;
  findPersonByIdentifier(q: Queryable, principalId: string, kind: string, value: string): Promise<Person | null>;
  findPeopleByExactName(q: Queryable, principalId: string, name: string): Promise<Person[]>;
  listPeopleWithBirthdates(q: Queryable, principalId: string): Promise<Person[]>;
  listPrincipals(q: Queryable): Promise<Principal[]>;
}

export interface RelationshipRepository {
  getRelationship(q: Queryable, principalId: string, personId: string): Promise<Relationship | null>;
  interactionStats(q: Queryable, principalId: string, personId: string, since: Date): Promise<{ count: number; lastAt: Date | null }>;
}

export interface EventRepository {
  /** Idempotent: a second insert with the same (principal, source, source_event_key) returns the original. */
  insert(q: Queryable, e: NewEvent): Promise<{ event: WendyEvent; inserted: boolean }>;
  get(q: Queryable, id: string): Promise<WendyEvent | null>;
  claimPending(q: Queryable, now: Date, leaseMs: number, limit: number): Promise<WendyEvent[]>;
  markDone(q: Queryable, id: string, status: 'PROCESSED' | 'SKIPPED', note?: string): Promise<void>;
  markFailed(q: Queryable, id: string, error: string, now: Date): Promise<void>;
}

export interface MessageRepository {
  get(q: Queryable, principalId: string, id: string): Promise<Message | null>;
  recentWithPerson(q: Queryable, principalId: string, personId: string, before: Date, limit: number): Promise<Message[]>;
  search(q: Queryable, principalId: string, terms: string[], since: Date, before: Date, limit: number): Promise<Message[]>;
  outboundToPersonSince(q: Queryable, principalId: string, personId: string, since: Date): Promise<Message[]>;
}

export interface MeetingRepository {
  get(q: Queryable, principalId: string, id: string): Promise<Meeting | null>;
  withPersonBetween(q: Queryable, principalId: string, personId: string, from: Date, to: Date): Promise<Meeting[]>;
  searchBetween(q: Queryable, principalId: string, terms: string[], from: Date, to: Date, limit: number): Promise<Meeting[]>;
}

export interface CommitmentRepository {
  get(q: Queryable, principalId: string, id: string): Promise<Commitment | null>;
  openForPerson(q: Queryable, principalId: string, personId: string): Promise<Commitment[]>;
  search(q: Queryable, principalId: string, terms: string[], limit: number): Promise<Commitment[]>;
  openDueBefore(q: Queryable, principalId: string, before: Date): Promise<Commitment[]>;
}

export interface MemoryRepository {
  write(
    q: Queryable,
    m: { principalId: string; kind: MemoryKind; subjectPersonId: string | null; content: string; confidence: number; evidence: EvidenceRef[]; writtenBy: Memory['written_by']; createdAt: Date; status?: 'PROPOSED' | 'ACTIVE' },
  ): Promise<Memory>;
  get(q: Queryable, principalId: string, id: string): Promise<Memory | null>;
  activeForPerson(q: Queryable, principalId: string, personId: string, limit: number): Promise<Memory[]>;
  activePrincipalLevel(q: Queryable, principalId: string, limit: number): Promise<Memory[]>;
  search(q: Queryable, principalId: string, terms: string[], limit: number): Promise<Memory[]>;
}
