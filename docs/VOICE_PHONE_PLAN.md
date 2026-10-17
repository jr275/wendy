# Wendy liga por telefone — plano e o que falta (16/out/2026)

Estado: **nada disto liga para ninguém hoje.** O contrato, a política e a simulação existem em `src/voice/`; falta o provedor real (a "Fase 7"). Este documento registra o que foi **confirmado** na documentação do provedor, o que **não** foi, e a ordem segura de entrega. Ele não autoriza nenhuma ligação, compra ou envio.

## 1. O que já existe (código)
- `src/voice/mandate.ts`: o pedido vira um **mandato** (objetivo, ações autorizadas, o que pode ser dito, limites). Dinheiro, contrato, cancelamento e mudança de conta **nunca** são autorizados sozinhos.
- `src/voice/policy.ts`, `phone.ts`: números de emergência, premium e estrangeiros bloqueados; telefone lido de página vira candidato com evidência; ambíguo = pergunta a você.
- `src/voice/agent.ts` (`InCallAgent`): decide cada fala, sempre atrás da política. A pessoa do outro lado não tem autoridade.
- `src/voice/mock.ts`: simulação, **rotulada como simulada**. `src/voice/provider.ts`: `VOICE_PROVIDER=mock` é a única opção; sem ela, falha por escrito.

## 2. O que falta e por que não foi escrito ainda
Um `VoiceProvider` real (`createCall`, `getCall`, `endCall`, `findCall`). Só se escreve contra uma API que se **conhece**. Da documentação da Vapi, lida em 16/out/2026:

**Confirmado**
- `POST https://api.vapi.ai/call`, `Authorization: Bearer <chave>`; corpo com `phoneNumberId`, `customer.number` (E.164) e `assistant` (com `model`, `firstMessage`, `maxDurationSeconds` — padrão 600 —, `metadata`).
- Eventos para o nosso servidor (`POST {message:{type,call,…}}`): `status-update` (`scheduled`, `queued`, `ringing`, `in-progress`, `forwarding`, `ended`), `transcript`, `end-of-call-report` (`endedReason`, `artifact.messages[{role,message}]`).
- A Vapi pode chamar um **LLM nosso** (`/chat/completions`) em vez do dela, autenticada por chave estática ou OAuth2.

**NÃO confirmado — resolver com a chave, num teste, antes de escrever o adaptador**
1. **Idempotência**: não há chave de idempotência documentada. Sem ela, uma tentativa repetida poderia discar duas vezes. A defesa é nossa: gravar a intenção e o `idempotencyKey` **antes** de chamar, e `findCall` consultar esse registro e o `metadata` da chamada. Isso pede uma tabela nova (migration, só com a sua aprovação) ou reaproveitar o log de eventos da execução da skill.
2. O campo exato da URL do LLM próprio, o corpo que a Vapi envia a ele e o formato da resposta (JSON ou SSE).
3. Como a **nossa** resposta encerra a chamada.
4. Como os avisos da Vapi são **autenticados** (segredo, cabeçalho). Sem isso, qualquer um poderia forjar "chamada terminou".
5. A lista de `endedReason` e como ela vira `no_answer`, `busy`, `voicemail`, `invalid_number`, `provider_error`.
6. Qualidade da voz e do reconhecimento em **português do Brasil**, e a disponibilidade de **número brasileiro** (pode exigir documentos). Twilio: só liga de número brasileiro próprio, não 0800 (https://www.twilio.com/guidelines/br/voice).

## 3. Arquitetura (decisão a confirmar)
Provedor pronto (Vapi, Retell ou Telnyx) com **LLM próprio apontando para a Wendy**: cada fala do outro lado passa por `InCallAgent` e pela política. A IA do provedor não decide sozinha o que prometer. O provedor precisa alcançar a Wendy pela internet → **depende do servidor (VPS)**. Num Mac atrás do roteador, só com túnel, e não é para produção.

## 4. Ordem segura
1. VPS no ar (`deploy/`, ver `docs/DEPLOY.md`). Estado do kit: sintaxe dos 4 scripts válida, caminhos dos Dockerfiles existem, `.dockerignore` protege segredos. **Imagens nunca foram construídas** (não há Docker neste Mac): o primeiro `docker compose build` é o teste de verdade.
2. Você escolhe o provedor, cria a conta, envia documentos se pedirem, compra o número e define o **teto de gasto**. A chave de API entra por arquivo local de permissão 600 (como `~/.wendy/brapi-token`), **nunca no chat**.
3. Teste em sandbox dos itens 1–5 da seção 2; só então o adaptador, com testes contra respostas gravadas.
4. **Primeira ligação: para o seu próprio celular**, com você ouvindo. Nenhum terceiro.
5. Só depois, ligações a terceiros, com as regras abaixo.

## 5. Regras que valem desde a primeira ligação a terceiros
- A Wendy **se identifica como assistente de inteligência artificial** na abertura (já é o texto de `MandateAgent.opening`).
- Cada ligação a terceiro continua exigindo o seu **sim** no cartão de aprovação, salvo a pré-autorização por pedido explícito já prevista em `VOICE_PREAUTHORIZE_FROM_REQUEST` (desligue se preferir sempre perguntar).
- Limites já existentes: duração máxima, ligações por tarefa e por dia, custo por ligação, dia e mês. Os valores de custo são **placeholders** até haver tabela de preços real; o custo é sempre uma **estimativa**, rotulada.
- Gravação e transcrição de uma pessoa que não consentiu envolvem LGPD: decidir antes se grava áudio (padrão: **não**) e por quanto tempo guarda a transcrição.
- Nada de pagamento, contrato, cancelamento ou mudança de conta por telefone, em nenhuma circunstância.
