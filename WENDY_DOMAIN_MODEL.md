# WENDY — DOMAIN ONTOLOGY & DATA MODEL SPECIFICATION
**Version:** 1.0.0  
**Schema Standard:** Strict TypeScript Definitions & Relational Entity Model  

---

## 1. Domain Modeling Philosophy

Every entity in Wendy’s universe adheres to a **Common Base Entity Contract**. No entity enters the system without a verifiable timestamp, a known provenance source, a confidence metric, and strict security/permission attributes.

```typescript
/** Common metadata contract enforced on all core entities */
export interface BaseEntity {
  id: string; // UUID v4 or URN (e.g., "urn:wendy:person:123")
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
  source: EntitySource; // Origin system (GMAIL, GCAL, USER_DIRECT, INFERENCE, etc.)
  provenance: ProvenanceRecord; // Traceability chain to source data
  confidence: number; // Float [0.0 - 1.0] (1.0 for hard facts, <1.0 for inferences)
  epistemicState: 'FACT' | 'INFERENCE' | 'HYPOTHESIS' | 'RECOMMENDATION';
  lifecycleState: LifecycleState; // DRAFT | ACTIVE | RESOLVED | ARCHIVED | DISMISSED
  tags: string[];
}

export interface ProvenanceRecord {
  sourceType: 'API_READ' | 'USER_PROMPT' | 'MODEL_INFERENCE' | 'BACKGROUND_CRON';
  sourceId?: string; // e.g., Gmail Message ID, Calendar Event ID
  sourceHash?: string; // SHA-256 hash of payload
  derivedBy?: string; // Model or Rule ID that created this entry
  derivationTimestamp: string;
  evidenceSnippets?: string[]; // Literal excerpt justifying the entity
}
```

---

## 2. Core Entities

### 2.1 Identity, People & Organizations
```typescript
export interface Person extends BaseEntity {
  fullName: string;
  preferredName?: string;
  emailAddresses: string[];
  phoneNumbers?: string[];
  organizationId?: string;
  title?: string;
  tier: 1 | 2 | 3 | 4; // Tier 1 = Inner Circle / Strategic; Tier 4 = Low Familiarity
  birthday?: string; // YYYY-MM-DD or MM-DD
  anniversary?: string;
  timeZone?: string;
  socialProfiles?: Record<string, string>;
  notesSummary?: string;
}

export interface Organization extends BaseEntity {
  name: string;
  domain?: string;
  industry?: string;
  strategicImportance: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  notes?: string;
}

export interface Relationship extends BaseEntity {
  personAId: string; // Always executive or subject
  personBId: string; // The counterpart
  relationshipType: 'INVESTOR' | 'BOARD_MEMBER' | 'KEY_CLIENT' | 'TEAM_MEMBER' | 'ADVISOR' | 'PEER' | 'VENDOR';
  closenessScore: number; // 0.0 to 1.0
  velocity: 'ACCELERATING' | 'STABLE' | 'DECAYING' | 'DORMANT';
  lastInteractionAt?: string;
  interactionCadenceDays?: number; // Target days between contacts
  reciprocityBalance: number; // Positive = they owe us; Negative = we owe them
  historicalNotes: string[];
}
```

### 2.2 Time, Calendar & Meetings
```typescript
export interface CalendarEvent extends BaseEntity {
  externalEventId: string; // Google Calendar UID
  title: string;
  description?: string;
  location?: string;
  startTime: string; // ISO 8601
  endTime: string;
  isAllDay: boolean;
  organizerEmail: string;
  attendees: Array<{
    email: string;
    displayName?: string;
    responseStatus: 'needsAction' | 'declined' | 'tentative' | 'accepted';
    isExecutive: boolean;
  }>;
  isStrategic: boolean;
  meetingUrl?: string;
}

export interface Meeting extends BaseEntity {
  calendarEventId: string;
  attendeePersonIds: string[];
  preparationStatus: 'PENDING' | 'BRIEFING_READY' | 'COMPLETED' | 'CANCELLED';
  briefingDossierId?: string;
  agendaItems?: string[];
  strategicObjectives?: string[];
  recordedOutcome?: string;
  extractedCommitmentIds?: string[];
}
```

### 2.3 Communications & Interactions
```typescript
export interface Email extends BaseEntity {
  externalMessageId: string;
  threadId: string;
  from: { email: string; name?: string };
  to: Array<{ email: string; name?: string }>;
  cc?: Array<{ email: string; name?: string }>;
  bcc?: Array<{ email: string; name?: string }>;
  subject: string;
  bodySnippet: string;
  fullBodyText?: string;
  sentAt: string;
  receivedAt: string;
  urgencyScore: number; // 0.0 to 1.0
  intent: 'INFORMATION' | 'REQUEST_FOR_MEETING' | 'APPROVAL_NEEDED' | 'DISPUTE' | 'COMMITMENT_OFFER';
  hasAttachment: boolean;
  processedForCommitments: boolean;
}

export interface Conversation extends BaseEntity {
  channel: 'EMAIL' | 'SLACK' | 'SMS' | 'WHATSAPP' | 'IN_PERSON' | 'WENDY_CHAT';
  participantIds: string[];
  summary: string;
  keyTakeaways: string[];
  sentiment: 'POSITIVE' | 'NEUTRAL' | 'CONCERNED' | 'TENSE';
}

export interface Interaction extends BaseEntity {
  type: 'MEETING' | 'EMAIL_SENT' | 'EMAIL_RECEIVED' | 'CALL' | 'NOTE';
  entityId: string; // PersonId or OrganizationId
  timestamp: string;
  summary: string;
  significance: 'LOW' | 'MEDIUM' | 'HIGH' | 'PIVOTAL';
}
```

