# WENDY — PHASE 1 COMPLETION REPORT

**Data:** 2026-10-05 · **Branch:** `wendy/phase-1-cognitive-core` · **Commits:** `6ffc8f9` (checkpoint) → `a5bea48` (Fase 0.5) → `3caad41` (Fase 1)

---

## EXECUTIVE SUMMARY

O Cognitive Core foi construído em TypeScript sobre PostgreSQL e está completo. Ele já executa o loop inteiro: evento, entendimento, entidades, contexto, raciocínio, validação, salience, insight, ação, execução, verificação e persistência. O Claude é o único caminho de raciocínio, e o código decide o que é fato, o que é aceito e o que é executado.

**O que está provado:** toda a parte determinística, com 81 testes passando em Postgres real e schemas isolados. Isso cobre persistência, idempotência, concorrência, eventos derivados de estado, contexto obsoleto, validação de evidências, salience explicável, máquina de estados, aprovação, execução única, recuperação após crash e ledger fail-closed. O teste estático anti-hardcode prova que `src/` não contém nenhum nome, e-mail, empresa, reunião ou tópico dos cenários.

**O que NÃO está provado:** a qualidade cognitiva com o Claude real. A suíte live tem 11 testes e está escrita, mas não rodou com sucesso. A única chave de API disponível pertence a uma conta **sem créditos** (`credit balance is too low`). A tentativa falhou de forma honesta: nenhum insight foi inventado, e o evento ficou com o erro registrado e backoff aplicado. Enquanto esses testes não passarem, não há prova de que a Wendy entende, conecta e antecipa. O teste anti-hardcode comportamental (cenário B, com outra pessoa, outro tópico e outra reunião) também é live, então também não está provado.

**Veredito:** NOT READY FOR PHASE 2 (detalhes em REMAINING BLOCKERS).

---

## REAL NOW

Tudo nesta lista é verificado por testes determinísticos que passam.

- Persistência em PostgreSQL de entidades, relações, mensagens, reuniões, compromissos, eventos, memórias, insights, claims, ações, versões, transições, execuções, artefatos, `model_calls` e ledger. Tudo sobrevive a restart (testado com pool novo).
- Ingestão idempotente pela chave `(principal, source, source_event_key)`: um evento duplicado nunca é reprocessado.
- Eventos derivados de estado:
  - aniversário = pessoa + data de nascimento + relógio + fuso do executivo;
  - compromisso = compromisso + prazo + status + relógio.
- O payload desses eventos contém só referências e valores calculados por código. Não contém conclusões.
- Detecção de contexto obsoleto: se o compromisso foi concluído ou o aniversário mudou entre a detecção e o processamento, o evento vira SKIPPED sem chamar o modelo.
- Resolução de entidades determinística e conservadora: identificador de e-mail, depois nome completo exato, depois tokens únicos. Nome ambíguo é reportado como ambíguo e não é adivinhado.
- Recuperação de contexto: histórico com a pessoa, busca full-text por termos, reuniões ±janela, compromissos abertos, memórias da pessoa, preferências do executivo e insights recentes. Cada item recebe um handle verificável.
- Validador de evidências: ver EVIDENCE / PROVENANCE.
- Salience com 9 fatores nomeados, cada um com valor, base e contribuição. A explicação em pt-BR é gerada por código.
- Ações com máquina de estados imposta sob lock de linha, política de aprovação por nível de impacto, versões de conteúdo (Wendy / executivo), expiração e rejeição persistida que vira memória OUTCOME.
- Execução exatamente uma vez por ação, com chave de idempotência entregue ao provider, verificação por leitura de volta e reconciliação após crash sem reenvio cego.
- Ledger encadeado por hash com âncora de cabeça. Detecta 12 tipos de adulteração, e executor e worker param (fail closed).
- Isolamento entre executivos: o mesmo endereço de e-mail é desconhecido para outro principal.
- Concorrência: dois workers simultâneos processam cada evento exatamente uma vez (`SKIP LOCKED`).
- Integração com o Claude escrita conforme o SDK oficial, com structured outputs, `claude-opus-5-5`, thinking adaptativo e fallback server-side em caso de recusa. Cada chamada fica registrada com a entrada, as referências de evidência enviadas, a saída e o `api_message_id`. Recusa ou saída inválida fazem o evento falhar em vez de gerar algo.

