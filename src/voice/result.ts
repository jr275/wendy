/**
 * Call status (from the stored events) and the worker's result (from transcript + Wendy's in-call
 * decisions). The transcript records what happened; the result is Wendy's reading of it. Nothing
 * here claims success without a confirmation heard on the call.
 */
import { foldCallState, isTerminalCall, type CallState } from './stateMachine.js';
import type { CounterpartySignal, TranscriptTurn, VoiceTaskResult } from './types.js';

export interface StoredCallEvent {
  type: string;
  data: Record<string, unknown>;
  at: Date;
}

export interface CallStatus {
  state: CallState;
  terminal: boolean;
  simulated: boolean;
  provider: string | null;
  transcript: TranscriptTurn[];
  signals: CounterpartySignal[];
  actionsRequired: { action: string; detail: string; decision: string }[];
  ended: { by: string; reason: string } | null;
  failed: string | null;
  connectedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  /** Estimated cost once the call is over (set by voice.call_status from the policy's rate). */
  cost?: { amount: number; currency: string; estimated: true; billedMinutes: number } | null;
}

export function callStatus(events: StoredCallEvent[]): CallStatus {
  // A call exists only after its mandate was validated (voice.call re-checks it before dialing).
  const state = foldCallState(events.map((e) => ({ type: e.type, data: e.data })), 'VALIDATING');
  const at = (t: string) => (events.find((e) => e.type === t)?.data.at as string | undefined) ?? null;
  const endedEv = events.find((e) => e.type === 'call.ended' || e.type === 'call.failed');
  const connectedAt = at('call.connected');
  const endedAt = (endedEv?.data.at as string | undefined) ?? null;
  return {
    state,
    terminal: isTerminalCall(state),
    simulated: events.some((e) => e.data.simulated === true),
    provider: (events[0]?.data.provider as string | undefined) ?? null,
    transcript: events.filter((e) => e.type === 'call.transcript').map((e) => ({ speaker: e.data.speaker as TranscriptTurn['speaker'], text: String(e.data.text), at: String(e.data.at) })),
    signals: events.filter((e) => e.type === 'call.transcript').flatMap((e) => (e.data.signals as CounterpartySignal[] | undefined) ?? []),
    actionsRequired: events.filter((e) => e.type === 'call.action_required').map((e) => ({ action: String(e.data.action), detail: String(e.data.detail), decision: String(e.data.decision) })),
    ended: events.find((e) => e.type === 'call.ended') ? { by: String(events.find((e) => e.type === 'call.ended')!.data.by), reason: String(events.find((e) => e.type === 'call.ended')!.data.reason) } : null,
    failed: (events.find((e) => e.type === 'call.failed')?.data.reason as string | undefined) ?? null,
    connectedAt,
    endedAt,
    durationSeconds: connectedAt && endedAt ? Math.round((Date.parse(endedAt) - Date.parse(connectedAt)) / 1000) : null,
  };
}

/** pt-BR words for parameter keys and protected categories in the principal-facing summaries. */
const KEY_PT: Record<string, string> = { date: 'dia', time: 'horário', party_size: 'pessoas', partySize: 'pessoas', guests: 'hóspedes', check_in: 'entrada', check_out: 'saída' };
const INFO_PT: Record<string, string> = { password: 'senha', auth_code: 'código de acesso', payment_card: 'cartão', bank_account: 'conta bancária', document_id: 'documento', credentials: 'credenciais', security_answer: 'resposta de segurança', private_data: 'informações pessoais' };
const show = (o: Record<string, string | number>) =>
  Object.entries(o)
    .filter(([k]) => k !== 'status')
    .map(([k, v]) => `${KEY_PT[k] ?? k}: ${v}`)
    .join(' · ');

