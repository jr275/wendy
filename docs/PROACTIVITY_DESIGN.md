# Wendy — desenho do fluxo de proatividade

Status: **proposta**, escrita em 10/10/2026 a partir da leitura do código. Nada aqui está implementado, exceto onde marcado **existe**. Nenhuma etapa exige criar um cron job "para demonstrar": primeiro o fluxo, depois a infraestrutura.

Regra de honestidade deste documento: cada afirmação de "existe" aponta para código. O que não existe está marcado **não existe** ou **decisão sua**.

---

## 1. O fluxo completo

```
 Fonte autorizada ──▶ Evento ──▶ Validação ──▶ Relevância ──▶ Política ──▶ Entrega ──▶ Registro
 (Gmail, Calendário,   (dedupe)    (evidência    (limiar +      (permissões,  (onde e   (ledger
  Search Console,                    obrigatória)  preferências)  silêncio)     quando)    auditável)
  detectores)
```

### 1.1 Evento e deduplicação — **existe**
- `events` tem `UNIQUE (principal_id, source, source_event_key)` ([001_cognitive_core.sql](../src/db/migrations/001_cognitive_core.sql)). Reingerir o mesmo fato não cria um segundo evento.
- Os detectores já montam chaves estáveis: aniversário por `person + data`, compromisso por `commitment + vencimento`, Search Console por janela ([detectors.ts](../src/cognition/detectors.ts)). Mensagens e reuniões entram pelo sincronizador do Google.
- **Lacuna:** a chave impede o *mesmo* evento, mas não controla **lembrar de novo** (D-3, D-1, D-0 são chaves diferentes e todos podem aparecer) nem eventos parecidos de fontes diferentes.

### 1.2 Validação — **existe**
- Entender → reunir evidência → raciocinar → validar ([pipeline.ts](../src/cognition/pipeline.ts), [validator.ts](../src/cognition/validator.ts)). Uma afirmação sem evidência real é rejeitada; um evento sem base vira `SKIPPED`.
- Nada proativo deve pular esta etapa: **sugestão sem evidência não existe**.

### 1.3 Relevância — **existe em parte**
- Pontuação determinística por fatores explicáveis contra `SURFACE_THRESHOLD` ([salience.ts](../src/cognition/salience.ts)). Abaixo do limiar: o insight é **registrado, sem interromper** (`SUPPRESSED`).
- O fator *novelty* já penaliza repetir assunto/pessoa.
- **Não existe:** preferência por categoria, limite diário, horário de silêncio, "dispensar" ou "lembrar depois", e nenhum aprendizado a partir do que você ignora.

### 1.4 Política de autorização — **existe para ações; não existe para o aviso em si**
- O motor de permissões decide por código, nunca por modelo: `READ` roda; `WRITE` segue o padrão da ferramenta; `EXTERNAL`, `DESTRUCTIVE` e `PAYMENT` **sempre** pedem aprovação e nunca viram automáticos; `DENY` do usuário vence tudo; silêncio nunca é aprovação ([policy.ts](../src/permissions/policy.ts)).
- Uma sugestão que traz uma ação continua passando por esse motor, sem exceção.
- **Decisão sua (D1):** *avisar você mesmo* num canal externo (WhatsApp, e-mail) é uma ação `EXTERNAL`? Recomendo **sim**: tratar como externa e deixar você liberar **por canal**, uma vez, com possibilidade de revogar. Avisar dentro do app não sai da Wendy e não exige isso.

### 1.4.1 Regra de ouro para canais
Aprovar ação **com efeito externo** (enviar e-mail, ligar, pagar) **só dentro do app**, nunca por mensagem de WhatsApp/Telegram, pelo menos na primeira versão. Pelo canal: ver, adiar, dispensar e abrir o app no item certo. Motivo: a aprovação precisa continuar presa à ação específica, com identidade forte e sem reaproveitamento.

### 1.5 Entrega — **existe só dentro do app**
Hoje a sugestão aparece quando você abre a Wendy: "Agora" e "O que a Wendy encontrou". Não existe notificação fora da tela, nem canal externo, nem fila de entrega.

