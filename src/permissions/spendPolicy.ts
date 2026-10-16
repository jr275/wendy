/**
 * SPEND POLICY. Adapted from Open Instinct (docs/PAYMENTS.md): limits per action and per day, an "ask above" threshold,
 * categories that always need confirmation, merchant allow/block lists. Pure evaluator + a personal file, like
 * config/search-scope.json (not in git; see config/spend-policy.example.json).
 *
 * Wendy's rule stays: a PAYMENT is never automatic (policy.ts). So the answer is only ever DENY or REQUIRE_APPROVAL; the
 * policy decides whether it may even be asked, and whether the principal must confirm BEFORE the request is made.
 * Differences from Open Instinct, on purpose:
 *  - above the per-action or per-day limit is DENY, not "ask first" (change the policy to spend more);
 *  - merchant lists ARE enforced (Open Instinct documents that they are not yet), on a normalised name;
 *  - no file means no spending (the default is zero), and a present-but-invalid file fails closed the same way.
 * Money is computed in integer cents. NOT WIRED: Wendy has no payment tool; this is the rule for the day it does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const usd = z.number().finite().min(0).max(1_000_000);
export const SpendPolicySchema = z
  .object({
    perActionUsd: usd,
    perDayUsd: usd,
    askAbove: usd,
    neverWithoutAsk: z.array(z.string().min(1)).default([]),
    allowedMerchants: z.array(z.string().min(1)).default([]),
    blockedMerchants: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type SpendPolicy = z.infer<typeof SpendPolicySchema>;

/** Nothing may be spent. */
export const NO_SPENDING: SpendPolicy = { perActionUsd: 0, perDayUsd: 0, askAbove: 0, neverWithoutAsk: ['flights', 'hotels'], allowedMerchants: [], blockedMerchants: [] };

const cents = (n: number) => Math.round(n * 100);
export const normalizeMerchant = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export interface SpendRequest {
  amountUsd: number;
  merchant: string;
  /** e.g. "flights", "hotels": compared with neverWithoutAsk, case-insensitively. */
  category?: string;
}
export interface SpendDecision {
  mode: 'DENY' | 'REQUIRE_APPROVAL';
  rule: string;
  /** The principal must confirm BEFORE the payment request is made (over the ask threshold, or a sensitive category). Informational. */
  confirmFirst: boolean;
}

/** `spentTodayUsd` comes from the audit trail; `grantMaxUsd` (an active grant) can only LOWER the ask threshold. */
export function evaluateSpend(policy: SpendPolicy, req: SpendRequest, spentTodayUsd: number, grantMaxUsd?: number): SpendDecision {
  const deny = (rule: string): SpendDecision => ({ mode: 'DENY', rule, confirmFirst: false });
  if (!Number.isFinite(req.amountUsd) || req.amountUsd <= 0 || !Number.isFinite(spentTodayUsd) || spentTodayUsd < 0) return deny('invalid amount');
  if (!req.merchant.trim()) return deny('no merchant');
  const m = normalizeMerchant(req.merchant);
  if (policy.blockedMerchants.some((b) => normalizeMerchant(b) === m)) return deny('merchant is blocked');
  if (policy.allowedMerchants.length && !policy.allowedMerchants.some((a) => normalizeMerchant(a) === m)) return deny('merchant is not on the allowed list');
  const amount = cents(req.amountUsd);
  if (amount > cents(policy.perActionUsd)) return deny('above the per-action limit');
  if (cents(spentTodayUsd) + amount > cents(policy.perDayUsd)) return deny('would pass the daily limit');
  const threshold = grantMaxUsd !== undefined ? Math.min(policy.askAbove, grantMaxUsd) : policy.askAbove;
  const sensitive = !!req.category && policy.neverWithoutAsk.some((c) => c.toLowerCase() === req.category!.toLowerCase());
  return { mode: 'REQUIRE_APPROVAL', rule: 'payments always need approval', confirmFirst: sensitive || amount > cents(threshold) };
}

export interface LoadedSpendPolicy {
  policy: SpendPolicy;
  source: 'file' | 'none' | 'invalid';
  error?: string;
}

const defaultFile = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config/spend-policy.json');

/** Reads WENDY_SPEND_POLICY_FILE or config/spend-policy.json on every call. Missing → no spending; invalid → no spending, with the reason. */
export function loadSpendPolicy(file: string = process.env.WENDY_SPEND_POLICY_FILE ?? defaultFile()): LoadedSpendPolicy {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { policy: NO_SPENDING, source: 'none' };
  }
  try {
    const parsed = SpendPolicySchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { policy: parsed.data, source: 'file' };
    return { policy: NO_SPENDING, source: 'invalid', error: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  } catch {
    return { policy: NO_SPENDING, source: 'invalid', error: 'not valid JSON' };
  }
}