## PARTIAL

- **Raciocínio do Claude (entendimento, interpretação, antecipação, recomendação, redação):** o código está completo e tipado, mas **não foi validado ao vivo** por falta de créditos.
- **Anti-hardcode comportamental:** o teste estático passa; o metamórfico com o cenário B é live e está pendente.
- **Memória:** PREFERENCE e FACT persistem e são recuperadas por pessoa e por busca textual. A escrita a partir de notas depende do Claude (pendente). Não há embeddings nem supersessão automática de memórias contraditórias. Contradições são apenas *apresentadas*.
- **Aprendizado:** decisões do executivo (aprovou, editou, rejeitou) viram memórias OUTCOME que entram no contexto futuro. Pesos e limiar de salience não se ajustam com o tempo.
- **Busca:** full-text com o dicionário `simple`, sem stemming. Depende dos termos e variantes que o Claude sugere. pgvector fica para quando houver necessidade real.
- **Pessoas inventadas em texto livre:** o validador checa toda pessoa *referenciada por handle*. Um nome inventado escrito dentro da frase de uma claim não é detectado mecanicamente.
- **Compromissos:** só existem quando criados por fixture ou API. A extração de compromissos a partir de e-mails não está implementada.

## SIMULATED

- **`DEV_LOCAL_MAILBOX`** é o único provider de e-mail. Ele grava numa tabela local e **não entrega para ninguém**. Está rotulado em todo lugar (`deliversExternally: false`, texto "local, não entregue externamente" no insight, e o motivo da transição para EXECUTED).
- **Fixtures** (`fixtures/world.ts`) são mundos de teste parametrizados, todos com `source = 'DEV_FIXTURE'`. Ficam fora de `src/` de propósito.
- **Test double** (`tests/helpers/scriptedReasoner.ts`) é usado apenas nos testes de *mecânica*. Suas chamadas são registradas como modelo `TEST_DOUBLE` e nenhum teste o usa para provar cognição.
- **UI legada** (`legacy/`) está congelada, não está conectada ao core e não tem raciocínio (camadas `NOT_IMPLEMENTED`).

## REMOVED

Na Fase 0.5:
- Código morto: `memoryStore`, `seedData`, `auditLedger`, `attentionFilter`, os tipos JS, os stubs de providers, o `publishEvent` e os helpers AG-UI não usados.
- Recibo SMTP fabricado, estado `VERIFIED` falso e memória "e-mail enviado" sem envio.
- Textos prontos por palavra-chave ("Clause 4", "3% volume rebate", "Thursday board"), o salience por lista de palavras e o dossier de 4 quadrantes fixo.
- Conteúdo estático falso da UI: dossier, primeiro turno da Wendy, cards de Mariana e Carlos, hash de proveniência falso e relógio fixo.
- A ação pré-escrita semeada nas fixtures.
- Testes tautológicos; os testes legados não escrevem mais em `data/`, e `data/` não é mais versionado.

## COGNITIVE CORE

```text
EVENT (persistido, idempotente)
 → FOCO a partir do estado ATUAL (+ checagem de obsolescência)      [código]
 → ENTENDIMENTO: pessoas, tópicos, termos, pedidos, prazos, urgência [Claude] → citações verificadas [código]
 → RESOLUÇÃO DE ENTIDADES                                            [código]
 → RECUPERAÇÃO DE CONTEXTO (memória, relação, histórico, reuniões, compromissos, insights) → handles [código]
 → RACIOCÍNIO: inferências, hipóteses, antecipações, recomendações, ações, memórias [Claude]
 → VALIDAÇÃO DE EVIDÊNCIAS                                           [código]
 → SALIENCE (9 fatores, explicável)                                  [código]
 → INSIGHT (SURFACED / SUPPRESSED / REJECTED_BY_VALIDATION)          [código]
 → AÇÃO (política) → EXECUÇÃO → VERIFICAÇÃO                          [código]
 → PERSISTÊNCIA numa transação + AUDITORIA                           [código]
```

