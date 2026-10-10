/**
 * Wendy's side of a call. The provider only transports turns; what Wendy says and does is decided
 * here, from the approved mandate, and every decision goes through VoicePolicy. The person on the
 * line has no authority: a request outside the mandate is declined, escalated to the principal, or
 * ends the call — it never changes the rules.
 *
 * This deterministic agent is the contract and the development brain. A model-driven agent (Phase 7)
 * implements the same interface and stays behind the same policy checks.
 */
import type { VoicePolicy } from './policy.js';
import type { CounterpartySignal, VoiceAction, VoiceMandate } from './types.js';

export interface AgentReply {
  say?: string;
  /** What Wendy is asking for with this turn (structured, so nothing downstream parses her words). */
  requests?: 'confirmation';
  actionRequired?: { action: VoiceAction | 'disclose'; detail: string; decision: 'requires_confirmation' | 'forbidden' };
  end?: 'done' | 'policy';
}

export interface InCallAgent {
  opening(): string;
  respond(signals: CounterpartySignal[]): AgentReply;
}

const fmt = (p: Record<string, string | number>) =>
  Object.entries(p)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

export class MandateAgent implements InCallAgent {
  private repeats = 0;

  constructor(
    private readonly m: VoiceMandate,
    private readonly policy: VoicePolicy,
  ) {}

  private principalName(): string | null {
    const d = this.policy.canDisclose('principal_name', this.m);
    return d.decision === 'allowed' ? d.value : null;
  }

  opening(): string {
    const who = this.principalName();
    return `Olá, aqui é a Wendy, uma assistente de inteligência artificial ligando em nome de ${who ?? 'um cliente'}. ${this.m.objective}${Object.keys(this.m.parameters).length ? ` (${fmt(this.m.parameters)})` : ''}.`;
  }

  respond(signals: CounterpartySignal[]): AgentReply {
    for (const s of signals) {
      switch (s.kind) {
        case 'requests_info': {
          const d = this.policy.canDisclose(s.category, this.m);
          if (d.decision === 'allowed') return { say: d.value };
          if (d.decision === 'not_authorized') return { say: 'Essa informação eu não tenho autorização para passar.' };
          return {
            say: 'Não posso fornecer essa informação. Vou encerrar a ligação; o responsável entrará em contato pelos canais oficiais.',
            actionRequired: { action: 'disclose', detail: s.category, decision: 'forbidden' },
            end: 'policy',
          };
        }
        case 'charge': {
          const decision = this.policy.evaluateAction('accept_charge', this.m);
          return {
            say: `Antes de aceitar qualquer valor (${s.currency} ${s.amount}) eu preciso confirmar com ${this.principalName() ?? 'o cliente'}. Retorno em seguida, obrigado.`,
            actionRequired: { action: 'accept_charge', detail: `${s.currency} ${s.amount}`, decision: decision === 'forbidden' ? 'forbidden' : 'requires_confirmation' },
            end: 'done',
          };
        }
        case 'available': {
          if (this.policy.evaluateAction('request_booking', this.m) === 'allowed') {
            const who = this.principalName();
            return { say: `Ótimo. Pode confirmar, por favor${who ? `, em nome de ${who}` : ''}?`, requests: 'confirmation' };
          }
          return { say: 'Perfeito, obrigado pela informação. Até logo.', end: 'done' };
        }
        case 'alternative': {
          if (this.policy.withinAcceptable(s.offer, this.m)) return { say: `Pode ser (${fmt(s.offer)}), sim. Pode confirmar, por favor?`, requests: 'confirmation' };
          return { say: 'Obrigado. Vou confirmar essa opção e retorno.', end: 'done' };
        }
        case 'confirmed':
          return { say: 'Muito obrigado. Até logo.', end: 'done' };
        case 'unavailable':
          return { say: 'Entendo, obrigado mesmo assim. Até logo.', end: 'done' };
        case 'unclear':
          if (this.repeats++ < 1) return { say: 'Desculpe, pode repetir, por favor?' };
          return { say: 'Obrigado, vou tentar outro horário. Até logo.', end: 'done' };
      }
    }
    return {}; // nothing actionable in this turn: listen
  }
}