| Nível | O que é | Exige |
|---|---|---|
| L0 | Dentro do app ao abrir (**existe**) | nada |
| L1 | Resumo do dia a partir dos insights já registrados "sem interromper" | só leitura do que existe (**sem infraestrutura**) |
| L2 | Notificação do navegador/desktop | permissão do navegador; para tela fechada, um serviço de push (chaves próprias e hospedagem) |
| L3 | WhatsApp / Telegram | conta e token (segredos), endpoint acessível pela internet, vínculo número ↔ usuário, consentimento, política de guarda |

### 1.6 Registro — **existe**
Ledger encadeado por hash para eventos, insights e ações ([ledger.ts](../src/audit/ledger.ts)); o ciclo falha fechado se o ledger estiver adulterado. **Falta** registrar a *entrega*: cada aviso enviado, adiado ou suprimido deve ganhar uma entrada com o motivo (`NOTIFICATION_DELIVERED`, `_DEFERRED`, `_SUPPRESSED`).

---

## 2. Cenários do briefing: o que já tem detector

| Cenário | Detector hoje | Situação |
|---|---|---|
| Aniversários e datas | `PERSON_DATE_APPROACHING` | **existe** |
| Compromissos assumidos que vencem | `COMMITMENT_DUE` | **existe** |
| Mensagens que precisam de resposta | fator `reply_pressure` na relevância | **parcial**: pontua, não gera aviso próprio |
| Mudança em site (Search Console) | `SEARCH_PERFORMANCE_CHANGE` | **existe** (só Remax, pelo escopo) |
| Contas e vencimentos em fontes autorizadas | — | **não existe**: exigiria um detector sobre o Gmail |
| Reservas/eventos que mudaram | — | **não existe**: exigiria comparar versões do Calendário |
| Tarefas interrompidas | runs `failed`/`cancelled` | **parcial**: o estado existe, não vira aviso |
| Acompanhamentos pedidos por você | compromissos `OPEN` com data | **existe como compromisso**; não há agendamento recorrente |

Nenhum cenário novo deve ser criado sem **evidência de fonte real** e um teste com dados reais de fixture.

---

## 3. Controles do usuário (o que precisa existir antes de qualquer aviso fora da tela)

1. **Categoria:** ligar/desligar por tipo (datas, compromissos, mensagens, sites, tarefas).
2. **Frequência:** teto diário de interrupções (padrão proposto: 3); o excedente vai para o resumo.
3. **Silêncio:** janela de horários; o aviso é **adiado**, nunca descartado.
4. **Canal:** por categoria, em qual canal pode chegar (padrão: só no app).
5. **Feedback em um toque:** *Dispensar*, *Lembrar depois*, *Não era útil*. Alimenta a novidade/relevância; não aprende em silêncio (cada ajuste é visível e reversível).

**Decisão sua (D2) — onde guardar as preferências:** *arquivo pessoal* (como o escopo do Search Console: simples, reversível, sem migration) ou *tabela no banco* (editável pela tela, vale para vários dispositivos, exige migration). Recomendo tabela para feedback e preferências, porque precisam ser editadas pela interface.

---

## 4. Regras contra ruído e pressão artificial
- **Um aviso por assunto e ocorrência.** Só volta se algo material mudou (ex.: um compromisso passou do prazo), no máximo 2 lembretes por item.
- **Sem urgência inventada:** a palavra "urgente" e contagens regressivas só aparecem quando a urgência vem de um prazo real registrado.
- **Sem culpa:** nada de "você esqueceu". Descrever o fato e a próxima ação.
- **Sem evidência, sem aviso:** o cartão sempre mostra origem e o motivo gravado (já implementado na anatomia da sugestão).
- **Rótulo de natureza:** *Sugestão*, *Feito*, *Informação*, *Parado*, para nunca confundir intenção com execução.

---