Arquivos principais: `src/cognition/pipeline.ts`, `context.ts`, `validator.ts`, `salience.ts`, `detectors.ts`, `entityResolution.ts`, `ask.ts`, `render.ts` e `src/runtime/worker.ts` (o ciclo contínuo).

## MEMORY

- Tabela `memories` com os tipos PREFERENCE, FACT, EPISODE e OUTCOME, pessoa de referência, confiança, status, evidência (`[{kind,id}]`), autor (PRINCIPAL / WENDY / SYSTEM) e índice full-text.
- **Escrita:** só por proposta do Claude com evidência validada, por decisão do executivo (OUTCOME) ou direto pelo executivo. Toda escrita da Wendy é auditada (`MEMORY_WRITTEN`).
- **Leitura:** entra no contexto de todo evento e de toda pergunta sobre a pessoa. Os handles enviados ao Claude ficam registrados em `model_calls.input_evidence_refs`, o que torna verificável que o Claude recebeu aquela memória.
- **Teste exigido** (persistir → reiniciar → perguntar → verificar que o Claude recebeu e usou): escrito como teste live e **pendente** de créditos.

## EVENT SYSTEM

- Envelope com todos os campos pedidos: `event_id, event_type, source, source_event_key, occurred_at, received_at, actor, entity_refs, payload, payload_hash, confidence, provenance, correlation_id, permissions` e status de processamento.
- **Persistível e rastreável:** o `correlation_id` vai para o insight, e o insight referencia o evento.
- **Idempotente:** chave natural única.
- **Reprocessável:** um evento que falhou volta para PENDING com backoff (tentativas × 1 min) e vira FAILED após 5 tentativas. Leases vencidos podem ser retomados.
- **Concorrência segura** com `FOR UPDATE SKIP LOCKED`.
- **Tipos:** `EMAIL_RECEIVED`, `COMMITMENT_DUE`, `PERSON_DATE_APPROACHING`, `PRINCIPAL_NOTE` e `PRINCIPAL_QUESTION`.

## CLAUDE INTEGRATION

- `@anthropic-ai/sdk` 0.131, `client.beta.messages.parse` com schemas Zod, `claude-opus-5-5` (o mesmo modelo em todas as chamadas, sem rebaixamento), thinking adaptativo e effort por etapa (understand `medium`, reason `high`).
- Fallback server-side em caso de recusa (`fallbacks: "default"`). O modelo que de fato respondeu fica registrado em `served_by_model`.
- System prompts estáveis com cache. Os prompts não mencionam nenhum cenário (o scan prova isso).
- Recusa, `max_tokens` ou saída inválida lançam `ReasoningUnavailableError`, e o evento é reprocessado. Nada é inventado para preencher a lacuna.
- **Status:** a integração está escrita e o formato da requisição foi aceito pela API (o erro foi de cobrança, não de validação da requisição). **Nenhuma resposta real do modelo foi obtida.**

## EVIDENCE / PROVENANCE

- Os FATOS são gerados **por código** a partir dos registros citados. O schema do Claude nem permite o tipo FACT.
- Toda claim do Claude é verificada:
  - o handle de evidência existe;
  - INFERENCE cita evidência;
  - HYPOTHESIS e ANTICIPATION citam evidência ou claims anteriores;
  - RECOMMENDATION deriva de claims anteriores;
  - não há referência para frente nem a claim rejeitada (a rejeição se propaga em cascata);
  - toda "pessoa" é registro de pessoa;
  - a confiança é numérica.
