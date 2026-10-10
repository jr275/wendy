/**
 * VOICE POLICY — the only place that answers, for a call:
 *   can Wendy call this number? · may she say this? · may she do this? · does it need the principal?
 *   is the mandate acceptable? · is the task within its limits?
 * Decided by code. Neither the provider nor the person on the line can change it.
 */
import type { VoiceConfig, VoiceCostLimits } from './config.js';
import type { DisclosureCategory, PhoneSource, VoiceAction, VoiceLimits, VoiceMandate } from './types.js';

export interface Money {
  amount: number;
  currency: string;
}

/** Calls and spending already used (from the action log and the ledger). */
export interface VoiceUsage {
  callsInTask: number;
  callsToday: number;
  spentToday: number;
  spentMonth: number;
}

export type Sensitivity = 'public' | 'personal' | 'secret';

/** Extensible registry of disclosable information. `secret` is never said on a call, mandate or not. */
export const DEFAULT_DISCLOSURE_REGISTRY: Record<DisclosureCategory, Sensitivity> = {
  booking_details: 'public',
  principal_name: 'personal',
  contact_phone: 'personal',
  contact_email: 'personal',
  address: 'personal',
  password: 'secret',
  auth_code: 'secret',
  payment_card: 'secret',
  bank_account: 'secret',
  document_id: 'secret',
  credentials: 'secret',
  security_answer: 'secret',
};

/** Never pre-authorized: these always come back to the principal. */
export const FINANCIAL: readonly VoiceAction[] = ['pay', 'purchase', 'accept_charge'];
export const BINDING: readonly VoiceAction[] = ['sign_contract', 'cancel', 'change_account'];

export type ActionDecision = 'allowed' | 'requires_confirmation' | 'forbidden';
export type DisclosureDecision = { decision: 'allowed'; value: string } | { decision: 'not_authorized' } | { decision: 'forbidden' };
export type NumberDecision = { ok: true; e164: string } | { ok: false; reason: string };

const round = (x: number) => Math.round(x * 100) / 100;

export class VoicePolicy {
  constructor(
    private readonly config: VoiceConfig,
    private readonly registry: Record<DisclosureCategory, Sensitivity> = DEFAULT_DISCLOSURE_REGISTRY,
  ) {}

  get limits(): VoiceLimits {
    return this.config.limits;
  }

  get costs(): VoiceCostLimits {
    return this.config.costs;
  }

  // ── costs ────────────────────────────────────────────────────────────────────────────

  /** Estimated cost of a call that was connected for `seconds` (billed per started minute). */
  callCost(seconds: number | null): Money & { estimated: true; billedMinutes: number } {
    const billedMinutes = seconds && seconds > 0 ? Math.ceil(seconds / 60) : 0;
    return { amount: round(billedMinutes * this.config.costs.perMinute), currency: this.config.costs.currency, estimated: true, billedMinutes };
  }

  /** The most a call under these limits can cost (it is cut at the maximum duration). */
  worstCaseCost(limits: VoiceLimits): Money {
    return { amount: round(Math.ceil(limits.maxCallDurationSeconds / 60) * this.config.costs.perMinute), currency: this.config.costs.currency };
  }

  /** Before placing a call: could it break the per-call, daily or monthly budget? */
  checkCostLimits(usage: Pick<VoiceUsage, 'spentToday' | 'spentMonth'>, limits: VoiceLimits): { ok: true; worstCase: Money } | { ok: false; reason: string; kind: 'per_call' | 'day' | 'month'; worstCase: Money } {
    const c = this.config.costs;
    const worstCase = this.worstCaseCost(limits);
    const fmt = (x: number) => `${c.currency} ${x.toFixed(2)}`;
    if (worstCase.amount > c.maxPerCall) return { ok: false, kind: 'per_call', reason: `a call can cost up to ${fmt(worstCase.amount)}, over the per-call limit of ${fmt(c.maxPerCall)}`, worstCase };
    if (usage.spentToday + worstCase.amount > c.maxPerDay) return { ok: false, kind: 'day', reason: `${fmt(usage.spentToday)} spent today; another call could pass the daily limit of ${fmt(c.maxPerDay)}`, worstCase };
    if (usage.spentMonth + worstCase.amount > c.maxPerMonth) return { ok: false, kind: 'month', reason: `${fmt(usage.spentMonth)} spent this month; another call could pass the monthly limit of ${fmt(c.maxPerMonth)}`, worstCase };
    return { ok: true, worstCase };
  }

  // ── confirmation ─────────────────────────────────────────────────────────────────────

  /**
   * Why the principal must confirm this call before it is placed (empty = their request already
   * authorized it). Only the principal's own words can skip the confirmation, never the model's.
   */
  confirmationReasons(c: { authorizationQuote: string | null; messageId: string | null; sensitiveRequested: VoiceAction[]; phoneSource: PhoneSource }): string[] {
    const reasons: string[] = [];
    if (!this.config.preauthorizeFromRequest) reasons.push('configured to always confirm calls');
    if (!c.authorizationQuote || !c.messageId) reasons.push('no explicit authorization in the request');
    if (c.sensitiveRequested.length) reasons.push(`sensitive request stays with the principal: ${c.sensitiveRequested.join(', ')}`);
    if (c.phoneSource.kind === 'web_page' && c.phoneSource.confidence !== 'high') reasons.push(`phone found on the web with ${c.phoneSource.confidence ?? 'unknown'} confidence`);
    return reasons;
  }

