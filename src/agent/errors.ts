/**
 * What a failed run looks like to the principal and to the log.
 *  - The principal gets a short pt-BR sentence that says what to do, never the raw provider error
 *    (those carry request details).
 *  - The log gets the error's name and message only: library errors (e.g. a failed Google token
 *    refresh) embed the whole request, including credentials, and must never be dumped.
 */
export function friendlyRunError(e: unknown): string {
  const text = `${(e as Error)?.name ?? ''} ${(e as Error)?.message ?? String(e)}`;
  if (/invalid_grant|invalid_rapt|reauth/i.test(text)) return 'A autenticação do Google (usada pelo Gemini) expirou. No terminal, rode `gcloud auth application-default login` e tente de novo.';
  if (/RESOURCE_EXHAUSTED|\b429\b|quota/i.test(text)) return 'O modelo atingiu o limite de uso agora. Tente de novo em alguns minutos.';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network/i.test(text)) return 'Não consegui falar com o modelo (problema de rede). Tente de novo em instantes.';
  return 'A Wendy não conseguiu responder por um erro interno. O detalhe está no log do agente.';
}

/** Safe to log: name and message, clipped, with anything that looks like a token or secret masked. */
export function loggableError(e: unknown): string {
  const raw = `${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}`;
  return raw
    .replace(/(refresh_token|access_token|client_secret|api[_-]?key|authorization|bearer)(["'\s:=]+)[^\s"',}]+/gi, '$1$2<redacted>')
    .replace(/\b1\/\/[A-Za-z0-9_-]{20,}/g, '<redacted>')
    .slice(0, 400);
}
