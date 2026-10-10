/**
 * voice-concierge: ONE phone call on the principal's behalf. Generic — restaurants, hotels, clinics
 * are just mandates.
 *
 *   understand    the principal's words → draft (model, request only) → VoiceMandate (code: quotes
 *                 checked, authorization by level, never money/contracts) — or clarifying questions;
 *   authorize     voice.budget: the principal's call policy ("never"), calls per day and estimated
 *                 spending against the limits — before anything is searched or proposed;
 *   resolve_phone no number given → web.search + web.fetch → numbers read by code with their page,
 *                 ranked by source; ambiguous or missing → ask the principal;
 *   validate      VoicePolicy; decides whether the principal already authorized the call in words;
 *   call          `voice.call` as an EXTERNAL action (approved by the principal, or by their quoted
 *                 words — checked by the runtime); waits while the call runs;
 *   result        transcript + Wendy's in-call decisions → classified outcome.
 *
 * A complete mandate may also be given directly (composition, tests); then understanding is skipped.
 */
import { z } from 'zod';
import { ToolError } from '../../tools/types.js';
import { MandateSchema, type VoiceBudget } from '../../tools/voice.js';
import type { WebSearchResult } from '../../tools/web.js';
import { voiceConfig } from '../../voice/config.js';
import { buildMandate, MandateDraftSchema, summarizeMandate } from '../../voice/mandate.js';
import { resolvePhone } from '../../voice/phone.js';
import { VoicePolicy } from '../../voice/policy.js';
import type { CallStatus } from '../../voice/result.js';
import { voiceResult } from '../../voice/result.js';
import type { CallState } from '../../voice/stateMachine.js';
import type { VoiceAction, VoiceMandate, VoiceTaskResult } from '../../voice/types.js';
import { MANDATE_SYSTEM } from '../prompts.js';
import { SkillError, type SkillDefinition } from '../types.js';

const RequestInput = z.object({ request: z.string().min(3).max(2000) });
const Input = z.union([MandateSchema, RequestInput]);

const Output = z.object({
  /** needs_information / phone_unresolved: nothing was called; the questions say what is missing. */
  status: z.enum(['needs_information', 'phone_unresolved', 'called', 'not_called']),
  questions: z.array(z.string()),
  /** What Wendy understood, as approved (built by code from the mandate). */
  understood: z.array(z.string()),
  /** Why nothing was called, when Wendy stopped on her own (policy / limits), in the principal's language. */
  notice: z.string().nullable(),
  /** Estimated cost of the call (labeled estimate; simulated calls cost nothing real). */
  cost: z.object({ amount: z.number(), currency: z.string(), estimated: z.literal(true), billedMinutes: z.number() }).nullable(),
  actionId: z.string().nullable(),
  objective: z.string(),
  target: z.string(),
  result: z.custom<VoiceTaskResult>().nullable(),
  transcript: z.array(z.object({ speaker: z.string(), text: z.string(), at: z.string() })),
  durationSeconds: z.number().nullable(),
});
export type VoiceConciergeOutput = z.infer<typeof Output>;

const policy = () => new VoicePolicy(voiceConfig());

const money = (x: number, currency: string) => `${currency} ${x.toFixed(2).replace('.', ',')}`;

/** Why Wendy will not call now, in the principal's words (from voice.budget, decided by code). */
function blockedNotice(b: VoiceBudget): string {
  const L = b.limits;
  switch (b.blocked!.kind) {
    case 'permission':
      return 'Não liguei: nas suas permissões, ligações estão bloqueadas. Se quiser, mude isso em Permissões.';
    case 'calls_per_day':
      return `Não liguei: o limite de ${L.callsPerDay} ligações por dia já foi atingido.`;
    case 'per_call':
      return `Não liguei: uma ligação pode custar até ${money(b.worstCase.amount, L.currency)} (estimativa), acima do limite por ligação de ${money(L.maxPerCall, L.currency)}.`;
    case 'day':
      return `Não liguei: com o gasto estimado de hoje (${money(b.usage.spentToday, L.currency)}), mais uma ligação (até ${money(b.worstCase.amount, L.currency)}) passaria do limite diário de ${money(L.maxPerDay, L.currency)}.`;
    case 'month':
      return `Não liguei: com o gasto estimado do mês (${money(b.usage.spentMonth, L.currency)}), mais uma ligação (até ${money(b.worstCase.amount, L.currency)}) passaria do limite mensal de ${money(L.maxPerMonth, L.currency)}.`;
  }
}

