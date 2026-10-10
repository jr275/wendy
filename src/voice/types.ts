/**
 * Voice Concierge contract. A call is a tool effect (`voice.call`) authorized as an action; its
 * life is a stream of events stored in the skill run's event log. Three things are kept apart:
 *   - the MANDATE (what the principal authorized: objective, actions, disclosures, limits),
 *   - the CALL TRANSCRIPT (what was said, as provider events),
 *   - the WORKER RESULT (Wendy's post-call classification and extracted facts).
 */

/** Things Wendy may do on a call. Financial, contractual and destructive ones are never pre-authorized. */
export const VOICE_ACTIONS = ['ask', 'inform', 'request_booking', 'accept_alternative', 'join_waitlist', 'negotiate', 'cancel', 'pay', 'purchase', 'accept_charge', 'sign_contract', 'change_account'] as const;
export type VoiceAction = (typeof VOICE_ACTIONS)[number];

/** A piece of information Wendy may be asked for. The registry (policy.ts) says how sensitive each is. */
export type DisclosureCategory = string;

export interface VoiceLimits {
  maxCallDurationSeconds: number;
  maxCallsPerTask: number;
  maxCallsPerUserPerDay: number;
}

/** Where the number came from (phone evidence). */
export interface PhoneSource {
  kind: 'principal' | 'web_page';
  /** The page the number was read from (required for web_page). */
  ref?: string;
  title?: string;
  sourceType?: 'official_site' | 'business_listing' | 'other';
  confidence?: 'high' | 'medium' | 'low';
  verifiedAt?: string;
}

/** Situations where Wendy must come back to the principal instead of deciding on the call. */
export const CONFIRMATION_TRIGGERS = ['price_change', 'extra_fee', 'different_date', 'different_time', 'payment', 'cancellation'] as const;
export type ConfirmationTrigger = (typeof CONFIRMATION_TRIGGERS)[number];

/** VoiceCallTask: what the principal authorized for ONE call (this is the approved action content). */
export interface VoiceMandate {
  objective: string;
  /** Language Wendy speaks on the call. */
  language: string;
  target: { name: string; phone: string; phoneSource: PhoneSource };
  /** Concrete details of the request (date, time, party size…), as the principal gave them. */
  parameters: Record<string, string | number>;
  authorizedActions: VoiceAction[];
  forbiddenActions: VoiceAction[];
  /** Acceptable alternatives Wendy may accept on her own (only with accept_alternative). */
  acceptable?: { time?: { from: string; to: string } };
  /** Exactly what Wendy may say about the principal, with the value. Nothing else is disclosed. */
  disclosures: { category: DisclosureCategory; value: string }[];
  limits: VoiceLimits;
  /** Stated by the principal but NOT authorizing anything: e.g. "up to R$ 500 extra" still needs confirmation. */
  constraints?: { maxExtraCost?: { amount: number; currency: string } };
  /** When Wendy must come back instead of deciding (defaults: all triggers). */
  confirmationRequired?: ConfirmationTrigger[];
  /** The principal's own words this mandate was built from. */
  userContext?: { request: string; messageId?: string };
  /** Stable key: the same mandate never places two calls (provider idempotency). */
  idempotencyKey?: string;
}

/**
 * What the other party's turn means for the task. A real provider derives these from speech
 * (model classification validated against the transcript); the mock states them directly.
 */
export type CounterpartySignal =
  | { kind: 'available' }
  | { kind: 'confirmed'; facts: Record<string, string | number> }
  | { kind: 'alternative'; offer: Record<string, string | number> }
  | { kind: 'charge'; amount: number; currency: string }
  | { kind: 'requests_info'; category: DisclosureCategory }
  | { kind: 'unavailable' }
  | { kind: 'unclear' };

export type Speaker = 'agent' | 'counterparty';

/**
 * Provider event contract (what a real telephony integration must produce). `seq` is the provider's
 * order; `at` its timestamp.
 */
export type VoiceEvent =
  | { seq: number; at: string; type: 'call.created' }
  | { seq: number; at: string; type: 'call.dialing' }
  | { seq: number; at: string; type: 'call.connected' }
  | { seq: number; at: string; type: 'call.transcript'; speaker: Speaker; text: string; signals?: CounterpartySignal[] }
  | { seq: number; at: string; type: 'call.action_required'; action: VoiceAction | 'disclose'; detail: string; decision: 'requires_confirmation' | 'forbidden' }
  | { seq: number; at: string; type: 'call.ended'; by: 'agent' | 'counterparty' | 'system'; reason: 'done' | 'cancelled' | 'duration_limit' | 'policy' }
  | { seq: number; at: string; type: 'call.failed'; reason: 'no_answer' | 'busy' | 'voicemail' | 'invalid_number' | 'provider_error' };

export interface TranscriptTurn {
  speaker: Speaker;
  text: string;
  at: string;
}

/** VoiceTaskResult: the worker's structured outcome, built after the call from transcript + signals. */
export interface VoiceTaskResult {
  success: boolean;
  outcome: 'COMPLETED' | 'PARTIAL_SUCCESS' | 'REQUIRES_CONFIRMATION' | 'POLICY_VIOLATION' | 'FAILED' | 'NO_ANSWER' | 'BUSY' | 'VOICEMAIL' | 'CANCELLED';
  summary: string;
  extractedFacts: { key: string; value: string }[];
  actionsTaken: string[];
  nextActions: string[];
  requiresUserAction: boolean;
  simulated: boolean;
}
