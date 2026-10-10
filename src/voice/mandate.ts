/**
 * Natural language → VoiceMandate.
 *
 * The model reads ONLY the principal's request (never web pages or transcripts) and proposes a
 * draft, quoting the words each value comes from. CODE builds the mandate:
 *   - a value without a verbatim quote from the request is dropped (it becomes a question);
 *   - what is authorized is decided here, by level, never by the model's wording;
 *   - money, contracts, cancellations and account changes are never authorized — a stated budget is
 *     recorded as a constraint and still comes back to the principal;
 *   - disclosures come from the principal's record (the name), never from the model;
 *   - an incomplete request becomes clarifying questions instead of guesses.
 */
import { z } from 'zod';
import { quoteInSource } from '../cognition/validator.js';
import { hashOf } from '../util/hash.js';
import { extractBrazilianPhones } from './phone.js';
import { BINDING, FINANCIAL, type VoicePolicy } from './policy.js';
import { CONFIRMATION_TRIGGERS, VOICE_ACTIONS, type VoiceAction, type VoiceMandate } from './types.js';

const quoted = z.string().describe('copied verbatim from the request');

export const MandateDraftSchema = z.object({
  objective: z.string().describe("Short objective in the principal's language, e.g. 'Reservar uma mesa'"),
  level: z.enum(['consult', 'execute']).describe('consult = only ask/check; execute = also book/join a list within the stated limits'),
  target: z.object({ name: z.string().nullable(), name_quote: quoted.nullable(), location_hint: z.string().nullable(), phone: z.string().nullable(), phone_quote: quoted.nullable() }),
  requested_actions: z.array(z.object({ action: z.enum(VOICE_ACTIONS), quote: quoted })),
  parameters: z.array(z.object({ key: z.string().describe('date (YYYY-MM-DD), time (HH:MM), party_size, check_in, check_out, guests, room_type, …'), value: z.string(), quote: quoted })),
  acceptable_time: z.object({ from: z.string(), to: z.string(), quote: quoted }).nullable(),
  max_extra_cost: z.object({ amount: z.number(), currency: z.string(), quote: quoted }).nullable(),
  call_authorization_quote: quoted.nullable().describe('words where the principal explicitly tells Wendy to call (e.g. "pode ligar agora"), else null'),
  missing: z.array(z.object({ field: z.string(), question: z.string() })),
});
export type MandateDraft = z.infer<typeof MandateDraftSchema>;

/** Actions a mandate may authorize on its own (within limits). */
const SAFE: readonly VoiceAction[] = ['ask', 'request_booking', 'join_waitlist', 'negotiate'];

export type MandateBuild =
  | { status: 'needs_information'; questions: string[]; partial: Partial<VoiceMandate> }
  | {
      status: 'complete';
      /** Phone may still be empty: resolution comes next. */
      mandate: VoiceMandate;
      locationHint: string | null;
      /** Sensitive things the principal mentioned: they stay with the principal, at the moment. */
      sensitiveRequested: VoiceAction[];
      /** Verbatim words authorizing the call, if the principal gave them. */
      authorizationQuote: string | null;
      dropped: string[];
    };

const NUMBER_REASON_PT: Record<string, string> = {
  'not an E.164 number': 'formato inválido',
  'country not allowed': 'país não permitido',
  'emergency number': 'é um número de emergência',
  'short or malformed national number': 'número incompleto',
  'premium or blocked service number': 'é um número de serviço pago ou bloqueado',
};

const isTime = (t: string) => /^\d{2}:\d{2}$/.test(t);
const num = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : v.trim());

export function mandateKey(principalId: string, m: Pick<VoiceMandate, 'objective' | 'target' | 'parameters'>, requestedOn: Date): string {
  const params = Object.fromEntries(Object.entries(m.parameters).sort(([a], [b]) => a.localeCompare(b)));
  return `voice:${hashOf({ principalId, objective: m.objective.trim().toLowerCase(), target: m.target.name.trim().toLowerCase(), params, day: requestedOn.toISOString().slice(0, 10) }).slice(0, 32)}`;
}