- **Timestamp impossível:** um registro passado datado depois de "agora", ou uma data resolvida fora de [−1 dia, +2 anos] do evento, é rejeitado.
- Citações de urgência e de entendimento precisam estar **literalmente** no texto da fonte.
- Ações para pessoa desconhecida, sem e-mail, ligada a reunião CANCELLED ou sem justificativa válida são rejeitadas.
- Memórias propostas sem evidência ou com assunto inexistente são rejeitadas.
- A narrativa que cita claim rejeitada é descartada, e o insight mostra só as claims válidas.
- Dentro da transação de persistência, todo registro citado é conferido de novo no banco. Se algo sumiu, `StaleContextError` e o evento é reprocessado.
- A cadeia RECOMMENDATION → INFERENCE → FACT → FONTE fica em `claims.derived_from` e `claims.evidence`.

## SALIENCE

Fatores: importance (definida pelo executivo), urgency (expressa no texto, com citação verificada), relationship_relevance (volume e recência de interações), business_impact (avaliação validada com evidência), novelty (insights recentes sobre as mesmas pessoas), confidence (claims válidas, penalizada por conflito), time_sensitivity (prazo mais próximo entre reunião, compromisso, data ou prazo citado), actionability (ações validadas) e executive_preference (memórias de preferência aplicáveis).

- Um fator que não se aplica é **excluído**, e os pesos são renormalizados, em vez de ser preenchido com chute.
- Os pesos são constantes de política em `config.ts` e **ainda não foram calibrados** com dados reais.
- Explicação "Isso apareceu porque…": a pontuação, o limiar e os 4 maiores fatores com suas bases.

## ANTICIPATION

- **Observação:** os fatos, produzidos por código.
- **Interpretação:** INFERENCE.
- **Antecipação:** ANTICIPATION / HYPOTHESIS.
- **Recomendação:** RECOMMENDATION.

Cada nível é um registro separado com sua base. O "o que preparei" e o "o que precisa de aprovação" do insight vêm do **estado real das ações no banco**; o Claude não consegue declarar uma ação feita. Os eventos proativos (compromisso, aniversário) nascem do estado, sem pergunta do usuário. **A qualidade da antecipação está pendente** dos testes live.

## ACTIONS

`PROPOSED → STAGED → AWAITING_APPROVAL → APPROVED → EXECUTING → EXECUTED → VERIFIED`, com os estados terminais REJECTED, FAILED, CANCELLED e EXPIRED. Transições ilegais lançam erro.

| Tipo | Nível | Política |
|---|---|---|
| `PREPARE_BRIEFING` | 1, interno | AUTO: executa e verifica um artefato no banco |
| `SEND_EMAIL` | 3, externo | Sempre exige aprovação explícita |

- A edição do executivo cria uma versão nova (autor PRINCIPAL), e essa versão é a executada.
- A expiração é calculada pela reunião, pelo prazo ou pela data.

## IDEMPOTENCY

- **Eventos:** chave natural única.
- **Insights:** `UNIQUE(event_id)`.
- **Execuções:** `UNIQUE(action_id)` + `UNIQUE(idempotency_key)`, com chave estável `wendy-action:<id>` entregue ao provider.

Testado:
- duas aprovações simultâneas geram 1 aprovação e 1 execução;
- reexecuções e restart não geram envio novo;
- crash depois de o provider aceitar é reconciliado pela chave, sem reenvio;
- falha do provider antes de aceitar leva a um retry seguro, com exatamente 1 envio;
- divergência na leitura de volta leva a FAILED, nunca a VERIFIED.

## AUDIT

`audit_blocks` + `audit_head`. O hash SHA-256 é calculado sobre o JSON canônico de **todos** os campos. O bloco de auditoria é gravado na mesma transação da mudança de estado.

`verifyLedgerIntegrity()` detecta (testado): payload, actor e event_type alterados; hash alterado; prev_hash alterado; remoção no meio; bloco duplicado; reordenação; truncamento; truncamento com cabeça forjada; cabeça ausente; ledger esvaziado.

Há fail closed no executor, no worker (o loop para) e no append (recusa gravar se a ponta divergir da cabeça). Escritas concorrentes são serializadas (20 em paralelo resultam numa cadeia válida).

## SECURITY

