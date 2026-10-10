/**
 * voice.call (EXTERNAL, HIGH — always approved), voice.call_status (READ) and voice.budget (READ).
 *
 * The approved action content IS the mandate. perform() re-checks it with VoicePolicy and the call
 * limits, then starts the call; the call goes on after perform returns (long-running effect), and
 * settle() keeps copying the provider's events into the skill run's log until the call ends. Only
 * then is the action verified — by reading back from the provider that the call to the approved
 * number happened. The outcome (completed, partial…) is the worker's job, not the provider's.
 *
 * Costs: every ended call's estimated cost goes into the ledger (VOICE_CALL_ENDED); spending today /
 * this month is read back from there, and perform() refuses a call that could pass a budget.
 */
import { z } from 'zod';
import { policyOverride } from '../actions/actions.js';
import { appendAudit } from '../audit/ledger.js';
import { withTx, type Queryable } from '../db/db.js';
import { appendExecutionEvent, executionEvents } from '../skills/events.js';
import type { Clock } from '../util/clock.js';
import { MandateAgent } from '../voice/agent.js';
import type { Money, VoicePolicy, VoiceUsage } from '../voice/policy.js';
import type { VoiceProvider } from '../voice/provider.js';
import { callStatus, type CallStatus } from '../voice/result.js';
import { CONFIRMATION_TRIGGERS, VOICE_ACTIONS, type VoiceEvent, type VoiceMandate } from '../voice/types.js';
import { TOOL_SPECS } from './specs.js';
import { ToolError, type ReadTool, type ToolContext, type ToolEffect } from './types.js';

const Action = z.enum(VOICE_ACTIONS);
export const MandateSchema = z.object({
  objective: z.string().min(5).max(500),
  language: z.string().min(2).max(10),
  target: z.object({
    name: z.string().min(1).max(200),
    phone: z.string().min(6).max(30),
    phoneSource: z.object({
      kind: z.enum(['principal', 'web_page']),
      ref: z.string().max(2000).optional(),
      title: z.string().max(300).optional(),
      sourceType: z.enum(['official_site', 'business_listing', 'other']).optional(),
      confidence: z.enum(['high', 'medium', 'low']).optional(),
      verifiedAt: z.string().max(40).optional(),
    }),
  }),
  parameters: z.record(z.string(), z.union([z.string().max(200), z.number()])),
  authorizedActions: z.array(Action),
  forbiddenActions: z.array(Action),
  acceptable: z.object({ time: z.object({ from: z.string(), to: z.string() }).optional() }).optional(),
  disclosures: z.array(z.object({ category: z.string().min(1).max(50), value: z.string().min(1).max(200) })).max(10),
  limits: z.object({ maxCallDurationSeconds: z.number().int().positive(), maxCallsPerTask: z.number().int().positive(), maxCallsPerUserPerDay: z.number().int().positive() }),
  constraints: z.object({ maxExtraCost: z.object({ amount: z.number().nonnegative(), currency: z.string().length(3) }).optional() }).optional(),
  confirmationRequired: z.array(z.enum(CONFIRMATION_TRIGGERS)).optional(),
  userContext: z.object({ request: z.string().max(4000), messageId: z.string().max(200).optional() }).optional(),
  idempotencyKey: z.string().max(200).optional(),
}) satisfies z.ZodType<VoiceMandate>;

export interface VoiceToolDeps {
  provider: () => Promise<VoiceProvider>;
  policy: VoicePolicy;
  clock: Clock;
}

/** Provider events are stored once each, in order, on the skill run that requested the call. */
async function syncEvents(ctx: ToolContext & { actionId: string }, provider: VoiceProvider, events: VoiceEvent[]): Promise<void> {
  if (!ctx.executionId) return;
  const stored = new Set((await executionEvents(ctx.db, ctx.executionId, 'call.')).filter((e) => e.name === ctx.actionId).map((e) => e.data.seq));
  for (const e of events) {
    if (stored.has(e.seq)) continue;
    const { type, ...data } = e;
    await appendExecutionEvent(ctx.db, ctx.executionId, type, ctx.actionId, { ...data, provider: provider.name, simulated: provider.simulated }, new Date(e.at));
  }
}

/**
 * Calls and estimated spending so far, from what is already recorded: executed voice.call actions
 * (calls) and VOICE_CALL_ENDED ledger entries (cost, counted at the time the call ended). Days and
 * months are UTC.
 */
