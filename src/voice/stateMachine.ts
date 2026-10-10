/**
 * Call state machine. Deterministic: the state is a fold of the stored events (provider events +
 * the worker's outcome), so it can always be rebuilt from persistence and the UI is never the source.
 *
 *   PENDING → VALIDATING → (RESOLVING_PHONE →) DIALING → CONNECTED → ACTIVE ⇄ ACTION_REQUIRED → ENDED
 *   ENDED → COMPLETED | PARTIAL_SUCCESS | REQUIRES_CONFIRMATION | POLICY_VIOLATION | FAILED   (worker outcome)
 *   DIALING → NO_ANSWER | BUSY | VOICEMAIL | FAILED                                           (provider)
 *   any non-terminal → CANCELLED
 */
export const CALL_STATES = [
  'PENDING',
  'VALIDATING',
  'RESOLVING_PHONE',
  'DIALING',
  'CONNECTED',
  'ACTIVE',
  'ACTION_REQUIRED',
  'ENDED',
  'COMPLETED',
  'PARTIAL_SUCCESS',
  'REQUIRES_CONFIRMATION',
  'POLICY_VIOLATION',
  'FAILED',
  'NO_ANSWER',
  'BUSY',
  'VOICEMAIL',
  'CANCELLED',
] as const;
export type CallState = (typeof CALL_STATES)[number];

export const TERMINAL_CALL_STATES: readonly CallState[] = ['COMPLETED', 'PARTIAL_SUCCESS', 'REQUIRES_CONFIRMATION', 'POLICY_VIOLATION', 'FAILED', 'NO_ANSWER', 'BUSY', 'VOICEMAIL', 'CANCELLED'];

const OUTCOMES: CallState[] = ['COMPLETED', 'PARTIAL_SUCCESS', 'REQUIRES_CONFIRMATION', 'POLICY_VIOLATION', 'FAILED'];

export const CALL_TRANSITIONS: Record<CallState, readonly CallState[]> = {
  PENDING: ['VALIDATING', 'CANCELLED'],
  VALIDATING: ['RESOLVING_PHONE', 'DIALING', 'FAILED', 'CANCELLED'],
  RESOLVING_PHONE: ['DIALING', 'FAILED', 'CANCELLED'],
  DIALING: ['CONNECTED', 'NO_ANSWER', 'BUSY', 'VOICEMAIL', 'FAILED', 'CANCELLED'],
  CONNECTED: ['ACTIVE', 'VOICEMAIL', 'ENDED', 'FAILED', 'CANCELLED'],
  ACTIVE: ['ACTION_REQUIRED', 'ENDED', 'FAILED', 'CANCELLED'],
  ACTION_REQUIRED: ['ACTIVE', 'ENDED', 'FAILED', 'CANCELLED'],
  ENDED: [...OUTCOMES, 'CANCELLED'],
  COMPLETED: [],
  PARTIAL_SUCCESS: [],
  REQUIRES_CONFIRMATION: [],
  POLICY_VIOLATION: [],
  FAILED: [],
  NO_ANSWER: [],
  BUSY: [],
  VOICEMAIL: [],
  CANCELLED: [],
};

export class IllegalCallTransition extends Error {}

export const isTerminalCall = (s: CallState) => TERMINAL_CALL_STATES.includes(s);

export function transitionCall(from: CallState, to: CallState): CallState {
  if (from === to && (to === 'ACTIVE' || to === 'ACTION_REQUIRED')) return to; // more conversation in the same phase
  if (!CALL_TRANSITIONS[from].includes(to)) throw new IllegalCallTransition(`illegal call transition ${from} → ${to}`);
  return to;
}

/** Stored event (provider `call.*` or worker `call.outcome` / `call.validated`) → the state it implies. */
export function stateForEvent(type: string, data: Record<string, unknown>): CallState | null {
  switch (type) {
    case 'call.validating':
      return 'VALIDATING';
    case 'call.resolving_phone':
      return 'RESOLVING_PHONE';
    case 'call.dialing':
      return 'DIALING';
    case 'call.connected':
      return 'CONNECTED';
    case 'call.transcript':
      return 'ACTIVE';
    case 'call.action_required':
      return 'ACTION_REQUIRED';
    case 'call.ended':
      return data.reason === 'cancelled' ? 'CANCELLED' : 'ENDED';
    case 'call.failed':
      return data.reason === 'no_answer' ? 'NO_ANSWER' : data.reason === 'busy' ? 'BUSY' : data.reason === 'voicemail' ? 'VOICEMAIL' : 'FAILED';
    case 'call.outcome':
      return data.state as CallState;
    default:
      return null; // call.created and anything informational
  }
}

/** Folds events into the current state; an illegal sequence is an error, never silently accepted. */
export function foldCallState(events: { type: string; data: Record<string, unknown> }[], initial: CallState = 'PENDING'): CallState {
  let s = initial;
  for (const e of events) {
    const next = stateForEvent(e.type, e.data);
    if (!next) continue;
    // A conversation turn after an action request means the call resumed.
    if (s === 'ACTION_REQUIRED' && next === 'ACTIVE') {
      s = 'ACTIVE';
      continue;
    }
    if (s === 'CONNECTED' && next === 'ACTION_REQUIRED') s = transitionCall(s, 'ACTIVE');
    s = transitionCall(s, next);
  }
  return s;
}
