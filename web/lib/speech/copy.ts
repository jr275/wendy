/**
 * What the voice UI says, in pt-BR. Pure. Every failure is said plainly and tells the person what to do; nothing here claims the microphone works.
 */
import type { VoiceErrorCode, VoiceMachineState } from "./types";

export const CONSENT_TITLE = "Antes de usar a voz";
export const CONSENT_BODY =
  "O reconhecimento de fala do Chrome costuma enviar o áudio ao Google para transcrever. A Wendy não grava o áudio: o texto transcrito entra na conversa como se você tivesse digitado, com as mesmas regras de aprovação, e você revisa o texto antes de enviar. A resposta é lida pela voz do seu próprio navegador.";

export const ERROR_TEXT: Record<VoiceErrorCode, string> = {
  unsupported: "Este navegador não oferece reconhecimento de voz. Use o Chrome, ou escreva a mensagem.",
  permission: "O microfone está bloqueado. Libere o acesso nas configurações do site (o ícone de cadeado na barra de endereço) e tente de novo.",
  no_microphone: "Não encontrei um microfone neste computador.",
  network: "Sem conexão com o serviço de reconhecimento de voz. Tente de novo ou escreva.",
  provider: "O reconhecimento de voz falhou. Tente de novo ou escreva.",
  reply_failed: "Não consegui obter a resposta desta vez. Você pode tentar de novo ou escrever.",
  timeout: "A resposta demorou demais e eu parei de esperar. Se uma tarefa já começou, ela aparece no cartão dela.",
};

export const NOTICE_TEXT = { no_speech: "Não ouvi nada. Tente de novo.", speech_failed: "Não consegui ler a resposta em voz alta. Ela está na tela." } as const;

/** The one line shown under the composer for the current state, or null when there is nothing to say. */
export function statusLine(s: VoiceMachineState): string | null {
  if (s.kind === "ERROR" && s.error) return ERROR_TEXT[s.error.code];
  switch (s.kind) {
    case "LISTENING":
      return s.micLive ? (s.interim ? `Ouvindo… ${s.interim}` : "Ouvindo…") : "Aguardando o microfone. Se o navegador perguntar, permita o acesso.";
    case "TRANSCRIBING":
      return "Revise o texto e envie.";
    case "THINKING":
      return null; // the conversation already shows that Wendy is working
    case "SPEAKING":
      return "Falando… toque no microfone para interromper.";
    case "INTERRUPTED":
      return "Parando a fala…";
    default:
      return s.notice ? NOTICE_TEXT[s.notice] : null;
  }
}

/** The accessible name of the microphone button for the current state. */
export function micLabel(kind: VoiceMachineState["kind"]): string {
  switch (kind) {
    case "LISTENING":
      return "Parar de ouvir";
    case "SPEAKING":
      return "Interromper a fala e falar";
    case "TRANSCRIBING":
      return "Falar mais";
    case "THINKING":
    case "INTERRUPTED":
      return "Falar com a Wendy (indisponível agora)";
    default:
      return "Falar com a Wendy";
  }
}

/** The mic button can be pressed in these states; while a turn is out or speech is stopping it is not. */
export const micEnabled = (kind: VoiceMachineState["kind"]): boolean => kind !== "THINKING" && kind !== "INTERRUPTED";