export async function voiceUsage(q: Queryable, principalId: string, now: Date, scope: { executionId?: string; excludeActionId?: string } = {}): Promise<VoiceUsage> {
  const calls = (
    await q.query<{ in_task: number; today: number }>(
      `SELECT count(*) FILTER (WHERE $2::uuid IS NOT NULL AND a.skill_execution_id IN (SELECT id FROM skill_executions WHERE root_id = (SELECT root_id FROM skill_executions WHERE id = $2::uuid)))::int AS in_task,
              count(*) FILTER (WHERE x.created_at >= date_trunc('day', $3::timestamptz))::int AS today
         FROM actions a JOIN action_executions x ON x.action_id = a.id
        WHERE a.principal_id = $1 AND a.action_type = 'voice.call' AND a.id::text <> coalesce($4, '') AND x.attempts > 0`,
      [principalId, scope.executionId ?? null, now, scope.excludeActionId ?? null],
    )
  ).rows[0]!;
  const spent = (
    await q.query<{ today: string | null; month: string | null }>(
      `WITH c AS (SELECT (payload->'cost'->>'amount')::numeric AS amount, (payload->>'endedAt')::timestamptz AS ended
                    FROM audit_blocks WHERE principal_id = $1 AND event_type = 'VOICE_CALL_ENDED' AND payload ? 'cost')
       SELECT sum(amount) FILTER (WHERE ended >= date_trunc('day', $2::timestamptz) AND ended < date_trunc('day', $2::timestamptz) + interval '1 day') AS today,
              sum(amount) FILTER (WHERE ended >= date_trunc('month', $2::timestamptz) AND ended < date_trunc('month', $2::timestamptz) + interval '1 month') AS month
         FROM c`,
      [principalId, now],
    )
  ).rows[0]!;
  return { callsInTask: calls.in_task, callsToday: calls.today, spentToday: Number(spent.today ?? 0), spentMonth: Number(spent.month ?? 0) };
}

export interface VoiceBudget {
  /** The principal's own policy for calls: never / always ask / default (ask unless their words authorize). */
  permission: 'never' | 'always_ask' | 'default';
  usage: VoiceUsage;
  limits: { callsPerDay: number; currency: string; maxPerCall: number; maxPerDay: number; maxPerMonth: number; perMinute: number };
  /** Could another call be placed now? Null when it could; else why not (code-readable kind + reason). */
  blocked: { kind: 'permission' | 'calls_per_day' | 'per_call' | 'day' | 'month'; reason: string } | null;
  worstCase: Money;
}