const asked = (status: 'needs_information' | 'phone_unresolved', questions: string[], m: Partial<VoiceMandate>): VoiceConciergeOutput => ({
  status,
  questions,
  understood: [],
  notice: null,
  cost: null,
  actionId: null,
  objective: m.objective ?? '',
  target: m.target?.name ?? '',
  result: null,
  transcript: [],
  durationSeconds: null,
});

export const voiceConcierge: SkillDefinition<z.infer<typeof Input>, VoiceConciergeOutput> = {
  id: 'voice-concierge',
  name: 'Ligação',
  description:
    'Make one phone call on the principal\'s behalf to ask something, book, or join a waitlist, within limits Wendy shows the principal first. Input: {"request": "<the principal\'s request, verbatim>"}.',
  version: '0.3.0',
  category: 'agency',
  triggers: [{ kind: 'intent', examples: ['Liga para o restaurante Aprazível e tenta uma mesa para 2 amanhã às 20h', 'Liga para o hotel Fasano e pergunta se tem quarto disponível no sábado'] }],
  requiredTools: ['voice.budget', 'web.search', 'web.fetch', 'voice.call', 'voice.call_status'],
  composable: true,
  autonomous: false,
  riskLevel: 'HIGH',
  instructions: 'Stay inside the mandate. Never pay, sign, cancel or share protected information on a call.',
  inputs: Input,
  outputs: Output,
  steps: [
    {
      id: 'understand',
      label: 'Entendendo o pedido',
      retry: { attempts: 2, backoffMs: 1500 },
      timeoutMs: 90_000,
      run: async (ctx) => {
        const full = MandateSchema.safeParse(ctx.input);
        if (full.success) {
          ctx.state.mandate = full.data;
          return { kind: 'next' };
        }
        // The principal's own words: the chat message that started this run, else the given request.
        const request = ctx.trigger.kind === 'chat' && typeof ctx.trigger.question === 'string' ? ctx.trigger.question : RequestInput.parse(ctx.input).request;
        const messageId = typeof ctx.trigger.messageId === 'string' ? ctx.trigger.messageId : undefined;
        const me = await ctx.principal();
        const r = await ctx.reason({
          purpose: 'mandate',
          system: MANDATE_SYSTEM,
          user: [`Today: ${ctx.now.toISOString().slice(0, 10)} (UTC). Principal's language: ${me.locale}.`, '', 'Request:', request].join('\n'),
          schema: MandateDraftSchema,
          effort: 'low',
          evidenceRefs: [],
        });
        const built = buildMandate(r.output, { principalId: ctx.principalId, principalName: me.displayName, request, messageId, now: ctx.now, policy: policy(), language: me.locale });
        await ctx.record('mandate.created', 'mandate', {
          status: built.status,
          modelCallId: r.modelCallId,
          ...(built.status === 'complete'
            ? { authorizedActions: built.mandate.authorizedActions, parameters: built.mandate.parameters, sensitiveRequested: built.sensitiveRequested, explicitAuthorization: !!built.authorizationQuote, dropped: built.dropped, idempotencyKey: built.mandate.idempotencyKey }
            : { questions: built.questions }),
        });
        if (built.status === 'needs_information') return { kind: 'done', output: asked('needs_information', built.questions, built.partial) };
        ctx.state.mandate = built.mandate;
        ctx.state.fromRequest = { messageId: messageId ?? null, authorizationQuote: built.authorizationQuote, sensitiveRequested: built.sensitiveRequested, locationHint: built.locationHint };
        return { kind: 'next' };
      },
    },
    {
      id: 'authorize',
      label: 'Conferindo permissões e limites',
      run: async (ctx) => {
        const m = ctx.state.mandate as VoiceMandate;
        const b = (await ctx.read('voice.budget', {})) as VoiceBudget;
        ctx.state.permission = b.permission;
        // What the policy estimated for this call (shown on the approval card as the backend's numbers).
        ctx.state.estimate = { maxCallSeconds: m.limits.maxCallDurationSeconds, worstCase: b.worstCase };
        if (!b.blocked) return { kind: 'next' };
        await ctx.record('mandate.blocked', 'mandate', { kind: b.blocked.kind, reason: b.blocked.reason, usage: b.usage, worstCase: b.worstCase, limits: b.limits });
        return { kind: 'done', output: { ...asked('needs_information', [], m), status: 'not_called', understood: summarizeMandate({ ...m, target: { ...m.target, phone: m.target.phone || '' } }), notice: blockedNotice(b) } };
      },
    },
    {
      id: 'resolve_phone',
      label: 'Procurando o telefone',
      timeoutMs: 120_000,
      run: async (ctx) => {
        const m = ctx.state.mandate as VoiceMandate;
        if (m.target.phone) return { kind: 'next' };
        const hint = (ctx.state.fromRequest as { locationHint: string | null } | undefined)?.locationHint;
        const query = `${m.target.name}${hint ? ` ${hint}` : ''} telefone`;
        await ctx.record('phone.resolution_started', m.target.name, { query });
        const results = (await ctx.read('web.search', { query, max: 6 })) as WebSearchResult[];
        const ids: string[] = [];
        const skipped: string[] = [];
        for (const res of results) {
          if (ids.length >= 4) break;
          try {
            ids.push(((await ctx.read('web.fetch', { url: res.uri })) as { sourceId: string }).sourceId);
          } catch (e) {
            if (!(e instanceof ToolError)) throw e;
            skipped.push(res.uri);
          }
        }
        const pages = (await ctx.sources(ids)).map((s) => ({ url: s.uri, title: s.title, text: s.content }));
        const resolution = resolvePhone(m.target.name, pages, policy(), voiceConfig().listingDomains, ctx.now);
        if (resolution.status === 'resolved') {
          m.target.phone = resolution.phone;
          m.target.phoneSource = resolution.source;
          ctx.state.mandate = m;
          await ctx.record('phone.resolved', m.target.name, { phone: resolution.phone, source: resolution.source, alternatives: resolution.alternatives, blocked: resolution.blocked, pagesRead: pages.length });
          return { kind: 'next' };
        }
        await ctx.record('phone.resolution_failed', m.target.name, {
          reason: resolution.status,
          pagesRead: pages.length,
          skipped,
          blocked: resolution.blocked,
          ...(resolution.status === 'ambiguous' ? { candidates: resolution.candidates } : {}),
        });
        const question =
          resolution.status === 'ambiguous'
            ? `Encontrei mais de um número para ${m.target.name}: ${resolution.candidates.map((c) => `${c.e164} (${c.sources.map((s) => s.title ?? new URL(s.url).hostname).join(', ')})`).join('; ')}. Qual devo usar?`
            : `Não encontrei o telefone de ${m.target.name} em uma fonte confiável. Qual é o número?`;
        return { kind: 'done', output: asked('phone_unresolved', [question], m) };
      },
    },
    {
      id: 'validate',
      label: 'Conferindo o pedido e o número',
      run: async (ctx) => {
        const v = policy().validateMandate(MandateSchema.parse(ctx.state.mandate));
        await ctx.record('call.validating', 'mandate', { ok: v.ok, errors: v.ok ? [] : v.errors });
        await ctx.record('mandate.validated', 'mandate', { ok: v.ok, errors: v.ok ? [] : v.errors, ...(ctx.state.estimate ? { estimate: ctx.state.estimate } : {}) });
        if (!v.ok) throw new SkillError('INVALID_INPUT', `não posso fazer essa ligação: ${v.errors.join('; ')}`);
        ctx.state.mandate = v.mandate;

        // Did the principal already say "call"? Only then, and only when nothing else needs their eyes.
        const from = ctx.state.fromRequest as { messageId: string | null; authorizationQuote: string | null; sensitiveRequested: VoiceAction[] } | undefined;
        const reasons = policy().confirmationReasons({
          authorizationQuote: from?.authorizationQuote ?? null,
          messageId: from?.messageId ?? null,
          sensitiveRequested: from?.sensitiveRequested ?? [],
          phoneSource: v.mandate.target.phoneSource,
        });
        if (ctx.state.permission === 'always_ask') reasons.push('principal policy: always ask');
        if (reasons.length) {
          await ctx.record('mandate.confirmation_required', 'mandate', { reasons });
          ctx.state.preApproval = null;
        } else ctx.state.preApproval = { messageId: from!.messageId!, quote: from!.authorizationQuote! };
        return { kind: 'next' };
      },
    },
    {
      id: 'call',
      label: 'Ligando',
      run: async (ctx) => {
        const pre = ctx.state.preApproval as { messageId: string; quote: string } | null | undefined;
        const r = await ctx.effect('call', 'voice.call', ctx.state.mandate as Record<string, unknown>, pre ? { principalApproval: pre } : undefined);
        ctx.state.actionId = r.actionId;
        const approved = r.status === 'done' || (r.status === 'pending' && r.approved === true);
        if (approved && !ctx.state.approvedRecorded) {
          await ctx.record('mandate.approved', r.actionId, { by: ctx.state.waitedForApproval ? 'principal' : 'principal_message' });
          ctx.state.approvedRecorded = true;
        }
        if (r.status === 'pending') {
          if (!approved) {
            if (pre && !ctx.state.waitedForApproval) await ctx.record('mandate.confirmation_required', 'mandate', { reasons: ['pre-authorization not applied by the runtime (see permission.preapproval_declined)'] });
            ctx.state.waitedForApproval = true;
          }
          return { kind: 'wait_action', actionId: r.actionId };
        }
        if (r.status === 'refused') ctx.state.refused = { state: r.state, reason: r.reason };
        return { kind: 'next' };
      },
    },
    {
      id: 'result',
      label: 'Resumindo o que aconteceu',
      run: async (ctx) => {
        const m = MandateSchema.parse(ctx.state.mandate) as VoiceMandate;
        const actionId = ctx.state.actionId as string;
        const understood = summarizeMandate(m);
        const refused = ctx.state.refused as { state: string; reason: string | null } | undefined;
        if (refused) {
          const declined = refused.state !== 'FAILED';
          const result: VoiceTaskResult = {
            success: false,
            outcome: declined ? 'CANCELLED' : 'FAILED',
            summary: declined
              ? refused.reason === 'principal policy: never'
                ? 'Não liguei: nas suas permissões, ligações estão bloqueadas.'
                : 'Não liguei: a ligação não foi autorizada.'
              : /cost limit/.test(refused.reason ?? '')
                ? 'Não liguei: o limite de gasto com ligações foi atingido antes de a ligação sair.'
                : /call limit/.test(refused.reason ?? '')
                  ? 'Não liguei: o limite de ligações foi atingido antes de a ligação sair.'
                  : `Não consegui fazer a ligação: ${refused.reason ?? 'erro'}.`,
            extractedFacts: [],
            actionsTaken: [],
            nextActions: [],
            requiresUserAction: false,
            simulated: false,
          };
          return { kind: 'done', output: { status: 'not_called', questions: [], understood, notice: null, cost: null, actionId, objective: m.objective, target: m.target.name, result, transcript: [], durationSeconds: null } };
        }
        const status = (await ctx.read('voice.call_status', { actionId })) as CallStatus;
        const result = voiceResult(status);
        // The worker's classification closes the call's state machine (ENDED → outcome).
        if (status.state === 'ENDED') await ctx.record('call.outcome', actionId, { state: result.outcome as CallState, success: result.success, facts: result.extractedFacts });
        const cost = status.cost ?? null;
        return { kind: 'done', output: { status: 'called', questions: [], understood, notice: null, cost, actionId, objective: m.objective, target: m.target.name, result, transcript: status.transcript, durationSeconds: status.durationSeconds } };
      },
    },
  ],
};
