/**
 * Patterns adapted from Open Instinct: trust tiers + grants, a spend policy, and card-data masking. Pure: no database, no
 * network, no provider. The spend-policy loader reads only files this test creates in the OS temp directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decidePermission, type PermissionDecision, type PolicyMode } from '../../src/permissions/policy.js';
import { evaluateSpend, loadSpendPolicy, NO_SPENDING, normalizeMerchant, SpendPolicySchema, type SpendPolicy } from '../../src/permissions/spendPolicy.js';
import { CAPABILITIES, combineDecisions, decideTrust, grantIsActive, NON_GRANTABLE, TIERS, type Grant, type TrustMode } from '../../src/permissions/trust.js';
import { CARD_MASK, maskCardData } from '../../src/security/cardRedaction.js';
import { redactSecrets } from '../../src/cognition/resilience.js';

const NOW = new Date('2026-10-10T12:00:00Z');
const trust = (tier: unknown, capability: unknown, grants?: Grant[], to?: string) => decideTrust({ tier, capability, grants, to, now: NOW });
const grant = (over: Partial<Grant> = {}): Grant => ({ to: 'maria', capabilities: ['calendar.freebusy'], expiresAt: '2026-10-11T00:00:00Z', ...over });

describe('trust tiers', () => {
  it('the owner may do everything except spend, which is limited by the spend policy', () => {
    for (const c of CAPABILITIES) expect(trust('owner', c).mode, c).toBe(c === 'purchase' || c === 'travel.book' ? 'LIMIT' : 'ALLOW');
  });
  it('owner-only capabilities are denied to every other tier', () => {
    for (const tier of TIERS.filter((t) => t !== 'owner')) for (const c of ['calendar.read', 'email.read', 'computer.use', 'files.read', 'files.write', 'memory.write', 'network.invite', 'trust.manage', 'schedule.manage'] as const) expect(trust(tier, c).mode, `${tier} ${c}`).toBe('DENY');
  });
  it('the circle sees free/busy and proposes; changing the owner\'s plans asks; apps ask (Wendy is stricter than the source)', () => {
    for (const tier of ['partner', 'family', 'friend'] as const) {
      expect(trust(tier, 'calendar.freebusy').mode).toBe('ALLOW');
      expect(trust(tier, 'plans.propose').mode).toBe('ALLOW');
      expect(trust(tier, 'calendar.write').mode).toBe('ASK');
      expect(trust(tier, 'plans.commit').mode).toBe('ASK');
      expect(trust(tier, 'apps.use').mode).toBe('ASK');
    }
    expect(trust('partner', 'email.send').mode).toBe('ASK');
    for (const tier of ['family', 'friend', 'contact', 'stranger'] as const) expect(trust(tier, 'email.send').mode).toBe('DENY');
  });
  it('spending: partner asks, everyone else is denied', () => {
    for (const c of ['purchase', 'travel.book'] as const) {
      expect(trust('partner', c).mode).toBe('ASK');
      for (const tier of ['family', 'friend', 'contact', 'stranger'] as const) expect(trust(tier, c).mode).toBe('DENY');
    }
  });
  it('contacts converse and leave messages and nothing more; a stranger gets an introduction and three relays a day', () => {
    expect(trust('contact', 'converse').mode).toBe('ALLOW');
    expect(trust('contact', 'owner.relay').mode).toBe('ALLOW');
    expect(trust('contact', 'web.read').mode).toBe('DENY');
    expect(trust('stranger', 'converse')).toMatchObject({ mode: 'ALLOW', introOnly: true });
    expect(trust('stranger', 'owner.relay')).toMatchObject({ mode: 'ALLOW', maxPerDay: 3 });
    expect(trust('stranger', 'calendar.freebusy').mode).toBe('DENY');
  });
  it('default deny: an unknown capability is denied, an unknown tier is a stranger', () => {
    expect(trust('owner', 'rm.everything').mode).toBe('DENY');
    expect(trust('friend', undefined).mode).toBe('DENY');
    expect(trust('admin', 'calendar.freebusy').mode).toBe('DENY'); // stranger has no free/busy
    expect(trust('admin', 'converse')).toMatchObject({ mode: 'ALLOW', introOnly: true });
  });
});

describe('grants', () => {
  it('lift a DENY only to ASK, never to ALLOW', () => {
    const d = trust('contact', 'calendar.freebusy', [grant()], 'maria');
    expect(d.mode).toBe('ASK');
  });
  it('spending stays LIMIT under a grant (the spend policy still decides)', () => {
    expect(trust('friend', 'purchase', [grant({ capabilities: ['purchase'], scope: { maxUsd: 20 } })], 'maria').mode).toBe('LIMIT');
  });
  it('expire on their own: a missing, past or invalid expiry is not active', () => {
    for (const expiresAt of ['2026-10-10T11:59:59Z', 'not a date', '']) expect(grantIsActive(grant({ expiresAt }), NOW), expiresAt).toBe(false);
    expect(trust('contact', 'calendar.freebusy', [grant({ expiresAt: '2026-10-10T11:59:59Z' })], 'maria').mode).toBe('DENY');
  });
  it('respect their window and the person they are for', () => {
    expect(grantIsActive(grant({ scope: { from: '2026-10-10T13:00:00Z' } }), NOW)).toBe(false);
    expect(grantIsActive(grant({ scope: { to: '2026-10-10T11:00:00Z' } }), NOW)).toBe(false);
    expect(grantIsActive(grant({ scope: { from: '2026-10-10T11:00:00Z', to: '2026-10-10T13:00:00Z' } }), NOW)).toBe(true);
    expect(trust('contact', 'calendar.freebusy', [grant()], 'someone-else').mode).toBe('DENY');
  });
  it('cannot grant what decides who is trusted, what is remembered or what is scheduled', () => {
    for (const c of NON_GRANTABLE) {
      const d = trust('friend', c, [grant({ capabilities: [c] })], 'maria');
      expect(d.mode, c).toBe('DENY');
    }
  });
  it('never touch the owner or an already allowed decision', () => {
    expect(trust('owner', 'files.write', [grant({ capabilities: ['files.write'] })]).mode).toBe('ALLOW');
    expect(trust('friend', 'calendar.freebusy', [grant()], 'maria').mode).toBe('ALLOW');
  });
});

describe('combining trust with Wendy\'s permission engine can only make the outcome stricter', () => {
  const STRICT: Record<PolicyMode, number> = { AUTO: 0, REQUIRE_APPROVAL: 1, DENY: 2 };
  const TRUST_STRICT: Record<TrustMode, number> = { ALLOW: 0, ASK: 1, LIMIT: 1, DENY: 2 };
  it('for every tier, capability and permission mode: result >= both inputs', () => {
    const permissions: PermissionDecision[] = [
      { mode: 'AUTO', rule: 'a' }, { mode: 'REQUIRE_APPROVAL', rule: 'b' }, { mode: 'DENY', rule: 'c' },
      decidePermission({ category: 'PAYMENT' }), decidePermission({ category: 'EXTERNAL' }), decidePermission({ category: 'READ' }),
    ];
    let n = 0;
    for (const tier of TIERS) for (const cap of CAPABILITIES) for (const p of permissions) {
      const t = trust(tier, cap);
      const r = combineDecisions(p, t);
      expect(STRICT[r.mode], `${tier} ${cap} ${p.mode}`).toBeGreaterThanOrEqual(STRICT[p.mode]);
      expect(STRICT[r.mode], `${tier} ${cap} ${p.mode}`).toBeGreaterThanOrEqual(TRUST_STRICT[t.mode]);
      if (p.mode === 'DENY' || p.mode === 'REQUIRE_APPROVAL') expect(r.mode, 'trust never lifts').not.toBe('AUTO');
      n++;
    }
    expect(n).toBe(TIERS.length * CAPABILITIES.length * permissions.length);
  });
  it('a payment can never come out automatic, whatever the tier says', () => {
    const pay = decidePermission({ category: 'PAYMENT' });
    for (const tier of TIERS) for (const cap of ['purchase', 'travel.book'] as const) expect(combineDecisions(pay, trust(tier, cap)).mode, `${tier} ${cap}`).not.toBe('AUTO');
  });
});

describe('spend policy', () => {
  const P: SpendPolicy = { perActionUsd: 100, perDayUsd: 300, askAbove: 50, neverWithoutAsk: ['flights', 'hotels'], allowedMerchants: [], blockedMerchants: ['Casino Royale'] };
  it('a payment always needs approval; confirmation comes first above the threshold or for a sensitive category', () => {
    expect(evaluateSpend(P, { amountUsd: 20, merchant: 'Acme' }, 0)).toEqual({ mode: 'REQUIRE_APPROVAL', rule: 'payments always need approval', confirmFirst: false });
    expect(evaluateSpend(P, { amountUsd: 51, merchant: 'Acme' }, 0).confirmFirst).toBe(true);
    expect(evaluateSpend(P, { amountUsd: 10, merchant: 'Acme', category: 'Flights' }, 0).confirmFirst).toBe(true);
    expect(evaluateSpend(P, { amountUsd: 50, merchant: 'Acme' }, 0).confirmFirst).toBe(false); // "above", not "at"
  });
  it('over the per-action or the daily limit is denied, never asked', () => {
    expect(evaluateSpend(P, { amountUsd: 100.01, merchant: 'Acme' }, 0)).toMatchObject({ mode: 'DENY', rule: 'above the per-action limit' });
    expect(evaluateSpend(P, { amountUsd: 100, merchant: 'Acme' }, 200.01)).toMatchObject({ mode: 'DENY', rule: 'would pass the daily limit' });
    expect(evaluateSpend(P, { amountUsd: 100, merchant: 'Acme' }, 200).mode).toBe('REQUIRE_APPROVAL'); // exactly the daily limit is allowed
  });
  it('money is exact: cents, no floating-point drift', () => {
    expect(evaluateSpend({ ...P, perDayUsd: 0.3 }, { amountUsd: 0.2, merchant: 'Acme' }, 0.1).mode).toBe('REQUIRE_APPROVAL'); // 0.1 + 0.2 is 0.30000000000000004 in floats
  });
  it('merchant lists are enforced on a normalised name', () => {
    expect(evaluateSpend(P, { amountUsd: 5, merchant: '  CASINO   royale ' }, 0)).toMatchObject({ mode: 'DENY', rule: 'merchant is blocked' });
    const only = { ...P, allowedMerchants: ['Café São Jorge'] };
    expect(evaluateSpend(only, { amountUsd: 5, merchant: 'cafe sao jorge' }, 0).mode).toBe('REQUIRE_APPROVAL');
    expect(evaluateSpend(only, { amountUsd: 5, merchant: 'Acme' }, 0)).toMatchObject({ mode: 'DENY', rule: 'merchant is not on the allowed list' });
    expect(normalizeMerchant('Café  São')).toBe('cafe sao');
  });
  it('an invalid amount or merchant is denied', () => {
    for (const amountUsd of [0, -5, NaN, Infinity]) expect(evaluateSpend(P, { amountUsd, merchant: 'Acme' }, 0).mode, String(amountUsd)).toBe('DENY');
    expect(evaluateSpend(P, { amountUsd: 5, merchant: '  ' }, 0).mode).toBe('DENY');
    expect(evaluateSpend(P, { amountUsd: 5, merchant: 'Acme' }, -1).mode).toBe('DENY');
  });
  it('a grant can only lower the ask threshold', () => {
    expect(evaluateSpend(P, { amountUsd: 30, merchant: 'Acme' }, 0, 20).confirmFirst).toBe(true);
    expect(evaluateSpend(P, { amountUsd: 60, merchant: 'Acme' }, 0, 500).confirmFirst).toBe(true); // still above askAbove: a grant never raises it
  });
  it('the default policy spends nothing', () => {
    expect(evaluateSpend(NO_SPENDING, { amountUsd: 0.01, merchant: 'Acme' }, 0).mode).toBe('DENY');
  });
});

describe('the spend-policy file fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wendy-spend-'));
  const file = (name: string, body: string) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, body);
    return f;
  };
  it('no file means no spending', () => {
    expect(loadSpendPolicy(path.join(dir, 'missing.json'))).toEqual({ policy: NO_SPENDING, source: 'none' });
  });
  it('the example file is valid and is read as written', () => {
    const ex = path.resolve(__dirname, '../../config/spend-policy.example.json');
    const r = loadSpendPolicy(ex);
    expect(r.source).toBe('file');
    expect(r.policy).toMatchObject({ perActionUsd: 100, perDayUsd: 300, askAbove: 50 });
  });
  it('an invalid file means no spending, with the reason, never a quietly wider limit', () => {
    for (const body of ['{ not json', '{"perActionUsd": -1, "perDayUsd": 1, "askAbove": 1}', '{"perActionUsd": 10, "perDayUsd": 10, "askAbove": 1, "surprise": true}', '{"perDayUsd": 10}']) {
      const r = loadSpendPolicy(file('bad.json', body));
      expect(r.source, body).toBe('invalid');
      expect(r.policy).toEqual(NO_SPENDING);
      expect(r.error).toBeTruthy();
    }
    expect(SpendPolicySchema.safeParse({ perActionUsd: 1e9, perDayUsd: 1, askAbove: 1 }).success).toBe(false);
  });
});

describe('card-data masking', () => {
  it('masks real-looking card numbers, with or without separators', () => {
    for (const n of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', '5555555555554444', '378282246310005']) {
      expect(maskCardData(`card ${n} ok`), n).toBe(`card ${CARD_MASK} ok`);
    }
  });
  it('leaves everything that is not a card number alone', () => {
    for (const s of ['4111111111111112', 'order 20261010123456789', 'tel +55 11 91234-5678', '123e4567-e89b-12d3-a456-426614174000', '2026-10-10 22:03:48', 'R$ 1.234,56', 'id 123456789012']) expect(maskCardData(s), s).toBe(s);
  });
  it('masks a security code and an expiry only next to their label', () => {
    expect(maskCardData('CVC: 123')).toBe(`CVC: ${CARD_MASK}`);
    expect(maskCardData('cvv=4567')).toBe(`cvv=${CARD_MASK}`);
    expect(maskCardData('validade 08/29')).toBe(`validade ${CARD_MASK}`);
    expect(maskCardData('exp: 12/2030')).toBe(`exp: ${CARD_MASK}`);
    expect(maskCardData('o código 123 e a data 08/29 soltos')).toBe('o código 123 e a data 08/29 soltos');
  });
  it('is part of redactSecrets, so logs and stored errors never carry a card', () => {
    const out = redactSecrets('payment failed for 4111 1111 1111 1111 cvc 123, Authorization: Bearer abcdefghijkl');
    expect(out).not.toMatch(/4111|123 |abcdefghijkl/);
    expect(out).toContain(CARD_MASK);
    expect(redactSecrets('plain message')).toBe('plain message');
  });
});
