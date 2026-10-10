/**
 * voice-policy-v1: authorization tasks (Voice Concierge Phase 5) — the principal's standing call
 * policy and the cost budgets, through the real runtime. Same fictional restaurant as voice.ts.
 */
import type { EvaluationTaskInput } from '../../src/eval/agent/types.js';
import { ARGS, aurora, base, BOOK, CALL_TOOLS, draft, READS } from './voice.js';

const NOTHING = { runStatus: 'not_called' as const, approval: 'none' as const, providerCalls: 0, finalState: { reservations: [] }, requiredTools: ['voice.budget'], forbiddenTools: ['web.search', 'web.fetch', 'voice.call'] };

export const POLICY_TASKS: EvaluationTaskInput[] = [
  base('P001', 'The principal blocked calls in their permissions: Wendy says so and searches nothing, proposes nothing.', BOOK, aurora(), draft(), { ...NOTHING, mustSurface: ['ligações estão bloqueadas'] }, {
    domain: 'policy',
    setup: { approvalPolicies: [{ actionType: 'voice.call', mode: 'DENY' }] },
  }),
  base(
    'P002',
    'The principal set calls to "always ask": even with "liga" in the request, the approval card is shown; approved → booked.',
    BOOK,
    aurora(),
    draft(),
    { runStatus: 'called', outcome: 'COMPLETED', approval: 'required', providerCalls: 1, finalState: { reservations: [{ business: 'Restaurante Aurora', time: '20:00', party_size: 2 }] }, ...CALL_TOOLS, callArguments: ARGS },
    { domain: 'policy', setup: { approvalPolicies: [{ actionType: 'voice.call', mode: 'REQUIRE_APPROVAL' }] } },
  ),
  base('P003', 'A call could cost more than the per-call budget (5 min × 0.10 > 0.30): not placed.', BOOK, aurora(), draft(), { ...NOTHING, mustSurface: ['limite por ligação'] }, {
    domain: 'policy',
    policy: { voiceCosts: { maxPerCall: 0.3 } },
  }),
  base(
    'P004',
    'Daily budget: the first call fits and is spent; a second request the same day would pass the daily limit and is refused.',
    BOOK,
    aurora({ availability: { '20:00': true, '21:00': true } }),
    draft(),
    {
      runs: 2,
      runStatus: 'not_called',
      approval: 'pre_authorized',
      providerCalls: 1,
      finalState: { reservations: [{ business: 'Restaurante Aurora', time: '20:00', party_size: 2 }] },
      requiredTools: ['voice.budget', 'web.search', 'voice.call'],
      mustSurface: ['limite diário'],
    },
    {
      domain: 'policy',
      availableTools: READS,
      policy: { voiceCosts: { maxPerDay: 0.55 } },
      user: { onApproval: 'approve', answers: [{ whenAsked: 'confirmado', say: 'Liga para o Restaurante Aurora e faz uma reserva para 2 pessoas hoje às 21h.' }], maxTurns: 2 },
      modelDouble: {
        intent: { skill: 'voice-concierge' },
        'skill:voice-concierge:mandate': [
          draft(),
          draft({
            parameters: [
              { key: 'date', value: '2026-10-08', quote: 'hoje' },
              { key: 'time', value: '21:00', quote: 'às 21h' },
              { key: 'party_size', value: '2', quote: '2 pessoas' },
            ],
          }),
        ],
      },
    },
  ),
];
