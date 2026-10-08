export const ActionState = {
  PROPOSED: 'PROPOSED',
  STAGED: 'STAGED',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  APPROVED: 'APPROVED',
  EXECUTING: 'EXECUTING',
  EXECUTED: 'EXECUTED',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
} as const;
export type ActionState = (typeof ActionState)[keyof typeof ActionState];

export const TERMINAL_ACTION_STATES: readonly ActionState[] = ['VERIFIED', 'REJECTED', 'FAILED', 'CANCELLED', 'EXPIRED'];

export type ClaimKind = 'FACT' | 'INFERENCE' | 'HYPOTHESIS' | 'ANTICIPATION' | 'RECOMMENDATION';

export type EvidenceKind = 'event' | 'message' | 'meeting' | 'commitment' | 'memory' | 'person' | 'relationship' | 'insight' | 'action' | 'search_metric' | 'web_page' | 'document' | 'task';

export interface EvidenceRef {
  kind: EvidenceKind;
  id: string;
}

export interface Principal {
  id: string;
  display_name: string;
  primary_email: string;
  timezone: string;
  locale: string;
}

export interface Person {
  id: string;
  principal_id: string;
  full_name: string;
  title: string | null;
  organization_id: string | null;
  birthdate: string | null;
  source: string;
}

export interface Relationship {
  id: string;
  principal_id: string;
  person_id: string;
  kind: string;
  explicit_importance: number | null;
  notes: string | null;
  source: string;
}

export interface Message {
  id: string;
  principal_id: string;
  provider: string;
  external_id: string;
  thread_external_id: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
  from_address: string;
  to_addresses: string[];
  subject: string;
  body: string;
  sent_at: Date;
}

export interface Meeting {
  id: string;
  principal_id: string;
  provider: string;
  external_id: string;
  title: string;
  description: string;
  starts_at: Date;
  ends_at: Date;
  status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  attendees?: { address: string; person_id: string | null }[];
}

export interface Commitment {
  id: string;
  principal_id: string;
  owner: 'PRINCIPAL' | 'COUNTERPARTY';
  counterparty_person_id: string;
  description: string;
  due_at: Date;
  status: 'PROPOSED' | 'OPEN' | 'DONE' | 'CANCELLED';
  source_message_id: string | null;
  source_quote?: string | null;
  source: string;
  created_at: Date;
  completed_at: Date | null;
}

export type MemoryKind = 'PREFERENCE' | 'FACT' | 'EPISODE' | 'OUTCOME';

export interface Memory {
  id: string;
  principal_id: string;
  kind: MemoryKind;
  subject_person_id: string | null;
  content: string;
  confidence: number;
  status: 'PROPOSED' | 'ACTIVE' | 'SUPERSEDED' | 'RETRACTED';
  last_confirmed_at?: Date | null;
  evidence: EvidenceRef[];
  written_by: 'PRINCIPAL' | 'WENDY' | 'SYSTEM';
  created_at: Date;
}

export type EventType = 'EMAIL_RECEIVED' | 'COMMITMENT_DUE' | 'PERSON_DATE_APPROACHING' | 'PRINCIPAL_NOTE' | 'PRINCIPAL_QUESTION' | 'SEARCH_PERFORMANCE_CHANGE';

export interface WendyEvent {
  id: string;
  principal_id: string;
  event_type: EventType;
  source: string;
  source_event_key: string;
  occurred_at: Date;
  received_at: Date;
  actor: { kind: string; address?: string; person_id?: string | null };
  entity_refs: EvidenceRef[];
  payload: Record<string, unknown>;
  payload_hash: string;
  confidence: number;
  provenance: { origin: 'DEV_FIXTURE' | 'DETECTOR' | 'PROVIDER' | 'PRINCIPAL'; provider?: string; detector?: string };
  correlation_id: string;
  permissions: { scope: string };
  processing_status: 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'SKIPPED' | 'FAILED';
  processing_attempts: number;
}
