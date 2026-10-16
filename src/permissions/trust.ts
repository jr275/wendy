/**
 * TRUST TIERS AND GRANTS for people other than the principal. Adapted from Open Instinct (docs/PERMISSIONS.md): six tiers,
 * a capability table, grants that expire. Pure: no database, no clock of its own, no I/O.
 *
 * It is NOT a second permission engine. Wendy's engine (policy.ts) decides what an EFFECT needs; this decides what a PERSON
 * may ask for. The two are combined with combineDecisions(), which can only make the outcome stricter: trust never turns
 * "asks" into "runs" and never lifts a DENY. Anything not listed is denied.
 *
 * Differences from Open Instinct, on purpose (Wendy asks more, never less):
 *  - an unknown capability is DENY, and an unknown tier is `stranger`;
 *  - `apps.use` is ASK for every tier but owner (Wendy treats anything that reaches outside as EXTERNAL: always asks);
 *  - a grant can lift a DENY only to ASK, never to ALLOW, and it must carry a future expiry;
 *  - owner-only capabilities that change who is trusted, what is remembered or scheduled cannot be granted at all;
 *  - `partner` has no `calendar.read` (the capability table says owner only; the tier prose in the source is looser).
 * NOT WIRED: Wendy has no channel through which another person can ask for something yet. This is the ready, tested
 * rule for when one exists (see docs/OPEN_INSTINCT_ADAPTATION.md).
 */
import type { PermissionDecision, PolicyMode } from './policy.js';

export const TIERS = ['owner', 'partner', 'family', 'friend', 'contact', 'stranger'] as const;
export type Tier = (typeof TIERS)[number];