export function buildMandate(
  draft: MandateDraft,
  ctx: { principalId: string; principalName: string; request: string; messageId?: string; now: Date; policy: VoicePolicy; language: string },
): MandateBuild {
  const grounded = (q: string | null | undefined) => !!q && quoteInSource(q, ctx.request);
  const dropped: string[] = [];
  const questions = new Map<string, string>();

  const targetName = draft.target.name && grounded(draft.target.name_quote) ? draft.target.name.trim() : null;
  if (!targetName) questions.set('target', 'Para quem devo ligar (nome do lugar ou da pessoa)?');

  const parameters: Record<string, string | number> = {};
  for (const p of draft.parameters) {
    const key = p.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!grounded(p.quote) || !p.value.trim()) {
      dropped.push(`parameter ${key}`);
      continue;
    }
    if (key === 'time' && !isTime(p.value.trim())) {
      dropped.push('parameter time (not HH:MM)');
      continue;
    }
    parameters[key] = num(p.value);
  }

  const groundedActions = draft.requested_actions.filter((a) => grounded(a.quote)).map((a) => a.action);
  const sensitiveRequested = [...new Set(groundedActions.filter((a) => FINANCIAL.includes(a) || BINDING.includes(a)))];
  const authorized = new Set<VoiceAction>(['ask']);
  if (draft.level === 'execute') for (const a of groundedActions) if (SAFE.includes(a)) authorized.add(a);

  let acceptable: VoiceMandate['acceptable'];
  if (draft.acceptable_time && grounded(draft.acceptable_time.quote) && isTime(draft.acceptable_time.from) && isTime(draft.acceptable_time.to) && draft.level === 'execute') {
    acceptable = { time: { from: draft.acceptable_time.from, to: draft.acceptable_time.to } };
    authorized.add('accept_alternative');
  } else if (draft.acceptable_time) dropped.push('acceptable time (not quoted or not a booking)');

  const constraints: VoiceMandate['constraints'] = draft.max_extra_cost && grounded(draft.max_extra_cost.quote) ? { maxExtraCost: { amount: draft.max_extra_cost.amount, currency: draft.max_extra_cost.currency.toUpperCase().slice(0, 3) } } : undefined;

  // Booking or a waitlist needs at least "when" and "how many"; never guessed.
  if (authorized.has('request_booking') || authorized.has('join_waitlist')) {
    if (!('date' in parameters) && !('check_in' in parameters)) questions.set('when', 'Para que dia (e horário)?');
    if (!('party_size' in parameters) && !('guests' in parameters)) questions.set('how_many', 'Para quantas pessoas?');
  }
  for (const m of draft.missing) if (!questions.has(m.field)) questions.set(m.field, m.question);

  let phone = '';
  let phoneSource: VoiceMandate['target']['phoneSource'] = { kind: 'principal' };
  if (draft.target.phone && grounded(draft.target.phone_quote)) {
    // National formats ("(21) 2508-9174") are read the same way as on web pages; E.164 is kept as given.
    const raw = draft.target.phone.trim();
    const national = raw.startsWith('+') ? [] : extractBrazilianPhones(raw);
    const n = ctx.policy.canCall(national.length === 1 ? national[0]! : raw, { kind: 'principal' });
    if (n.ok) phone = n.e164;
    else questions.set('phone', `O número informado não pode ser usado (${NUMBER_REASON_PT[n.reason] ?? n.reason}). Qual é o número correto?`);
  }
  if (!phone) phoneSource = { kind: 'web_page' };

  const disclosures = authorized.has('request_booking') || authorized.has('join_waitlist') ? [{ category: 'principal_name', value: ctx.principalName }] : [];
  const partial: Partial<VoiceMandate> = { objective: draft.objective, parameters, authorizedActions: [...authorized], acceptable, constraints };
  if (questions.size) return { status: 'needs_information', questions: [...questions.values()], partial };

  const mandate: VoiceMandate = {
    objective: draft.objective.trim(),
    language: ctx.language,
    target: { name: targetName!, phone, phoneSource },
    parameters,
    authorizedActions: [...authorized],
    forbiddenActions: [...FINANCIAL, ...BINDING],
    ...(acceptable ? { acceptable } : {}),
    disclosures,
    limits: ctx.policy.limits,
    ...(constraints ? { constraints } : {}),
    confirmationRequired: [...CONFIRMATION_TRIGGERS],
    userContext: { request: ctx.request, ...(ctx.messageId ? { messageId: ctx.messageId } : {}) },
  };
  mandate.idempotencyKey = mandateKey(ctx.principalId, mandate, ctx.now);
  return { status: 'complete', mandate, locationHint: draft.target.location_hint, sensitiveRequested, authorizationQuote: grounded(draft.call_authorization_quote) ? draft.call_authorization_quote : null, dropped };
}

const PARAM_PT: Record<string, string> = { date: 'dia', time: 'horário', party_size: 'pessoas', guests: 'hóspedes', check_in: 'entrada', check_out: 'saída', room_type: 'quarto' };
const ACTION_PT: Partial<Record<VoiceAction, string>> = { ask: 'perguntar', request_booking: 'pedir a reserva', join_waitlist: 'entrar na lista de espera', negotiate: 'negociar', accept_alternative: 'aceitar a alternativa combinada' };

/** What Wendy understood, in a few lines the principal approves. Built by code from the mandate. */
export function summarizeMandate(m: VoiceMandate): string[] {
  const params = Object.entries(m.parameters).map(([k, v]) => `${PARAM_PT[k] ?? k}: ${v}`);
  const src = m.target.phoneSource;
  const where = src.kind === 'principal' ? 'número que você informou' : `fonte: ${src.title ?? src.ref ?? 'web'}${src.confidence ? `, confiança ${src.confidence === 'high' ? 'alta' : src.confidence === 'medium' ? 'média' : 'baixa'}` : ''}`;
  const lines = [
    `Ligar para ${m.target.name}${m.target.phone ? ` (${m.target.phone}, ${where})` : ''}.`,
    `Objetivo: ${m.objective}${params.length ? ` — ${params.join(', ')}` : ''}.`,
    `Posso: ${m.authorizedActions.map((a) => ACTION_PT[a] ?? a).join(', ')}.`,
    m.acceptable?.time ? `Aceito outro horário só entre ${m.acceptable.time.from} e ${m.acceptable.time.to}.` : 'Não aceito outro horário ou data sem falar com você.',
    m.constraints?.maxExtraCost
      ? `Você citou até ${m.constraints.maxExtraCost.currency} ${m.constraints.maxExtraCost.amount} de custo extra: mesmo assim, qualquer cobrança eu confirmo com você antes.`
      : 'Não aceito cobranças extras, pagamentos ou cancelamentos.',
    m.disclosures.length ? `Só informo: ${m.disclosures.map((d) => (d.category === 'principal_name' ? `seu nome (${d.value})` : d.category)).join(', ')}.` : 'Não informo nenhum dado seu.',
  ];
  return lines;
}