/** The worker's classification of a finished call (Phase 3: from structured signals; Phase 4 adds model extraction). */
export function voiceResult(s: CallStatus): VoiceTaskResult {
  const base = { simulated: s.simulated, actionsTaken: [] as string[], extractedFacts: [] as VoiceTaskResult['extractedFacts'], nextActions: [] as string[] };
  const prefix = s.simulated ? '(Simulação — nenhuma ligação real.) ' : '';
  if (s.failed === 'no_answer') return { ...base, success: false, outcome: 'NO_ANSWER', summary: `${prefix}Ninguém atendeu.`, requiresUserAction: false };
  if (s.failed === 'busy') return { ...base, success: false, outcome: 'BUSY', summary: `${prefix}A linha estava ocupada.`, requiresUserAction: false };
  if (s.failed === 'voicemail') return { ...base, success: false, outcome: 'VOICEMAIL', summary: `${prefix}A chamada caiu na caixa postal.`, requiresUserAction: false };
  if (s.failed) return { ...base, success: false, outcome: 'FAILED', summary: `${prefix}Não consegui completar a ligação.`, requiresUserAction: false };
  if (s.ended?.reason === 'cancelled') return { ...base, success: false, outcome: 'CANCELLED', summary: `${prefix}A ligação foi encerrada a seu pedido.`, requiresUserAction: false };
  if (s.ended?.reason === 'duration_limit') return { ...base, success: false, outcome: 'FAILED', summary: `${prefix}Encerrei a ligação porque passou do tempo máximo, sem concluir.`, requiresUserAction: false };

  const forbidden = s.actionsRequired.find((a) => a.decision === 'forbidden');
  if (forbidden)
    return {
      ...base,
      success: false,
      outcome: 'POLICY_VIOLATION',
      summary: `${prefix}Encerrei a ligação: pediram uma informação que eu nunca forneço (${INFO_PT[forbidden.detail] ?? forbidden.detail}). Pode ser tentativa de golpe.`,
      actionsTaken: ['recusou fornecer informação protegida', 'encerrou a ligação'],
      requiresUserAction: true,
      nextActions: ['Verificar o contato por um canal oficial antes de tentar de novo.'],
    };
  const confirm = s.actionsRequired.find((a) => a.decision === 'requires_confirmation');
  if (confirm)
    return {
      ...base,
      success: false,
      outcome: 'REQUIRES_CONFIRMATION',
      summary: `${prefix}Não concluí: para seguir, cobram ${confirm.detail}, e isso precisa da sua autorização.`,
      extractedFacts: [{ key: 'cobrança', value: confirm.detail }],
      actionsTaken: ['não aceitou a cobrança', 'disse que retornaria'],
      requiresUserAction: true,
      nextActions: [`Autorizar ${confirm.detail} e eu ligo de novo para confirmar.`],
    };
  const confirmed = [...s.signals].reverse().find((x): x is Extract<CounterpartySignal, { kind: 'confirmed' }> => x.kind === 'confirmed');
  if (confirmed)
    return {
      ...base,
      success: true,
      outcome: 'COMPLETED',
      summary: `${prefix}Resolvido: confirmado (${show(confirmed.facts)}).`,
      extractedFacts: Object.entries(confirmed.facts).map(([key, value]) => ({ key, value: String(value) })),
      actionsTaken: ['pediu e obteve confirmação'],
      requiresUserAction: false,
    };
  const alt = s.signals.find((x): x is Extract<CounterpartySignal, { kind: 'alternative' }> => x.kind === 'alternative');
  if (alt)
    return {
      ...base,
      success: false,
      outcome: 'PARTIAL_SUCCESS',
      summary: `${prefix}Não deu como você pediu, mas ofereceram uma alternativa: ${show(alt.offer)}. Não aceitei sem você.`,
      extractedFacts: Object.entries(alt.offer).map(([key, value]) => ({ key: `alternativa.${key}`, value: String(value) })),
      actionsTaken: ['perguntou disponibilidade', 'anotou a alternativa'],
      requiresUserAction: true,
      nextActions: [`Quer que eu aceite ${show(alt.offer)}?`],
    };
  if (s.signals.some((x) => x.kind === 'available'))
    return { ...base, success: true, outcome: 'COMPLETED', summary: `${prefix}Confirmado que há disponibilidade.`, extractedFacts: [{ key: 'disponibilidade', value: 'sim' }], actionsTaken: ['perguntou disponibilidade'], requiresUserAction: false };
  return { ...base, success: false, outcome: 'FAILED', summary: `${prefix}A ligação terminou sem resposta para o que você pediu.`, requiresUserAction: false };
}