- Escopo por `principal_id` em todas as tabelas e consultas. Ações de outro principal são recusadas.
- Segredos em `.env` (gitignored) e `data/` fora do git.
- A UI legada usa `Content-Type` JSON obrigatório (anti-CSRF simples) e escapa HTML.
- **Não existe autenticação nem API HTTP para o core.** Hoje a aprovação só acontece via código e testes, e isso é necessário antes de conectar qualquer interface.
- A cabeça do ledger fica no mesmo banco: quem tiver escrita total no banco pode reescrever a cadeia inteira. Falta ancoragem externa.
- **Atenção:** uma credencial da Anthropic foi colada no chat desta sessão. Ela não foi gravada em lugar nenhum por mim. Recomendo revogá-la e gerar outra antes de usar.

## TEST RESULTS

| Suíte | Resultado |
|---|---|
| `npm test` (determinísticos, Postgres real, schemas isolados) | **81 / 81 passando** |
| `npm run legacy:test` | **28 / 28 passando** |
| `npm run typecheck` | limpo |
| `npm run test:live` (Claude real) | **0 / 11 passando.** Bloqueado: a conta da API está sem créditos. A execução tentada falhou com o erro de cobrança, sem gerar insight. |

Cobertura funcional pedida: memory retrieval (determinístico ✓, live pendente), event processing ✓, entity resolution ✓, context retrieval ✓, cognitive reasoning (pendente), anticipation (pendente), salience ✓, evidence validation ✓, actions ✓, approvals ✓, idempotency ✓, audit ✓.

## ADVERSARIAL TEST RESULTS

| Cenário | Teste | Status |
|---|---|---|
| Pessoa desconhecida | live `unknown person, unknown topic`; determinístico de isolamento entre principals | determinístico ✓ / live pendente |
| Tópico desconhecido | live `unknown person, unknown topic` | pendente |
| Evento duplicado | ingestão + pipeline (nenhuma chamada nova ao modelo) | ✓ |
| Ação duplicada | aprovação concorrente; reexecução após restart | ✓ |
| Restart durante ação | crash depois do aceite → reconciliação | ✓ |
| Ledger corrompido | 12 adulterações + executor fail closed | ✓ |
| Evidência ausente ou inventada | validador + pipeline `REJECTED_BY_VALIDATION` | ✓ |
| Contexto obsoleto | compromisso concluído após a detecção → SKIPPED; recheck na transação | ✓ |
| Evidência conflitante | live `conflicting evidence is surfaced` | pendente |
| Nomes de fixture trocados | scan estático ✓; live cenário B | estático ✓ / live pendente |
| Tópicos de fixture trocados | scan estático ✓; live cenário B | estático ✓ / live pendente |
| Contexto insuficiente | live `polite ack → SUPPRESSED` | pendente |
| Modelo indisponível | backoff → FAILED após 5 tentativas, sem insight | ✓ |
| Execução concorrente de workers | dois `runCycle` em paralelo | ✓ |

## ARCHITECTURE

```text
src/
  config.ts            modelos, pesos de salience, limiar
  db/                  pool, transações, migrations (001_cognitive_core.sql)
  domain/types.ts
  repositories/        interfaces + implementação Postgres
  events/              ingestão idempotente; escrita do mundo (pessoas, mensagens, reuniões, compromissos)
  providers/           interfaces (Email/Calendar/Contacts/Drive) + DevMailbox (dev)
  cognition/           pipeline, context, validator, salience, detectors, entityResolution, ask, render, prompts, schemas, llm
  actions/             máquina de estados + política + executor
  audit/ledger.ts
  runtime/             contexto, worker (ciclo contínuo), CLI do worker
fixtures/world.ts      mundos DEV parametrizados (fora de src/)
scripts/demo.ts        o "primeiro wow" com Claude real
tests/unit             81 testes determinísticos
tests/live             11 testes com Claude real
legacy/                protótipo congelado
```

Uma única Wendy, sem agentes. Skills, AG-UI e presença ficam para fases futuras.

## REMAINING BLOCKERS