### 2.4 Commitments, Decisions & Strategic Tracking
```typescript
export interface Commitment extends BaseEntity {
  title: string;
  description: string;
  promisorId: string; // Person who made the promise (can be Executive)
  promiseeId: string; // Person to whom the promise was made
  dueDate?: string; // ISO 8601
  isExecutivePromise: boolean; // True if João promised Mariana
  status: 'PENDING' | 'IN_PROGRESS' | 'FULFILLED' | 'BROKEN' | 'SUPERSEDED';
  sourceInteractionId: string; // Pointer to meeting note, email, etc.
  urgencyLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface Decision extends BaseEntity {
  title: string;
  context: string;
  decisionTaken: string;
  decisionMakerId: string;
  stakeholdersAffected: string[];
  rationale: string;
  effectiveDate: string;
  reviewDate?: string;
  status: 'PROPOSED' | 'FINAL' | 'REVERSED';
}

export interface Goal extends BaseEntity {
  title: string;
  category: 'STRATEGIC' | 'FINANCIAL' | 'PRODUCT' | 'RELATIONSHIP' | 'PERSONAL';
  targetDate: string;
  metrics?: Record<string, any>;
  status: 'ON_TRACK' | 'AT_RISK' | 'BEHIND' | 'ACCOMPLISHED';
}

export interface Project extends BaseEntity {
  name: string;
  description: string;
  ownerPersonId: string;
  keyStakeholders: string[];
  associatedGoalIds: string[];
  status: 'PLANNING' | 'ACTIVE' | 'BLOCKED' | 'COMPLETED';
}

export interface Task extends BaseEntity {
  title: string;
  assigneeId?: string;
  dueDate?: string;
  completedAt?: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  status: 'TODO' | 'DOING' | 'DONE';
}
```

### 2.5 Cognitive Artifacts: Observations, Memories & Preferences
```typescript
export interface Observation extends BaseEntity {
  category: 'SCHEDULE_ANOMALY' | 'RELATIONSHIP_DRIFT' | 'COMMITMENT_RISK' | 'SENTIMENT_ALERT' | 'OPPORTUNITY';
  title: string;
  narrative: string;
  salienceScore: number; // 0.0 - 1.0 (Attention threshold)
  relatedEntityIds: string[];
  recommendedActionId?: string;
  suppressedUntil?: string; // If "This can wait", snoozed until timestamp
}

export interface Memory extends BaseEntity {
  memoryType: 'EPISODIC' | 'SEMANTIC' | 'PROCEDURAL' | 'PREFERENCE';
  key: string;
  content: string;
  embeddingVector?: number[]; // For semantic retrieval
  associatedEntityIds: string[];
  accessCount: number;
  lastRecalledAt: string;
  decayHalfLifeDays: number; // Memory retention weight over time
}

export interface Preference extends BaseEntity {
  domain: 'CALENDAR' | 'COMMUNICATION' | 'DRAFTING_STYLE' | 'TRAVEL' | 'DECISION_MAKING';
  rule: string;
  exemplars?: string[];
  strength: 'STRICT_CONSTRAINT' | 'STRONG_PREFERENCE' | 'DEFAULT_BEHAVIOR';
}

export interface Risk extends BaseEntity {
  title: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  likelihood: 'UNLIKELY' | 'POSSIBLE' | 'PROBABLE' | 'CERTAIN';
  mitigationSuggestion?: string;
  relatedEntityIds: string[];
}

export interface Opportunity extends BaseEntity {
  title: string;
  upsideDescription: string;
  recommendedNextStep: string;
  expirationDate?: string;
  relatedEntityIds: string[];
}

export interface Signal extends BaseEntity {
  channel: 'TWITTER' | 'LINKEDIN' | 'NEWS' | 'SEC_FILING' | 'INTERNAL_AUDIT';
  rawPayload: Record<string, any>;
  extractedEntityIds: string[];
  implicationSummary: string;
}
```

### 2.6 Action, Authorization & Verification
```typescript
export interface Action extends BaseEntity {
  actionType: 'SEND_EMAIL' | 'UPDATE_CALENDAR' | 'DISPATCH_MESSAGE' | 'CREATE_TASK' | 'UPDATE_MEMORY';
  authorizationLevel: 0 | 1 | 2 | 3 | 4; // Strictly mapped to Wendy Auth Matrix
  payload: Record<string, any>;
  previewData: {
    headline: string;
    detailsMarkdown: string;
    consequencesSummary: string;
  };
  state: 'DRAFTED' | 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXECUTING' | 'EXECUTED' | 'FAILED';
  approvalId?: string;
}

export interface Approval extends BaseEntity {
  actionId: string;
  requestedAt: string;
  decidedAt?: string;
  decision: 'GRANTED' | 'DENIED' | 'MODIFIED';
  approverId: string; // Executive
  modificationsMade?: Record<string, any>;
  rejectionReason?: string;
}

export interface Outcome extends BaseEntity {
  actionId: string;
  wasSuccessful: boolean;
  telemetryEvidence: Record<string, any>;
  unexpectedSideEffects?: string[];
  recordedLessonsLearned?: string;
}
```