export function voiceTools(deps: VoiceToolDeps) {
  const call: ToolEffect<VoiceMandate> = {
    spec: TOOL_SPECS['voice.call'],
    input: MandateSchema,
    perform: async (ctx, mandate) => {
      if (!ctx.executionId) throw new ToolError('NOT_ALLOWED', 'a call must belong to a skill run');
      const provider = await deps.provider();
      const key = mandate.idempotencyKey ?? ctx.actionId; // same mandate → same call, even across retries or runs
      const existing = await provider.findCall(key);
      if (existing) return { providerRef: existing.providerCallId };

      const v = deps.policy.validateMandate(mandate);
      if (!v.ok) throw new ToolError('NOT_ALLOWED', `mandate refused by policy: ${v.errors.join('; ')}`);
      const usage = await voiceUsage(ctx.db, ctx.principalId, deps.clock.now(), { executionId: ctx.executionId, excludeActionId: ctx.actionId });
      const limits = deps.policy.checkCallLimits(usage, v.mandate.limits);
      if (!limits.ok) throw new ToolError('NOT_ALLOWED', `call limit: ${limits.reason}`);
      const budget = deps.policy.checkCostLimits(usage, v.mandate.limits);
      if (!budget.ok) throw new ToolError('NOT_ALLOWED', `cost limit: ${budget.reason}`);

      const { providerCallId } = await provider.createCall({ idempotencyKey: key, to: v.mandate.target.phone, mandate: v.mandate, agent: new MandateAgent(v.mandate, deps.policy) });
      await withTx(ctx.db, (tx) =>
        appendAudit(tx, { principalId: ctx.principalId, eventType: 'VOICE_CALL_STARTED', actor: 'WENDY', subjectType: 'action', subjectId: ctx.actionId, payload: { provider: provider.name, simulated: provider.simulated, providerCallId, to: v.mandate.target.phone } }),
      );
      await syncEvents(ctx, provider, (await provider.getCall(providerCallId)).events);
      return { providerRef: providerCallId };
    },
    settle: async (ctx, mandate) => {
      const provider = await deps.provider();
      const found = await provider.findCall(mandate.idempotencyKey ?? ctx.actionId);
      if (!found) return 'done'; // nothing was placed; verification will fail honestly
      let { events } = await provider.getCall(found.providerCallId);
      await syncEvents(ctx, provider, events);
      const finished = events.some((e) => e.type === 'call.ended' || e.type === 'call.failed');
      const connected = events.find((e) => e.type === 'call.connected');
      if (!finished && deps.policy.exceededDuration(connected ? new Date(connected.at) : null, deps.clock.now(), mandate.limits)) {
        await provider.endCall(found.providerCallId, 'duration_limit'); // the policy stops it, not the provider
        events = (await provider.getCall(found.providerCallId)).events;
        await syncEvents(ctx, provider, events);
      }
      const done = events.some((e) => e.type === 'call.ended' || e.type === 'call.failed');
      if (done) {
        const last = events[events.length - 1]!;
        const cost = deps.policy.callCost(callStatus(events.map(({ type, ...data }) => ({ type, data, at: new Date(data.at) }))).durationSeconds);
        await withTx(ctx.db, (tx) =>
          appendAudit(tx, {
            principalId: ctx.principalId,
            eventType: 'VOICE_CALL_ENDED',
            actor: 'SYSTEM',
            subjectType: 'action',
            subjectId: ctx.actionId,
            payload: { provider: provider.name, simulated: provider.simulated, last: last.type, reason: 'reason' in last ? last.reason : null, cost, endedAt: last.at },
          }),
        );
      }
      return done ? 'done' : 'pending';
    },
    // Verified = the approved call to the approved number took place and has ended (outcome aside).
    readBack: async (ctx, mandate) => {
      const provider = await deps.provider();
      const found = await provider.findCall(mandate.idempotencyKey ?? ctx.actionId);
      if (!found) return null;
      const c = await provider.getCall(found.providerCallId);
      return c.events.some((e) => e.type === 'call.ended' || e.type === 'call.failed') ? { providerRef: found.providerCallId, observed: { to: c.to } } : null;
    },
    expected: (m) => {
      const n = deps.policy.canCall(m.target.phone, m.target.phoneSource);
      return { to: n.ok ? n.e164 : m.target.phone };
    },
  };

  const status: ReadTool<{ actionId: string }, CallStatus> = {
    spec: TOOL_SPECS['voice.call_status'],
    input: z.object({ actionId: z.uuid() }),
    run: async (ctx, i) => {
      if (!ctx.executionId) throw new ToolError('NOT_ALLOWED', 'call status is read from a skill run');
      const st = callStatus((await executionEvents(ctx.db, ctx.executionId, 'call.')).filter((e) => e.name === i.actionId));
      return { ...st, cost: st.ended || st.failed ? deps.policy.callCost(st.durationSeconds) : null };
    },
  };

  const budget: ReadTool<Record<string, never>, VoiceBudget> = {
    spec: TOOL_SPECS['voice.budget'],
    input: z.object({}).strict(),
    run: async (ctx) => {
      const now = deps.clock.now();
      const usage = await voiceUsage(ctx.db, ctx.principalId, now, { executionId: ctx.executionId });
      const override = await policyOverride(ctx.db, ctx.principalId, 'voice.call');
      const permission = override === 'DENY' ? 'never' : override === 'REQUIRE_APPROVAL' ? 'always_ask' : 'default';
      const L = deps.policy.limits;
      const c = deps.policy.costs;
      const calls = deps.policy.checkCallLimits({ ...usage, callsInTask: 0 }, L);
      const cost = deps.policy.checkCostLimits(usage, L);
      const blocked: VoiceBudget['blocked'] =
        permission === 'never'
          ? { kind: 'permission', reason: 'principal policy: never' }
          : !calls.ok
            ? { kind: 'calls_per_day', reason: calls.reason }
            : !cost.ok
              ? { kind: cost.kind, reason: cost.reason }
              : null;
      return { permission, usage, limits: { callsPerDay: L.maxCallsPerUserPerDay, currency: c.currency, maxPerCall: c.maxPerCall, maxPerDay: c.maxPerDay, maxPerMonth: c.maxPerMonth, perMinute: c.perMinute }, blocked, worstCase: cost.worstCase };
    },
  };

  return { 'voice.call': call, 'voice.call_status': status, 'voice.budget': budget };
}