export const CAPABILITIES = [
  'calendar.read', 'email.read', 'computer.use', 'files.read', 'files.write', 'memory.write', 'network.invite', 'trust.manage', 'schedule.manage',
  'calendar.freebusy', 'plans.propose', 'web.read', 'apps.use', 'network.ask',
  'calendar.write', 'plans.commit', 'email.send',
  'converse', 'owner.relay',
  'purchase', 'travel.book',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** ALLOW runs; ASK needs the principal; LIMIT is spending (the spend policy decides, and it always asks); DENY never. */
export type TrustMode = 'ALLOW' | 'ASK' | 'LIMIT' | 'DENY';
export interface TrustDecision {
  mode: TrustMode;
  rule: string;
  /** Rate limit, when the tier has one (a stranger's relays). */
  maxPerDay?: number;
  /** A stranger may only introduce themselves. */
  introOnly?: boolean;
}

const OWNER_ONLY: readonly Capability[] = ['calendar.read', 'email.read', 'computer.use', 'files.read', 'files.write', 'memory.write', 'network.invite', 'trust.manage', 'schedule.manage'];
/** Capabilities that decide who is trusted, what is remembered or what runs on a schedule: nobody else can ever be granted them. */
export const NON_GRANTABLE: readonly Capability[] = ['trust.manage', 'network.invite', 'schedule.manage', 'memory.write'];

const CIRCLE: readonly Capability[] = ['calendar.freebusy', 'plans.propose', 'web.read', 'network.ask']; // owner, partner, family, friend
const CIRCLE_ASK: readonly Capability[] = ['calendar.write', 'plans.commit']; // partner, family, friend ask first

function tierDefault(tier: Tier, cap: Capability): TrustDecision {
  if (tier === 'owner') return cap === 'purchase' || cap === 'travel.book' ? { mode: 'LIMIT', rule: 'owner: spending is limited by the spend policy' } : { mode: 'ALLOW', rule: 'owner' };
  if (OWNER_ONLY.includes(cap)) return { mode: 'DENY', rule: `${cap} is for the owner only` };
  if (cap === 'purchase' || cap === 'travel.book') return tier === 'partner' ? { mode: 'ASK', rule: 'partner: spending always asks the owner' } : { mode: 'DENY', rule: `${tier} cannot spend` };
  if (cap === 'converse') return tier === 'stranger' ? { mode: 'ALLOW', rule: 'stranger: introduction only', introOnly: true } : { mode: 'ALLOW', rule: `${tier} may converse` };
  if (cap === 'owner.relay') return tier === 'stranger' ? { mode: 'ALLOW', rule: 'stranger: a few messages a day', maxPerDay: 3 } : { mode: 'ALLOW', rule: `${tier} may leave a message` };
  const inCircle = tier === 'partner' || tier === 'family' || tier === 'friend';
  if (inCircle && cap === 'apps.use') return { mode: 'ASK', rule: `${tier}: using apps asks the owner (Wendy: reaching outside always asks)` };
  if (inCircle && CIRCLE.includes(cap)) return { mode: 'ALLOW', rule: `${tier} circle` };
  if (inCircle && CIRCLE_ASK.includes(cap)) return { mode: 'ASK', rule: `${tier}: changing the owner's plans asks first` };
  if (tier === 'partner' && cap === 'email.send') return { mode: 'ASK', rule: 'partner: sending email asks the owner' };
  return { mode: 'DENY', rule: `${tier} has no ${cap}` };
}

export interface Grant {
  /** Who it is for (a person id or label; matching is the caller's business). */
  to: string;
  capabilities: Capability[];
  scope?: { purpose?: string; from?: string; to?: string; maxUsd?: number };
  /** Required, and must be in the future when used: a grant always expires on its own. */
  expiresAt: string;
  note?: string;
}

export function grantIsActive(g: Grant, now: Date): boolean {
  const exp = Date.parse(g.expiresAt);
  if (!Number.isFinite(exp) || exp <= now.getTime()) return false;
  const from = g.scope?.from ? Date.parse(g.scope.from) : NaN;
  const until = g.scope?.to ? Date.parse(g.scope.to) : NaN;
  if (Number.isFinite(from) && now.getTime() < from) return false;
  if (Number.isFinite(until) && now.getTime() > until) return false;
  return true;
}

export function isTier(v: unknown): v is Tier {
  return typeof v === 'string' && (TIERS as readonly string[]).includes(v);
}
export function isCapability(v: unknown): v is Capability {
  return typeof v === 'string' && (CAPABILITIES as readonly string[]).includes(v);
}

/** What `tier` may do with `capability` right now. An unknown tier is a stranger, an unknown capability is denied. */
export function decideTrust(input: { tier: unknown; capability: unknown; grants?: Grant[]; to?: string; now: Date }): TrustDecision {
  const tier: Tier = isTier(input.tier) ? input.tier : 'stranger';
  if (!isCapability(input.capability)) return { mode: 'DENY', rule: 'unknown capability: denied' };
  const cap = input.capability;
  const base = tierDefault(tier, cap);
  if (base.mode !== 'DENY' || tier === 'owner') return base;
  if (NON_GRANTABLE.includes(cap)) return { ...base, rule: `${base.rule}; it cannot be granted` };
  const grant = (input.grants ?? []).find((g) => (input.to === undefined || g.to === input.to) && g.capabilities.includes(cap) && grantIsActive(g, input.now));
  if (!grant) return base;
  // A grant widens only to "ask the owner", never to "run". Spending stays LIMIT: the spend policy decides, maxUsd is its ask threshold.
  return cap === 'purchase' || cap === 'travel.book'
    ? { mode: 'LIMIT', rule: `grant until ${grant.expiresAt}: spending still follows the spend policy` }
    : { mode: 'ASK', rule: `grant until ${grant.expiresAt}: asks the owner` };
}

const STRICT: Record<PolicyMode, number> = { AUTO: 0, REQUIRE_APPROVAL: 1, DENY: 2 };
const TRUST_AS_POLICY: Record<TrustMode, PolicyMode> = { ALLOW: 'AUTO', ASK: 'REQUIRE_APPROVAL', LIMIT: 'REQUIRE_APPROVAL', DENY: 'DENY' };

/** The strictest of Wendy's effect policy and the person's trust. Trust can only add caution. */
export function combineDecisions(permission: PermissionDecision, trust: TrustDecision): PermissionDecision {
  const t = TRUST_AS_POLICY[trust.mode];
  return STRICT[t] > STRICT[permission.mode] ? { mode: t, rule: `trust: ${trust.rule}` } : permission;
}