  sensitivity(category: DisclosureCategory): Sensitivity {
    return this.registry[category] ?? 'secret'; // unknown kinds of information are treated as secret
  }

  /** E.164, allowed country, not short / emergency / premium; the number must come from somewhere real. */
  canCall(phone: string, source: VoiceMandate['target']['phoneSource']): NumberDecision {
    const e164 = phone.replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d+$/.test(e164)) return { ok: false, reason: 'not an E.164 number' };
    const country = this.config.allowedCountries.find((c) => e164.startsWith(`+${c}`));
    if (!country) return { ok: false, reason: 'country not allowed' };
    const national = e164.slice(1 + country.length);
    if (this.config.emergencyNumbers.includes(national)) return { ok: false, reason: 'emergency number' };
    if (!/^\+[1-9]\d{7,14}$/.test(e164)) return { ok: false, reason: 'not an E.164 number' };
    if (country === '55') {
      if (national.length < 10 || national.length > 11) return { ok: false, reason: 'short or malformed national number' };
      if (this.config.blockedNationalPrefixes.some((p) => national.startsWith(p))) return { ok: false, reason: 'premium or blocked service number' };
    }
    if (source.kind === 'web_page' && !source.ref) return { ok: false, reason: 'number found on the web must cite its page' };
    return { ok: true, e164 };
  }

  /** The principal's mandate, made safe: errors if it tries to pre-authorize what must stay with the principal. */
  validateMandate(m: VoiceMandate): { ok: true; mandate: VoiceMandate } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    const n = this.canCall(m.target.phone, m.target.phoneSource);
    if (!n.ok) errors.push(`phone: ${n.reason}`);
    const pre = m.authorizedActions.filter((a) => FINANCIAL.includes(a) || BINDING.includes(a));
    if (pre.length) errors.push(`cannot pre-authorize: ${pre.join(', ')} (always confirmed by the principal)`);
    const secrets = m.disclosures.filter((d) => this.sensitivity(d.category) === 'secret').map((d) => d.category);
    if (secrets.length) errors.push(`cannot disclose: ${secrets.join(', ')}`);
    const L = this.config.limits;
    if (m.limits.maxCallDurationSeconds > L.maxCallDurationSeconds || m.limits.maxCallsPerTask > L.maxCallsPerTask || m.limits.maxCallsPerUserPerDay > L.maxCallsPerUserPerDay) errors.push('limits above the configured maximum');
    if (m.acceptable && !m.authorizedActions.includes('accept_alternative')) errors.push('acceptable alternatives need accept_alternative');
    if (errors.length) return { ok: false, errors };
    const forbidden = [...new Set([...m.forbiddenActions, ...FINANCIAL, ...BINDING])];
    return { ok: true, mandate: { ...m, target: { ...m.target, phone: (n as { e164: string }).e164 }, forbiddenActions: forbidden } };
  }

  /** May Wendy do this now, on this call? */
  evaluateAction(action: VoiceAction, m: VoiceMandate): ActionDecision {
    if (FINANCIAL.includes(action) || BINDING.includes(action)) return 'requires_confirmation';
    if (m.forbiddenActions.includes(action)) return 'forbidden';
    return m.authorizedActions.includes(action) ? 'allowed' : 'requires_confirmation';
  }

  /** May Wendy say this? Only what the mandate lists, and never a secret. */
  canDisclose(category: DisclosureCategory, m: VoiceMandate): DisclosureDecision {
    if (this.sensitivity(category) === 'secret') return { decision: 'forbidden' };
    const d = m.disclosures.find((x) => x.category === category);
    return d ? { decision: 'allowed', value: d.value } : { decision: 'not_authorized' };
  }

  /** Is an alternative inside what the principal already accepted? */
  withinAcceptable(offer: Record<string, string | number>, m: VoiceMandate): boolean {
    if (!m.authorizedActions.includes('accept_alternative') || !m.acceptable?.time) return false;
    const t = String(offer.time ?? '');
    return /^\d{2}:\d{2}$/.test(t) && t >= m.acceptable.time.from && t <= m.acceptable.time.to;
  }

  /** Before placing a call: calls already made for this task and today. */
  checkCallLimits(usage: { callsInTask: number; callsToday: number }, limits: VoiceLimits): { ok: true } | { ok: false; reason: string } {
    if (usage.callsInTask >= limits.maxCallsPerTask) return { ok: false, reason: `this task already made ${usage.callsInTask} call(s)` };
    if (usage.callsToday >= limits.maxCallsPerUserPerDay) return { ok: false, reason: `daily limit of ${limits.maxCallsPerUserPerDay} calls reached` };
    return { ok: true };
  }

  /** During a call: has it run too long? */
  exceededDuration(connectedAt: Date | null, now: Date, limits: VoiceLimits): boolean {
    return !!connectedAt && (now.getTime() - connectedAt.getTime()) / 1000 > limits.maxCallDurationSeconds;
  }
}
