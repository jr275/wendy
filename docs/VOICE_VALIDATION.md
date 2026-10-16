# Voz — como validar o microfone real no seu Chrome

Atualizado em 15/out/2026. **Reconhecimento de fala (STT) NÃO foi validado**: ninguém falou num microfone real. O que já foi comprovado, e o que falta, está na seção 4.

> **Relato do usuário (16/out/2026):** "a parte de voz [está] funcionando, conversacional". É um **relato**, sem registro anexado: eu não vi o quadro "Registro" nem testei o microfone. Fica anotado como **validado pelo usuário**, a confirmar nos itens da seção 4 (transcrição em pt-BR, voz em pt-BR, interrupção, conversa real com o agente).

## 1. O que a Wendy faz com a voz
- A voz usa a **Web Speech API** do navegador (reconhecimento e fala), em `pt-BR`. **No Chrome, o reconhecimento costuma enviar o áudio ao Google** para transcrever; a Wendy não grava o áudio. A tela de ativação diz isso antes de abrir o microfone.
- A fala transcrita vai para o **campo de mensagem da conversa**, onde você **revisa e edita**. Só depois de você enviar ela entra na thread `main`, como se tivesse sido digitada: mesma memória, mesmas evidências, **mesmas aprovações**. A voz **não aprova nada**.
- A resposta é lida em voz alta **só quando a pergunta foi falada**, e só a resposta àquela mensagem; cartões, tabelas e código não são lidos (a Wendy diz que o resto está na tela).
- Sem microfone, sem permissão ou sem suporte: **você vê o motivo em palavras** e continua escrevendo. Nada simula sucesso.
- Abstração: `web/lib/speech/` define `SpeechRecognitionProvider`/`SpeechSynthesisProvider`. A Web Speech é só o primeiro provedor; Gemini Live entra depois atrás dos mesmos contratos, sem mexer na máquina de estados nem na interface.

## 2. Validação na bancada (sem tocar na Wendy nem em modelo)
Pré-requisito: Chrome em `localhost` (contexto seguro) e internet (o reconhecimento do Chrome usa um serviço online). Com o web no ar (`npm run dev` em `web/`, ou o app como já está), abra:

**http://localhost:3010/dev/voz**

A bancada usa os **provedores reais** e a **mesma máquina de estados**; a "resposta" é um eco rotulado como teste, então **nada é enviado à Wendy nem a um modelo**.

| Etapa | O que fazer | O que deve acontecer |
|---|---|---|
| 1 | Ler a seção "O que este navegador oferece" | reconhecimento e síntese "disponível"; "contexto seguro: true"; vozes em pt-BR listadas |
| 2 | Marcar o consentimento | (sem isso o microfone nunca abre) |
| 3 | Clicar no microfone | o Chrome pergunta pelo microfone: **Permitir**. O estado vai a `LISTENING · aguardando permissão`, e depois `LISTENING · microfone ao vivo` |
| 4 | Falar uma frase curta em português, por exemplo "quais são as minhas tarefas" | aparecem parciais; depois `TRANSCRIBING` com o texto no quadro "Texto para revisar" |
| 5 | Editar uma palavra no quadro, depois **Enviar (resposta de teste)** | `THINKING` e depois `SPEAKING`: você ouve "Resposta de teste, não é a Wendy. Você disse: …" |
| 6 | Durante a fala, clicar no microfone | a fala **para primeiro**; só então o microfone abre (barge-in) |
| 7 | Clicar em **Testar só a fala** | você ouve a voz em pt-BR (confirme que ela soa em português do Brasil) |
| 8 | Ficar 10 s sem falar depois de clicar no microfone | volta a `IDLE` com "Não ouvi nada" |
| 9 | Bloquear o microfone no cadeado da barra de endereço e clicar de novo | `ERROR`: "O microfone está bloqueado…" e **não** mostra "Ouvindo" |
| 10 | Seção "Registro" | cada passo tem hora; **copie o registro e me envie** se algo falhar |

## 3. Validação na conversa real (com o agente ligado)
Isso usa o Gemini (chamada externa, com custo) e grava no banco local; só faça se quiser.
1. Suba o agente (`npm run agent`) e abra http://localhost:3010 (no celular ou janela estreita, toque em **Abrir conversa**).
2. Toque no microfone da conversa. Na primeira vez aparece a divulgação: **Entendi, ativar a voz**.
3. Fale; o texto aparece no campo. **Revise e envie** (Enter ou "Enviar").
4. A resposta aparece na tela e é lida. Em "Configurar voz" dá para desligar a leitura, mudar volume, velocidade e voz.
5. **Verifique:** (a) a mensagem aparece na conversa como se tivesse sido digitada; (b) uma ação que pede aprovação **continua pedindo no cartão**; (c) se você digitar em vez de falar, a resposta **não** é lida em voz alta.

## 4. O que está comprovado, e o que não
**Comprovado por testes automatizados** (sem microfone, com fixtures e provedores falsos):
- `tests/unit/voiceMachine.test.ts` (32): todos os fluxos, e invariantes em 240.000 passos aleatórios (microfone nunca aberto durante a fala; um turno por vez; `submit` só em `THINKING`).
- `tests/unit/voiceSession.test.ts` (25): o gerenciador com provedores falsos e cronômetros falsos (barge-in, cancelamento, timeout, callbacks de sessão antiga ignorados).
- `tests/unit/voiceWebSpeech.test.ts` (23): os adaptadores contra um `window` falso (mapeamento de erros, ciclo de vida, falas longas em pedaços).
- `tests/unit/voiceReply.test.ts` (26): texto falado, qual resposta falar, preferências, e as frases da interface.
- Todos passaram por **mutação**: ao quebrar cada regra de propósito, os testes falham.

**Comprovado com um Chrome real, sem pessoa e sem microfone** (`node scripts/browser/check-voice.mjs`; microfone **negado** via protocolo de depuração; tudo que não é local é bloqueado):
- o botão existe, fica habilitado depois da hidratação, tem nome acessível e **44 px no celular**;
- sem consentimento o microfone nunca é tocado (aparece a divulgação); com consentimento o **reconhecedor real** é iniciado e o bloqueio vira `ERROR` com a mensagem certa, **sem** "Ouvindo…";
- apertar de novo não repete; nada é enviado por voz; digitar continua indo pelo envio normal.

**Comprovado no navegador do app** (painel do Claude, microfone bloqueado): a síntese de fala **real** (com volume 0) começou e terminou; o reconhecedor real respondeu `not-allowed`.

**NÃO comprovado, depende de você:**
- que o **reconhecimento em pt-BR** do seu Chrome transcreva bem a sua voz e o seu microfone (etapas 3 a 5);
- que a **fala soe** em português do Brasil nos seus alto-falantes (etapa 7) e a qualidade das vozes;
- o **barge-in** com som de verdade (etapa 6) e a ausência de eco/laço com os seus alto-falantes e microfone;
- o comportamento em **Safari/iOS e Firefox** (não testados);
- a conversa real de ponta a ponta por voz (seção 3).

## 5. Limites conhecidos
- O reconhecimento do Chrome depende de internet e de um serviço de terceiros; qualidade e disponibilidade não são garantidas.
- A síntese do navegador pode cortar falas longas (por isso o texto é falado em pedaços) e o Chrome às vezes trava a fila de fala; a Wendy cancela antes de cada fala para evitar sobreposição.
- Uma frase falada **não** conta como aprovação de uma ação: você revisa o texto antes de enviar, e as aprovações continuam nos cartões.
- Voz em tempo real (Gemini Live) **não está implementada**; só a interface comum existe para recebê-la.