1. **Créditos da API Anthropic.** Coloque em `.env` uma chave de conta com créditos e rode:
   - `npm run test:live`: os 11 testes precisam passar, principalmente o cenário A, o **anti-hardcode B**, a memória após restart e o compromisso/aniversário.
   - `npm run demo` (e `npm run demo -- b`): o primeiro "Encontrei algo que acho que você deveria saber", gerado pelo sistema.
2. Depois de rodar os testes live, ajustar o que eles revelarem (por exemplo, calibrar o limiar de salience ou os prompts) **sem** introduzir nada específico de cenário. O scan estático continua de guarda.
3. **Antes de conectar qualquer UI:** autenticação e uma API mínima para listar insights e aprovar ou rejeitar ações.

## NEXT PHASE

Depois de o bloqueio 1 ser resolvido e a suíte live ficar verde, a Fase 2 (Persistent Memory + Context) deve trazer:
- supersessão e resolução de memórias contraditórias, com o executivo no circuito;
- métricas de relação derivadas de interações ao longo do tempo;
- extração de compromissos a partir de e-mails;
- pgvector para recuperação semântica (quando a busca full-text mostrar limites medidos);
- calibração dos pesos de salience com o feedback das decisões (memórias OUTCOME).

---

# PHASE 1 REALITY GATE — 2026-10-05

## Resultado da verificação da credencial

**Não há `ANTHROPIC_API_KEY` válida configurada para o projeto Wendy. O gate foi interrompido, conforme a instrução.**

- A variável não está definida no ambiente do processo.
- O `.env` do projeto continha apenas a linha copiada do projeto whitehabbit no início da sessão. A data de modificação do arquivo bate com o momento da cópia, então ele não foi alterado desde então. Pela regra deste gate, essa chave não pode ser reutilizada, e ela também está sem créditos.
- Por isso a linha foi **removida** do `.env`. O arquivo agora contém só um placeholder comentado. O valor não foi lido nem exibido.
- Nada foi simulado. O Claude não foi substituído por mock ou fallback. Não houve refactor, migração, UI, integração nem funcionalidade nova.
- `npm run test:live` foi executado e recusou rodar sem a chave: o arquivo falhou e nenhum dos 11 testes foi executado. **Nenhum teste live foi aprovado.**
- `npm run demo` **não foi executado**: sem chave, ele apenas falharia na primeira chamada ao Claude.
- Os 81 testes determinísticos (que não dependem do Claude) foram re-executados agora: **81/81 passando**.

## Resultado por teste

| Teste | Status | Base |
|---|---|---|
| **CLAUDE REAL TEST** | **BLOCKED** | Sem chave válida. Nenhuma resposta real do modelo foi obtida. |
| **COGNITIVE LOOP TEST** (Carlos / pricing, itens 1–14) | **BLOCKED** | Os itens 2, 6, 7, 8 e 9 exigem o Claude real. A parte mecânica do loop (resolução, recuperação, validação, salience, política, persistência) passa com um test double rotulado, o que **não** conta como prova cognitiva. |
| **ANTI-HARDCODE TEST** | **BLOCKED** | O scan estático passa (nenhum nome, e-mail, empresa, reunião ou tópico em `src/`; nenhum keyword matching na camada de cognição). O teste comportamental com outra pessoa, assunto, reunião, contexto e idioma é live e está bloqueado. |
| **MEMORY TEST** (persistir → reiniciar → recuperar → perguntar → enviar ao Claude) | **BLOCKED** | Depende do Claude para escrever a preferência a partir da nota e para responder. |
| **DERIVED EVENT TEST** — derivação | **PASS** | Aniversário e compromisso são derivados do estado salvo mais o relógio, de forma idempotente. O payload contém só referências e datas calculadas (sem `birthday=tomorrow`), e nada é detectado quando o estado não justifica. |
| **DERIVED EVENT TEST** — insight a partir do evento derivado | **BLOCKED** | Interpretação e rascunho exigem o Claude. |
| **PERSISTENCE TEST** | **BLOCKED** | O gate exige processar o evento com o Claude real e depois reiniciar. A versão determinística passa (pool novo enxerga insight, ações, estado de aprovação, memória, evento e proveniência, com ledger válido), mas o evento foi processado pelo test double. |
| **ADVERSARIAL TEST** — partes sem modelo | **PASS** | Evento duplicado; evidência inexistente rejeitada (validador e pipeline); contexto obsoleto vira SKIPPED sem chamar o modelo; isolamento entre principals; modelo indisponível leva a FAILED sem inventar nada; concorrência de workers. |
| **ADVERSARIAL TEST** — partes com modelo | **BLOCKED** | Pessoa desconhecida, assunto desconhecido, contexto insuficiente, evidência conflitante. |
| **ACTION SAFETY TEST** | **PASS** | Aprovação dupla concorrente gera 1 execução; reexecução e restart não reenviam; crash depois do aceite é reconciliado sem duplicar; ação aguardando aprovação não tem execução; a política exige aprovação para e-mail; divergência na leitura de volta vira FAILED e nunca VERIFIED; ledger adulterado deixa a ação em APPROVED sem envio. |
| **AUDIT TEST** | **PASS** | 12 tipos de adulteração detectados com fail closed; append recusado com a ponta divergente; rollback junto com a transação; 20 escritas concorrentes resultam numa cadeia válida. |

