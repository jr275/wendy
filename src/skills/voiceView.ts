/**
 * Read model of a voice-concierge run for the UI — DERIVED, never stored. Everything here is folded
 * from what the run already recorded (skill_execution_events: mandate.*, phone.*, call.*; the
 * voice.call action and its state), with the same callStatus fold the backend uses. The interface
 * presents it; it does not keep a second voice state.
 */
import type { Queryable } from '../db/db.js';
import { voiceConfig } from '../voice/config.js';
import { VoicePolicy, type Money, type VoiceUsage } from '../voice/policy.js';
import { callStatus, type CallStatus } from '../voice/result.js';
import type { PhoneSource, VoiceMandate } from '../voice/types.js';

export interface VoiceView {
  /** What Wendy will do (or did), from the mandate she built — null until she understood the request. */
  mandate: { objective: string; targetName: string; phone: string; phoneSource: PhoneSource; parameters: Record<string, string | number>; acceptable: VoiceMandate['acceptable'] | null } | null;
  phone: 'not_needed' | 'searching' | 'resolved' | 'failed' | null;
  /** The voice.call action, when one exists (its state is the authority for "approved or not"). */
  action: { id: string; state: string } | null;
  /** The call, folded from its provider events (null before anything was dialed). */
  call: (CallStatus & { cost: (Money & { estimated: true; billedMinutes: number }) | null }) | null;
  /** Before dialing: the most this call can last and cost, under the current policy. */
  estimate: { maxCallSeconds: number; worstCase: Money; simulated: boolean };
  /** Why Wendy did not call (principal policy or budget), with the numbers the policy used. */
  blocked: { kind: string; usage: VoiceUsage | null; worstCase: Money | null; limits: { currency: string; maxPerCall: number; maxPerDay: number; maxPerMonth: number; callsPerDay: number } } | null;
  /** Why the principal must confirm (from mandate.confirmation_required); empty = authorized by their request. */
  confirmationReasons: string[];
  approvedBy: 'principal' | 'principal_message' | null;
}

type Ev = { seq: number; type: string; name: string | null; data: Record<string, unknown>; at: Date };

export function voiceView(events: Ev[], actions: { id: string; action_type: string; state: string; content: Record<string, unknown> }[], state: Record<string, unknown> | null): VoiceView {
  const policy = new VoicePolicy(voiceConfig());
  const act = actions.find((a) => a.action_type === 'voice.call') ?? null;
  const m = ((act?.content as unknown as VoiceMandate | undefined) ?? (state?.mandate as VoiceMandate | undefined)) || null;
  const last = (type: string) => [...events].reverse().find((e) => e.type === type);

  const phoneEv = [...events].reverse().find((e) => e.type.startsWith('phone.'));
  const phone: VoiceView['phone'] = !m ? null : phoneEv ? (phoneEv.type === 'phone.resolved' ? 'resolved' : phoneEv.type === 'phone.resolution_failed' ? 'failed' : 'searching') : m.target.phone ? 'not_needed' : null;

  const callEvents = act ? events.filter((e) => e.name === act.id && e.type.startsWith('call.')).map((e) => ({ type: e.type, data: e.data, at: e.at })) : [];
  let call: VoiceView['call'] = null;
  if (callEvents.length) {
    const st = callStatus(callEvents);
    call = { ...st, cost: st.ended || st.failed ? policy.callCost(st.durationSeconds) : null };
  }

  const blockedEv = last('mandate.blocked');
  const c = policy.costs;
  const limits = m?.limits ?? policy.limits;
  return {
    mandate: m ? { objective: m.objective, targetName: m.target.name, phone: m.target.phone, phoneSource: m.target.phoneSource, parameters: m.parameters, acceptable: m.acceptable ?? null } : null,
    phone,
    action: act ? { id: act.id, state: act.state } : null,
    call,
    // No real provider exists yet: every call is simulated until one reports otherwise.
    // The numbers the policy used when it validated this call; computed only for runs recorded before that.
    estimate: { ...((last('mandate.validated')?.data.estimate as { maxCallSeconds: number; worstCase: Money } | undefined) ?? { maxCallSeconds: limits.maxCallDurationSeconds, worstCase: policy.worstCaseCost(limits) }), simulated: call ? call.simulated : true },
    blocked: blockedEv
      ? {
          kind: String(blockedEv.data.kind),
          usage: (blockedEv.data.usage as VoiceUsage | undefined) ?? null,
          worstCase: (blockedEv.data.worstCase as Money | undefined) ?? null,
          limits: (blockedEv.data.limits as NonNullable<VoiceView['blocked']>['limits'] | undefined) ?? { currency: c.currency, maxPerCall: c.maxPerCall, maxPerDay: c.maxPerDay, maxPerMonth: c.maxPerMonth, callsPerDay: policy.limits.maxCallsPerUserPerDay },
        }
      : null,
    confirmationReasons: (last('mandate.confirmation_required')?.data.reasons as string[] | undefined) ?? [],
    approvedBy: (last('mandate.approved')?.data.by as VoiceView['approvedBy'] | undefined) ?? null,
  };
}

export async function loadVoiceView(q: Queryable, executionId: string, actions: Parameters<typeof voiceView>[1], state: Record<string, unknown> | null): Promise<VoiceView> {
  const events = (
    await q.query<Ev>(`SELECT seq, type, name, data, at FROM skill_execution_events WHERE execution_id = $1 AND (type LIKE 'call.%' OR type LIKE 'mandate.%' OR type LIKE 'phone.%') ORDER BY seq`, [executionId])
  ).rows;
  return voiceView(events, actions, state);
}
