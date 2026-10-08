/**
 * PERMISSION ENGINE — one rule for every effect Wendy can have, decided by code, never by a model.
 *
 *   READ        → runs (no action record)
 *   WRITE       → the tool's declared default (ask unless declared AUTO); the principal may change it
 *   EXTERNAL    → always asks; can be forbidden, never made automatic
 *   DESTRUCTIVE → always asks; can be forbidden, never made automatic
 *   PAYMENT     → always asks; can be forbidden, never made automatic
 *
 * A principal policy of DENY wins over everything. Silence is never approval: an action that asks
 * waits in AWAITING_APPROVAL until approved, rejected or expired.
 */
export type ActionCategory = 'READ' | 'WRITE' | 'EXTERNAL' | 'DESTRUCTIVE' | 'PAYMENT';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type PolicyMode = 'AUTO' | 'REQUIRE_APPROVAL' | 'DENY';

export interface PermissionDecision {
  mode: PolicyMode;
  rule: string;
}

export interface PermissionSubject {
  category: ActionCategory;
  /** Only meaningful for WRITE: what happens when the principal has not set a policy. */
  defaultMode?: 'AUTO' | 'REQUIRE_APPROVAL';
}

const NEVER_AUTO: readonly ActionCategory[] = ['EXTERNAL', 'DESTRUCTIVE', 'PAYMENT'];

export const RISK_ORDER: readonly RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const maxRisk = (a: RiskLevel, b: RiskLevel): RiskLevel => (RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b);

/** Authorization level stored on actions (kept for the existing schema and UI). */
export const LEVEL: Record<ActionCategory, number> = { READ: 0, WRITE: 2, EXTERNAL: 3, DESTRUCTIVE: 4, PAYMENT: 4 };

export class PolicyError extends Error {}

/** Whether a principal may set `mode` for something in `category`. */
export function assertSettable(category: ActionCategory, mode: PolicyMode | null): void {
  if (mode === 'AUTO' && NEVER_AUTO.includes(category)) throw new PolicyError(`${category.toLowerCase()} actions cannot run without approval`);
}

export function decidePermission(subject: PermissionSubject, override: PolicyMode | null = null): PermissionDecision {
  const { category } = subject;
  if (override === 'DENY') return { mode: 'DENY', rule: 'principal policy: never' };
  if (override === 'REQUIRE_APPROVAL') return { mode: 'REQUIRE_APPROVAL', rule: 'principal policy: always ask' };
  if (NEVER_AUTO.includes(category)) return { mode: 'REQUIRE_APPROVAL', rule: `${category.toLowerCase()} action requires explicit approval` };
  if (override === 'AUTO') return { mode: 'AUTO', rule: 'principal policy: run automatically' };
  if (category === 'READ') return { mode: 'AUTO', rule: 'read-only' };
  return subject.defaultMode === 'AUTO'
    ? { mode: 'AUTO', rule: 'write declared safe to run automatically' }
    : { mode: 'REQUIRE_APPROVAL', rule: 'write requires approval by default' };
}