**Resumo:** PASS = 4 (derivação de eventos, adversarial sem modelo, segurança de ações, auditoria) · BLOCKED = 8 · FAIL = 0.
Nenhum teste que depende do Claude foi executado. A pergunta central deste gate (*a Wendy entende, conecta, antecipa e persiste?*) **continua sem resposta**.

## Para desbloquear

1. Configure no projeto Wendy (no `.env` ou no ambiente) uma `ANTHROPIC_API_KEY` própria, de uma conta com créditos.
2. Rode `npm run test:live`, depois `npm run demo` e `npm run demo -- b`.
3. Este relatório será atualizado com o resultado real de cada teste. Se algum teste live falhar, o status será FAIL.

## Atualização do gate — 2026-10-06

**A credencial foi resolvida. O bloqueio restante é de saldo.**

| Item | Situação |
|---|---|
| `ANTHROPIC_API_KEY` | Chave própria do projeto Wendy, gravada no `.env` a partir da área de transferência (valor nunca exibido). Não é nenhuma das chaves coladas no chat. |
| Escopo de workspace | A primeira chave não tinha workspace (`400 … must include the anthropic-workspace-id header`). Correção mínima em `src/cognition/llm.ts`: quando `ANTHROPIC_WORKSPACE_ID` existe, o cliente envia o header `anthropic-workspace-id` via `defaultHeaders`; sem a variável, o comportamento é idêntico ao anterior. A chave atual já tem workspace próprio e não precisa da variável. **Alteração ainda não commitada**, por instrução. |
| Autenticação | A API aceita a chave. Organização `a9312976-1885-48fc-a429-b5618524db65`, workspace `wrkspc_016KhYUkYRZAGAjUKfG4xT2P`. |
| Saldo | **Bloqueado**: `400 Your credit balance is too low to access the Anthropic API`. O mesmo erro bloqueia a contagem de tokens, por isso o custo por rodada ainda não foi medido. |
| `npm run test:live` | 1 / 11 passa, só o teste de integridade do ledger, que não chama o Claude. Os 10 testes cognitivos falham no erro de saldo e nenhuma resposta do Claude foi obtida. |
| Testes determinísticos | 81 / 81 e legado 28 / 28, re-executados depois da correção do header. Typecheck limpo. |

O status de cada teste do gate **não muda**: os testes dependentes do Claude continuam **BLOCKED**.

**Próximo passo:** adicionar créditos de API à organização `a9312976-…` (Console → Settings → Billing → Credit balance > 0) e rodar `npm run test:live` e `npm run demo`.

## Atualização — 2026-10-06 (interface e verificações)

