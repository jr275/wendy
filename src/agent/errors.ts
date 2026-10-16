import { ReasoningUnavailableError, redactSecrets } from '../cognition/resilience.js';

/**
 * What a failed run looks like to the principal and to the log.
 *  - The principal gets a short pt-BR sentence that says what to do, never the raw provider error
 *    (those carry request details).
 *  - The log gets the error's name and message only: library errors (e.g. a failed Google token
 *    refresh) embed the whole request, including credentials, and must never be dumped.
 */
export function friendlyRunError(e: unknown): string {
  // A model failure that the client classified (cognition/resilience.ts) is told by its cause, not guessed from text.
  if (e instanceof ReasoningUnavailableError && e.kind !== 'unknown') {
    switch (e.kind) {
      case 'transient':
        return `O modelo está indisponível ou sobrecarregado agora${e.attempts > 1 ? ` (tentei ${e.attempts} vezes)` : ''}. Sua mensagem ficou na conversa; tente de novo em instantes.`;
      case 'refusal':
        return 'O modelo recusou este pedido. Reformule ou peça de outro jeito.';
      case 'invalid_output':
        return 'O modelo devolveu uma resposta que não consegui validar. Tente de novo.';
      case 'auth':
        break; // the existing authentication messages below say what to do
    }
  }
  const text = `${(e as Error)?.name ?? ''} ${(e as Error)?.message ?? String(e)}`;
  if (/invalid_grant|invalid_rapt|reauth/i.test(text)) return 'A autenticação do Google (usada pelo Gemini) expirou. No terminal, rode `gcloud auth application-default login` e tente de novo.';
  if (/RESOURCE_EXHAUSTED|\b429\b|quota/i.test(text)) return 'O modelo atingiu o limite de uso agora. Tente de novo em alguns minutos.';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network/i.test(text)) return 'Não consegui falar com o modelo (problema de rede). Tente de novo em instantes.';
  return 'A Wendy não conseguiu responder por um erro interno. O detalhe está no log do agente.';
}

/** Safe to log: name and message, clipped, with anything that looks like a token or secret masked. */
export function loggableError(e: unknown): string {
  return redactSecrets(`${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}`).slice(0, 400);
}