## 5. Persistência e "trabalhar sem a janela aberta"
- **Existe:** tarefas guardam cursor e trava no banco e retomam após reinício; o agente avança tarefas prontas por timer; o worker roda Gmail, Calendário e Search Console em ciclos ([workerCli.ts](../src/runtime/workerCli.ts)).
- **Limite real:** tudo isso só roda **enquanto os processos estiverem de pé no seu Mac**. Se o Mac dormir ou reiniciar, nada acontece, e o Postgres já caiu por trava velha mais de uma vez.
- **Agendamento:** o gatilho `schedule` existe só como tipo declarado ([types.ts](../src/skills/types.ts)). Não há cron, nem fila, nem webhook.
- **Decisão sua (D3) — onde a Wendy roda:** manter no Mac (proatividade só com o Mac ligado) ou hospedar agente + banco em um lugar sempre ligado. Qualquer canal externo (L3) **depende** disso, porque precisa receber webhooks.

---

## 6. Multicanal: requisitos antes de qualquer integração
Nada abaixo está implementado.
- **Identidade:** vincular o número/conta do canal ao seu usuário por um passo de confirmação feito dentro do app (código de uso único), nunca por "quem escreveu primeiro".
- **Consentimento:** por canal, revogável, registrado no ledger.
- **Histórico:** uma só conversa de verdade (`chat_messages`), com a **origem do canal** em cada mensagem. Não criar um segundo armazenamento.
- **Isolamento:** o conteúdo recuperado para responder num canal segue o que você autorizou para esse canal (dados sensíveis, como saúde, não saem por canal externo por padrão).
- **Segurança:** tokens fora do repositório e fora de logs; validação de assinatura do webhook; limite de taxa.
- **Estado das tarefas:** consultar sempre o mesmo registro (`skill_executions`); o canal só apresenta.

---

## 7. Como medir (hoje não há dados de uso: tudo abaixo é hipótese até medir)
| Pergunta | Métrica | Como coletar |
|---|---|---|
| A sugestão foi útil? | % agindo (abrir, aprovar) vs % dispensando | eventos de feedback (D2) |
| Há ruído? | avisos por dia; % "não era útil" | idem + ledger de entrega |
| Há alarme falso? | sugestões dispensadas como "não era útil" por categoria | feedback |
| O silêncio funciona? | avisos entregues dentro da janela de silêncio (alvo: 0) | ledger de entrega |
| Repetição? | avisos do mesmo item por ocorrência (alvo ≤ 2) | ledger |

---

## 8. Plano incremental (cada passo funciona sozinho)

| Passo | Entrega | Infra / autorização |
|---|---|---|
| **A** | **Resumo do dia**: lista dos insights já registrados "sem interromper", com a mesma anatomia (origem, motivo, ação) | **nenhuma**; só leitura do que existe |
| B | Feedback em um toque nos cartões (dispensar / lembrar depois / não era útil) | tabela nova → **migration com sua autorização** (D2) |
| C | Preferências por categoria, teto diário e silêncio, na tela | mesma tabela (D2) |
| D | Registro de entrega no ledger (entregue / adiado / suprimido, com motivo) | usa o ledger existente; sem migration |
| E | Detector de contas/vencimentos (Gmail) e de mudança em reservas (Calendário) | fixtures reais, revisão sua dos exemplos; sem canal novo |
| F | Notificação do navegador (L2) | permissão do navegador; push com tela fechada exige hospedagem (D3) |
| G | Canais externos (L3), com as regras de §1.4.1 e §6 | contas, tokens, hospedagem sempre ligada, consentimento (D1, D3) |

**Recomendação:** começar pelo **passo A**. É o único que não depende de nenhuma decisão sua nem de infraestrutura, e transforma o "N outros registrados sem interromper" (hoje um número morto) em algo consultável.

---

## 9. Decisões que dependem de você
- **D1.** Avisar você mesmo por canal externo conta como ação externa (sempre pede liberação)? *Recomendo sim.*
- **D2.** Preferências e feedback em tabela (com migration) ou em arquivo pessoal?
- **D3.** A Wendy continua só no seu Mac ou passa a rodar num lugar sempre ligado?
- **D4.** Padrões: teto diário de interrupções (proposto 3) e janela de silêncio (proposto 22h às 8h).
- **D5.** Qual canal externo importa primeiro, se algum.