- **Saldo da API:** verificado de novo, ainda `credit balance is too low` (organização `a9312976-…`). Os testes que dependem do Claude continuam **BLOCKED**.
- **Interface "Menlo / Remax AI Platform"** sobre o inspetor, só leitura. Telas: Hoje (torre de controle), Insight (revisar proposta, explicar, mostrar lógica), Aprovações, Atividade, Ontologia, Pessoas e memória, Integrações, Auditoria. Temas claro e escuro. Aceitar e Modificar ficam **desativados** até existir a API de aprovação com autenticação.
- **Garantias novas testadas:**
  - a conexão do inspetor é rejeitada pelo Postgres em qualquer escrita;
  - os números da tela batem com o estado persistido;
  - os rótulos de evidência vêm dos registros reais;
  - o grafo da ontologia só contém registros e ligações existentes.
- **Testes determinísticos:** 85/85 (eram 81).
- Os dados da interface ainda são do **substituto de teste**, e a interface avisa isso em todas as telas.

## Atenção para quem ler o resultado do gate — mudanças no núcleo antes de ele rodar

Com autorização do executivo, a parte determinística da Fase 2 foi feita **em paralelo** ao gate. Quando `npm run gate` rodar, ele vai medir o núcleo **com estas mudanças**:

- **Memórias deduzidas** de e-mails entram como **PROPOSED** e só chegam ao raciocínio depois de confirmadas. Notas ditadas pelo executivo continuam entrando direto. Nenhum teste live da Fase 1 depende de memória deduzida de e-mail.
- **Evidência da pessoa** inclui métricas derivadas das interações: volume em 30 e 90 dias, tempo de resposta, tendência, reuniões e mensagens sem resposta.
- **Busca** ignora acentos e reduz palavras à raiz em português e inglês (migração 004). Isso traz mais registros relacionados para o contexto.
- **Prioridade:**
  - `relationship_relevance` agora usa mensagens e reuniões derivadas.
  - Fator novo `reply_pressure`, que só se aplica quando o executivo deve uma resposta. Fora isso fica "não se aplica" e não altera a pontuação.
  - A importância definida pelo executivo continua intacta.
- **Memórias** chegam ao Claude com a idade e o peso (meia-vida por tipo, desde a última confirmação). Nenhuma memória é filtrada por idade.
- **Compromissos PROPOSED** existem como estado, mas nada os cria ainda (a extração depende do Claude). Eles são excluídos da busca e dos detectores.

Se um teste live falhar, considerar estas mudanças antes de concluir que o núcleo da Fase 1 regrediu.

---

## Mudança de regra para o MVP — 2026-10-07 (decisão do executivo)

O Claude ficou indisponível pelos dois caminhos:
- **API da Anthropic:** sem saldo (`credit balance is too low`).
- **Google Cloud Vertex AI:** o projeto `gen-lang-client-0623035444` ("revizia333") tem o Claude Opus 5.5 ativado, mas o Google **negou automaticamente** a cota do Opus, inclusive o pedido mínimo de 5 pedidos/min.

Por decisão explícita do executivo ("não é produção, é MVP"):

- **Gemini liberado só para desenvolvimento.** A Wendy pode raciocinar com o **Gemini** (`gemini-3.1-pro-preview`, via Vertex, mesmo projeto) para o desenvolvimento do MVP (`WENDY_REASONER=gemini`).
- **Sempre identificado.** Cada chamada é registrada com o nome do modelo Gemini, e a interface mostra "não é o Claude" em cada insight, na auditoria e nos avisos.
- **O gate não muda.** Ele continua exigindo o **Claude real**: o `npm run gate` e os testes live usam sempre o cliente do Claude, nunca o Gemini. Este relatório continua **NOT READY FOR PHASE 2** até o gate rodar com o Claude.
- **Primeiro resultado com o Gemini (demo, cenário A):**
  - O ciclo completo funcionou: entendimento, contexto conectado (reunião, histórico, compromisso), antecipação, recomendação, briefing e rascunho aguardando aprovação.
  - Saída sempre no formato exigido.
  - **Defeito observado:** resolveu "tomorrow's meeting" como um prazo de 2h atrás, quando a reunião é daqui a 26h. Isso inflou o fator de prazo da prioridade. Fica para comparar com o Claude.

---

NOT READY FOR PHASE 2
