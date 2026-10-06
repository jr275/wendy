# WENDY — INITIAL ARCHITECTURE REALITY AUDIT (FASE 0)

**Data:** 2026-10-05
**Repositório:** `~/.gemini/antigravity/scratch/wendy`
**Estado auditado:** working tree atual = commit `2925db5` + alterações não commitadas ("Phase 2.5": `src/repositories/`, `cognitivePipeline.js`, `entityResolver.js`, `salienceEngine.js`, `anticipationEngine.js`, `retrievalEngine.js`, `tests/`).
**Método:** leitura integral de todo o código (≈4.200 linhas de JS/HTML/CSS, sem dependências npm), execução da suíte de testes e de 12 probes adversariais numa **cópia isolada** do repositório (os testes escrevem em `data/` — não foram executados contra o repo real).

**Legenda:** `REAL` = funciona de forma genérica e verificável · `PARTIAL` = funciona apenas no caminho feliz ou com falhas conhecidas · `SIMULATED` = imita um efeito que não acontece · `HARDCODED` = resultado pré-escrito para o cenário de demo · `NOT IMPLEMENTED` = não existe.

---

## RESUMO EXECUTIVO

1. **Não existe nenhum LLM no sistema.** Zero chamadas ao Claude, Claude SDK, AG-UI ou CopilotKit. Toda “compreensão”, “interpretação” e “antecipação” é `String.includes()` sobre palavras-chave.
2. **O hardcode mudou de lugar, não desapareceu.** A versão Phase 2 ramificava por nome (`if carlos`). A Phase 2.5 ramifica por **tópico** (`if text.includes('pricing')`) e devolve frases pré-escritas sobre “Clause 4”, “3% volume rebate” e “Thursday board”. Isso viola literalmente as regras dos itens 22 e 32 da especificação.
3. **Os três testes de verdade (itens 22–24) não são satisfeitos.** O pipeline não consulta calendário (não existe modelo de reunião), não lê compromissos persistidos (não existe modelo de compromisso no código ativo) e não lê o aniversário persistido da Mariana — os fatos vêm **no payload do evento**, não do estado.
4. **A camada de ações declara sucesso falso.** `dispatchEmail` não envia nada, mas devolve `smtpResponse: '250 2.0.0 OK'`, marca a ação como `VERIFIED` e grava na memória episódica “Dispatched authorized communication”.
5. **O ledger de auditoria é fail-open.** JSON corrompido, arquivo apagado, remoção do último bloco ou alteração de `actorId`/`authorizationLevel`/`verificationStatus` → `valid: true`.
6. **A idempotência é burlável.** A chave inclui o corpo do email: editar 1 caractere gera um segundo “envio” para a mesma ação. Um crash entre `IN_PROGRESS` e `COMPLETED` permite reexecução.
7. **A UI é majoritariamente estática.** O dossier, o card do Carlos e o primeiro turno da Wendy estão escritos no HTML. O botão “Dismiss” só remove o card do DOM — a rejeição nunca chega ao servidor.

**O que vale preservar:** a fronteira de repositórios (`src/repositories/interfaces.js`), a escrita atômica de arquivos, o envelope de evento normalizado, o enum completo de `ActionState`, o encadeamento SHA-256 do ledger (com correções) e a estrutura de 4 camadas epistêmicas (observation → interpretation → anticipation → recommendation). São boas **formas**; o **conteúdo** que as preenche precisa ser substituído.

**Veredito:** o sistema é um protótipo de demo bem estruturado, sem cérebro. Não existe ainda um cognitive loop real. A Fase 1 deve construir o núcleo cognitivo do zero sobre as abstrações que já existem.

---

## A. CURRENT ARCHITECTURE

```text
public/index.html + app.js   (UI estática + fetch/SSE; Tailwind via CDN)
        │  HTTP / SSE
server.js  (node:http puro, porta 3456, 127.0.0.1, sem auth)
   ├── GET  /api/state            → ReasoningEngine.generateExecutiveDossier()  [hardcoded]
   ├── GET  /api/stream           → SSE (repasse de PROACTIVE_INSIGHT_GENERATED)
   ├── POST /api/chat             → RetrievalEngine.answerQuery()               [keyword router]
   ├── POST /api/action/sync      → grava preview.body                          [sem checar estado]
   ├── POST /api/action/authorize → audit + ActionAdapters.dispatchEmail()      [simulado]
   ├── GET  /api/audit            → blocos + verifyLedgerIntegrity()
   └── POST /api/events/simulate  → 3 cenários fixos → CognitivePipeline.processEvent()
        │
src/cognition/cognitivePipeline.js
   normalize → persist → EntityResolver → ContextRetriever → SalienceEngine → AnticipationEngine → episodic append → emit
        │
src/repositories/fileStorage.js  (7 repositórios JSON em data/*.json, carregados inteiros em memória)
```

**Código morto (não importado por nada no runtime):** `src/memory/memoryStore.js`, `src/sensory/seedData.js`, `src/governance/auditLedger.js`, `src/cognition/attentionFilter.js`, `src/types/domain.js` (só usado pelo código morto), `src/integrations/providers.js` (nunca importado), `EventBus.publishEvent()` (nunca chamado), `AguiProtocol.createToolProgressEnvelope/createHitlSuspensionEnvelope` (nunca chamados). Os arquivos `data/wendy_memory.json`, `data/wendy_audit_ledger.json` e `data/wendy_audit_ledger_tampered.json` são resíduos da Phase 2.

**Mapa pedido no item 20:**

| Camada | Estado |
|---|---|
| Application | `server.js` monolítico, roteamento manual |
| Agent Runtime | **NOT IMPLEMENTED** — sem Claude SDK, sem loop de agente, sem tools |
| Memory | `FileMemoryRepository`: episódica (lista), preferências, outcomes |
| Persistence | JSON por arquivo, escrita atômica via rename |
| Events | Envelope normalizado + `FileEventRepository` (append-only em JSON) |
| Reasoning | Keyword matching + templates de string |
| Actions | `FileActionRepository` + `ActionAdapters` (email simulado) |
| Providers | Interfaces abstratas não usadas |
| UI | HTML estático + `app.js` |
| Conversation | `/api/chat` → roteador por palavra-chave; nenhum LLM |
| Authentication | **NOT IMPLEMENTED** |
| Scheduling | **NOT IMPLEMENTED** |
| Background Workers | **NOT IMPLEMENTED** |
| Tests | 1 script com 23 asserções (22 passam, 1 falha) |

---

## B. WHAT IS REAL

| Capacidade | Evidência |
|---|---|
| Persistência de entidades, relações, eventos, ações, memória e idempotência em disco, sobrevivendo a restart | `fileStorage.js`; teste grupo 1–2 |
| Escrita atômica (tmp + rename) | `fileStorage.js:22-27` |
| Seed de fixtures idempotente (não reseed se já há pessoas) | `fixtures.js:15-20` |
| Fixtures marcadas como `DEVELOPMENT_FIXTURE` na proveniência | `fixtures.js` |
| Resolução de pessoa por endereço de email exato | `entityResolver.js:27-31`, `fileStorage.js:68-73` |
| Hash SHA-256 do payload do evento como `contentHash` da observação | `anticipationEngine.js:23-24`; teste grupo 7 |
| Encadeamento `prevHash` + detecção de alteração de `payload`/`prevHash`/`timestamp`/`eventType`/`actionId` | `fileStorage.js:348-439` |
| Fail-closed no boot quando a verificação **retorna** inválido | `server.js:33-42` |
| Persistência de edição de rascunho no servidor | `server.js:168-189` |
| Bloqueio de reenvio com corpo **idêntico** após restart | `actionAdapters.js:24-39`; teste grupo 3 |
| SSE servidor → browser | `server.js:79-95` |

## C. WHAT IS PARTIAL

| Capacidade | Problema concreto |
|---|---|
| Cognitive pipeline | Estrutura de etapas correta, mas cada etapa “inteligente” é keyword/template (ver E). Evento duplicado é detectado e **reprocessado mesmo assim**: probe P6 → mesmo `eventId` duas vezes gera 2 registros episódicos (`cognitivePipeline.js:52-55`). |
| Entity resolution | Email exato funciona. Nome: `searchPeople(...)[0]` por substring — “Ana” casa com “Mariana”. Fallback: primeiro nome contido no texto, primeira ocorrência vence (`entityResolver.js:41-53`). Só resolve **uma** pessoa; não resolve tópicos, organizações citadas, reuniões, documentos. |
| Context retrieval | Retorna as 5 últimas memórias da pessoa + **todas** as preferências (`contextRetriever.js`). Não busca por tópico, janela de tempo, reuniões, compromissos ou threads. O contexto recuperado **não é usado** pelos geradores de texto. |
| Salience | Fórmula ponderada explícita existe (`salienceEngine.js:51-57`), mas os fatores vêm de listas de palavras (ver E) e de `tier` estático. Teste COMMITMENT falha: compromisso com “valuation/pricing” vira URGENT. |
| Action lifecycle | Enum completo, mas **nenhuma transição é validada** (`fileStorage.js:242-256`): é possível ir de `REJECTED` para `APPROVED`. `/api/action/authorize` não checa o estado atual. Não há endpoint de rejeição. |
| Idempotência | Durável, mas chave = hash de `actionId+recipient+subject+body` (`actionAdapters.js:20-22`) → probe P7: corpo editado em 1 caractere = 2º envio. Registro `IN_PROGRESS` órfão é sobrescrito e reexecutado (probe P8; `fileStorage.js:286-307`). |
| Audit ledger | Ver N. Hash não cobre `actorId`, `authorizationLevel`, `verificationStatus`, `sequenceNumber`; concatenação sem delimitador; truncamento de cauda indetectável; parse falho → ledger vazio válido. |
| Retrieval/chat | Lê memória persistida de verdade, mas o roteamento de intenção e a resposta final são keyword + template (ver E). |
| Proveniência | Hash do payload é real, mas `verified: true` é constante (`anticipationEngine.js:35`) e `origin` assume `LIVE_TELEMETRY` para tudo que não for marcado (`cognitivePipeline.js:132`) — eventos `GMAIL_MOCK` aparecem como telemetria ao vivo. |

## D. WHAT IS SIMULATED

| Item | Evidência |
|---|---|
| **Envio de email** | `actionAdapters.js:50-59`: `console.log` + recibo fabricado `smtpResponse: '250 2.0.0 OK: message queued 10429'`, `recipientStatus: 'DELIVERED_TO_GATEWAY'`. Ação marcada `VERIFIED`; memória episódica registra “Dispatched authorized communication”; outcome `wasSuccessful: true`. **Isso é memória falsa sobre o mundo.** |
| **Verificação** | Não existe read-back de provider. `VERIFIED` = “o console.log rodou”. |
| **Eventos de entrada** | `/api/events/simulate` escolhe entre 3 payloads fixos (`server.js:271-303`). A opção da UI “competitor_news” cai no `else` e dispara o **aniversário da Mariana**; a opção “Carlos: Pricing agreed” envia na verdade um email de **urgência** de pricing. |
| **Tool progress do AG-UI** | Os checkmarks “Indexed calendar events & 14:00 Carlos meeting”, “Retrieved late-night email (23:42)” são HTML estático (`index.html`). O servidor nunca emite `AGUI_TOOL_PROGRESS`. |
| **Inspector de proveniência** | Mostra o hash do **último bloco do audit ledger**, sem relação com o item clicado; fallback é `e3b0c442…` = SHA-256 da string vazia (`app.js:283-287`, `index.html`). |
| **“AG-UI v1.0”** | Não há protocolo AG-UI; é SSE ad-hoc com nomes de evento próprios. |
| **“AWARENESS ACTIVE” / relógio** | Texto fixo “OCTOBER 5, 2026 • 08:30 AM” no HTML. Não há processo em background. |
| **Rejeição** | `rejectAction` (`app.js:248-253`) só remove o card do DOM. Estado de aprovação vive apenas no browser — violação direta do item 27. |

## E. WHAT IS HARDCODED

**Cognição por palavra-chave (o problema central):**

| Local | O que está fixo |
|---|---|
| `anticipationEngine.js:62-66` | Decide ação por `text.includes('birthday')` / `text.includes('pricing')` / `'urgent' && 'meeting'`. |
| `anticipationEngine.js:96-131` | Interpretação/antecipação/recomendação são frases pré-escritas por palavra-chave: *“Pricing alignment in Clause 4 is the critical hurdle…”*, *“Review the 3% volume rebate concession schedule in Drive…”*, *“The counterparty will inquire about the promised numbers within the next 4 hours.”* Qualquer email com “pricing” — de qualquer pessoa — recebe a fala sobre Clause 4. |
| `anticipationEngine.js:150-154` | Rascunho de aniversário fixo assinado “Warmly, João”, `scheduledFor: 'Tomorrow at 08:30 (BST)'` fixo, fallback `contact@partner.com`. O texto diz “tomorrow” mesmo quando o evento diz “in 9 months” (probe P5). |
| `anticipationEngine.js:183-186` | Briefing fixo: “Recommended counter: 3% volume rebate tier locked for 24 months”, “Horizon_Partnership_Agreement_v3_draft.pdf”. Ação criada já em `APPROVED`. |
| `salienceEngine.js:26-44` | Urgência por lista: `urgent/asap/immediately` → 0.95; `today/before tomorrow/in 5 hours` → 0.85; `tomorrow/birthday/thursday` → 0.75. Impacto: `pricing/committee/board/contract/valuation` → 0.9. |
| `salienceEngine.js:65-77` | Categoria RELATIONSHIP = `text.includes('birthday')`. |
| `retrievalEngine.js:58-61` | Intenção “comunicação” = query contém `communicate/tone/write/email/prefer`; memória relevante = summary contém `concise/communication/prefers` ou snippet contém `sentence`. O teste 5 grava exatamente uma memória com “concise” — o teste foi construído para casar com o filtro. |
| `retrievalEngine.js:100` | Recomendação fixa: *“Keep all correspondence with X direct, concise, and focused on key numbers”* — devolvida para **qualquer** pessoa, independentemente da memória. |
| `retrievalEngine.js:136-137` | *“Prioritize closing the open deliverable before the Thursday board timeline.”* para qualquer pessoa com `reciprocityBalance < 0`. |

**Cenário de demo:**

| Local | O que está fixo |
|---|---|
| `reasoningEngine.js:40-41` | `findPersonByEmail('carlos@horizoncap.com')`, `findPersonByEmail('mariana@apexbio.com')` |
| `reasoningEngine.js:51-107` | Os 4 quadrantes do dossier: títulos, horários (“14:00”, “17:00”), `salienceScore` 0.94/0.88/0.82/0.38, narrativas, arquivos de Drive, `epistemicState: 'FACT'` em itens inventados. |
| `index.html` | Dossier inteiro, primeiro turno da Wendy, card do briefing do Carlos, card e rascunho da Mariana, contador “1 Action Awaiting Approval”, `alert()` com nomes de arquivos. |
| `app.js:70-84, 209-237` | Lógica de UI amarrada a `birthday`/`Mariana`/IDs `draft-mariana-body`, `btn-auth-mariana`. |
| `'person-exec-joao'` | Principal fixo em `entityResolver.js:46,63`, `retrievalEngine.js:23,41`, `actionAdapters.js:19`, `server.js:197`. Sistema single-user por construção. |
| `fixtures.js` | Métricas relacionais (`closenessScore 0.92`, `velocity 'ACCELERATING'`, `reciprocityBalance -1`, `tier 1`) são valores escritos à mão, não derivados de interações. (Aceitável **como fixture rotulada**; não aceitável como entrada do salience sem rótulo.) |

## F. WHAT IS MISSING

- **LLM / Agent runtime:** Claude API, Claude Agent SDK, tools, structured outputs, prompts.
- **AG-UI / CopilotKit:** nenhum dos dois existe.
- **Modelos de domínio essenciais:** Meeting/CalendarEvent, Commitment, Topic, EmailThread/Message, Document, Project, Decision. (Commitment existia em `memoryStore.js`, hoje morto.)
- **Detectores sobre estado** (o coração da antecipação): “compromisso vence hoje”, “aniversário amanhã”, “reunião sem briefing”, “aguardando resposta há N dias”. Hoje os fatos chegam prontos no payload.
- **Scheduler / background loop / worker.**
- **Change detection** (séries temporais de comportamento por pessoa).
- **Modelo de Claim/Evidence:** afirmações com referência a IDs de evidência verificáveis.
- **Memória semântica** (fatos aprendidos com proveniência), embeddings, busca vetorial.
- **Policy engine** de aprovação configurável por usuário/tipo de ação.
- **Outbox transacional**, máquina de estados com transições validadas, rejeição/expiração/cancelamento.
- **Providers concretos** (nem mesmo um provider local/dev que implemente as interfaces).
- **Auth, tenants, multiusuário, CSRF, escape de HTML.**
- **Learning loop:** outcomes são gravados mas nunca lidos.
- **Testes:** isolamento de dados, testes de propriedade “sem hardcode”, concorrência, falhas.

## G. CURRENT DATA MODEL

Persistido em `data/*.json` (sem schema, sem validação):

| Arquivo | Conteúdo |
|---|---|
| `entities.json` | `people{id → {fullName, title, organizationId, emailAddresses[], tier, birthday?, timeZone, notesSummary, provenance}}`, `organizations{}` |
| `relationships.json` | `{id, personAId, personBId, relationshipType, closenessScore, velocity, lastInteractionAt, interactionCadenceDays, reciprocityBalance, historicalNotes[] (texto livre)}` |
| `events.json` | array de envelopes |
| `actions.json` | `actionId → {actionType, authorizationLevel, state, targetEntityId, headline, justification[] (strings), preview{}, consequences{}, provenance, timestamps}` |
| `memories.json` | `episodic[]`, `preferences[]`, `outcomes[]` |
| `idempotency.json` | `key → {actionId, operation, requestHash, status, result}` |
| `audit_ledger.json` | array de blocos encadeados |

Problemas: relações e “notas históricas” são texto livre, sem proveniência por fato; `tier` é a única noção de importância; não há `owner_id`/tenant; `data/` está versionado no git e os testes escrevem nele (há ações de teste `act-lifecycle-*`, `act-idem-*` misturadas aos dados).

## H. CURRENT EVENT MODEL

Envelope (`cognitivePipeline.js:112-137`): `eventId, eventType, source, occurred_at, received_at, actor, primaryEntity, secondaryEntityIds, payload, confidenceScore, provenance{sourceSystem, rawPayloadHash, sourceType}, correlationId, permissions`.

| Requisito (item 25) | Estado |
|---|---|
| Campos mínimos | **PARTIAL** — presentes; `entity_ids` não é preenchido pela resolução. |
| Persistível | **REAL** |
| Replayable | **NOT IMPLEMENTED** — sem API de replay; reprocessar gera efeitos colaterais duplicados. |
| Rastreável | **PARTIAL** — `correlationId` gerado mas nunca propagado para ações/insights. |
| Idempotente | **PARTIAL** — dedupe só por `eventId`, que é gerado aleatoriamente se ausente; não há chave natural `(source, external_id)`; duplicata é reprocessada. |

Há ainda um segundo formato de envelope incompatível em `eventBus.js` (`timestamp`, `importanceScore`, `epistemicCategory`) e o resultado do pipeline (o “insight”) **não é persistido** — só emitido via SSE.

## I. CURRENT MEMORY MODEL

- **Episódica:** lista de `{interactionType, entityIds, summary, verbatimSnippet, provenanceHash}`. `occurredAt` = hora da gravação, não do fato. Busca por `entityId` ou por prefixo de 5 letras.
- **Preferências:** regras em texto, escritas à mão nas fixtures; nunca aprendidas.
- **Outcomes:** gravados, nunca lidos.
- **Semântica (fatos sobre pessoas/relações):** **NOT IMPLEMENTED** — vive como `historicalNotes` em texto livre.
- **Vetorial:** **NOT IMPLEMENTED.**
- **Write policy:** o pipeline grava como memória o *statement de observação gerado por template*, não o fato da fonte; e o adapter grava “email enviado” que nunca foi enviado. A memória pode conter afirmações falsas.

## J. CURRENT AGENT/RUNTIME MODEL

**NOT IMPLEMENTED.** Não há agente. `CognitivePipeline` é uma função síncrona invocada por HTTP; `ReasoningEngine` é um gerador de dossier fixo + roteador de chat. Não há loop, tools, memória de conversa, nem processo contínuo. A especificação (itens 17–19) pede Claude SDK + AG-UI como camada de **presença** sobre um cérebro separado — nenhum dos dois lados existe ainda, mas a separação “pipeline ≠ chat” já existe em embrião e deve ser mantida.

## K. CURRENT ACTION MODEL

- Estados: `PROPOSED, STAGED, AWAITING_APPROVAL, APPROVED, EXECUTING, EXECUTED, VERIFIED, REJECTED, FAILED, CANCELLED, EXPIRED` — **enum REAL, máquina de estados NOT IMPLEMENTED** (sem transições validadas; `EXECUTING` e `EXECUTED` nunca são usados; o adapter pula de qualquer estado direto para `VERIFIED`).
- Níveis de autorização 0–4 definidos; o nível é escrito à mão em cada template, não decidido por política.
- `actionId` determinístico por pessoa (`act-birthday-${person.id}`) + `saveAction` com merge → um novo evento de aniversário **rearma** uma ação já `VERIFIED` para `AWAITING_APPROVAL`, e o próximo “authorize” com texto editado envia de novo.
- Briefing é criado diretamente em `APPROVED` sem passar por política.
- Sem expiração (o rascunho de aniversário nunca expira), sem cancelamento, sem rejeição persistida.

## L. CURRENT PROVIDER MODEL

`src/integrations/providers.js` define `EmailProvider`, `CalendarProvider`, `ContactsProvider`, `DriveProvider` — boas assinaturas (inclusive `stageDraft` vs `dispatchAuthorizedEmail` vs `verifyDelivery`), mas **nenhuma implementação e nenhum import**. O cérebro não depende de providers hoje porque não lê nada do mundo; o adapter de ação ignora a interface `EmailProvider`. Status: **interfaces PARTIAL, providers NOT IMPLEMENTED.**

## M. CURRENT TEST COVERAGE

`tests/phase_2_5_reality_test.js` — 23 asserções, **22 passam, 1 falha** (`COMMITMENT_APPROACHING` classificado como URGENT).

Problemas da suíte:
- Escreve no `data/` real do projeto (polui o estado do app; não há fixture isolada).
- Asserção de truncamento é tautológica: `valid === true || error.includes('Sequence')` aceita o truncamento como sucesso.
- O teste de retrieval grava uma memória contendo exatamente as palavras que o filtro procura.
- Os testes do pipeline afirmam apenas `category` e tipos (`'FACT'`), não o conteúdo derivado nem o uso de contexto.
- Não há testes de: duplicata de evento, concorrência, falha de ação, rejeição pelo endpoint, contexto ausente, incerteza, multiusuário, pessoa desconhecida.

**Probes adversariais executados (cópia isolada):**

| # | Probe | Resultado |
|---|---|---|
| P1 | Compromisso “valuation… pricing” vencendo hoje | Classificado **URGENT**, não COMMITMENT |
| P2 | Email do Carlos semanticamente urgente sem as palavras-chave (“close the headcount budget before our session tomorrow”) | Interpretação genérica “requires proactive executive attention”; nenhuma ação |
| P3 | Email com “pricing” de remetente desconhecido | **Crash** `TypeError: Cannot read properties of null (reading 'id')` |
| P4 | Aniversário de pessoa desconhecida | **Crash** (mesmo erro) |
| P5 | Evento diz aniversário da Mariana “in 9 months” (persistido: amanhã) | Aceita o payload; rascunho diz “tomorrow”; o dado persistido nunca é lido |
| P6 | Mesmo `eventId` processado 2× | 2 registros episódicos |
| P7 | Mesmo `actionId`, corpo alterado em 1 caractere | 2× `VERIFIED_SUCCESS` (duplo “envio”) |
| P8 | Registro de idempotência `IN_PROGRESS` após crash | Reexecuta |
| P9 | Alterar `actorId`/`authorizationLevel`/`verificationStatus` no ledger | `valid: true` |
| P10 | Remover último bloco | `valid: true` |
| P11 | Ledger com JSON inválido | `valid: true, blockCount: 0` |
| P12 | Ledger apagado | `valid: true, blockCount: 0` |

## N. ARCHITECTURAL RISKS

1. **Inteligência falsa com rótulos de verdade.** Templates por palavra-chave aparecem na UI com selos `FACT`/`INFERENCE`/“PROVENANCE VERIFIED”. Este é o risco nº 1 de confiança do produto.
2. **Memória envenenada.** O sistema grava na própria memória que enviou emails que não enviou. Uma Wendy futura raciocinaria sobre fatos falsos.
3. **Ledger fail-open.** Qualquer falha de leitura vira “ledger vazio e válido”; campos de autorização não são cobertos pelo hash; sem âncora de cabeça, truncamento é invisível.
4. **Duplicação de ações externas.** Chave de idempotência derivada do conteúdo, `IN_PROGRESS` reexecutável, ações rearmáveis por merge. No momento em que um provider real for plugado, isso envia emails duplicados.
5. **Sem auth + CSRF.** O servidor faz `JSON.parse` de qualquer corpo sem checar `Content-Type`; uma página qualquer aberta no navegador pode fazer POST `text/plain` (requisição “simples”, sem preflight) para `127.0.0.1:3456/api/action/authorize`. Hoje é inócuo porque o envio é simulado; com Gmail real, é um envio de email disparável por terceiros.
6. **XSS armazenado.** `app.js` injeta `summary`, `verbatimSnippet`, `reply` e statements via `innerHTML` sem escape. Corpo de email externo → execução de script na UI do executivo.
7. **Persistência JSON não suporta o DoD.** Cada repositório carrega o arquivo inteiro e reescreve tudo a cada gravação; múltiplas instâncias (o teste já cria várias) sobrescrevem umas às outras (last-writer-wins); sem transações entre ação + idempotência + audit; sem multiusuário.
8. **Principal fixo** (`person-exec-joao` em 6 lugares): multiusuário exige refatoração transversal.
9. **Acoplamento cérebro ↔ cenário:** a UI, o dossier e o adapter conhecem Mariana/Carlos por ID/nome.
10. **Documentação divergente.** `WENDY_PHASE_2_REALITY_AUDIT.md` descreve o código do commit anterior (ex.: “idempotência em Set em memória”, “processExecutiveQuery com q.includes('carlos')”), que já mudou. Os demais `WENDY_*.md` descrevem uma arquitetura-alvo, não o estado real.
11. **Dívida de limpeza:** ~700 linhas de código morto com nomes semelhantes aos ativos (`auditLedger.js` vs `FileAuditRepository`, `memoryStore.js` vs `FileMemoryRepository`, dois envelopes de evento) — alto risco de alguém editar o arquivo errado.

---

## O. RECOMMENDED TARGET ARCHITECTURE

### O.1 Princípio de divisão de trabalho: determinístico vs. LLM

A regra “sem `if Carlos`, sem `if pricing`” tem uma consequência arquitetural direta: **compreensão de linguagem precisa vir de um modelo**, e **estado, política, pontuação e efeitos colaterais precisam ser código determinístico**.

| Determinístico (código, testável, auditável) | Claude (compreensão e linguagem) |
|---|---|
| Ingestão, dedupe, persistência de eventos | Extrair de um sinal: pessoas citadas, tópicos, pedidos, prazos, sinais de urgência — **com spans de evidência** |
| Entity resolution por identificador (email, telefone, ID externo) | Desambiguação de nomes quando o identificador não basta |
| Detectores sobre estado (prazo de compromisso, datas de pessoas, reuniões próximas, silêncio) | Interpretação / antecipação / recomendação a partir do contexto recuperado |
| Fórmula de salience sobre fatores nomeados | Estimar fatores qualitativos (ex.: urgência expressa) **como inputs** da fórmula, com justificativa |
| Máquina de estados de ação, política de aprovação, idempotência, outbox | Redigir rascunhos e briefings no estilo do executivo |
| Validação de claims: toda afirmação precisa citar IDs de evidência que existem | — |

O LLM **nunca** decide sozinho executar algo, nunca escreve diretamente em memória sem passar pelo validador, e todo output dele é estruturado (JSON schema) e rotulado como `INFERENCE`/`HYPOTHESIS`/`RECOMMENDATION`. `FACT` só pode ser produzido por código a partir de uma fonte.

### O.2 Componentes

```text
                         ┌───────────── PRESENCE ─────────────┐
                         │  Chat (CopilotKit/AG-UI)  Voice  …  │
                         └───────────────┬─────────────────────┘
                                         │ AG-UI events
                         ┌───────────────▼─────────────────────┐
                         │ AGENT RUNTIME (Claude Agent SDK)    │
                         │ tools = consultas/ações do cérebro  │
                         └───────────────┬─────────────────────┘
                                         │ (mesmas APIs internas)
┌─────────── SENSORS ───────────┐   ┌────▼──────────── BRAIN ─────────────────────────────┐
│ Providers (Dev/Local, Gmail,  │──▶│ 1 Ingest   → EventStore (dedupe source+external_id) │
│ Calendar, Contacts, Drive,    │   │ 2 Understand (Claude, structured) → Signals+spans   │
│ News…) + Scheduler (ticks)    │   │ 3 Resolve  → Person/Org/Topic/Meeting/Commitment    │
└───────────────────────────────┘   │ 4 Retrieve → contexto por entidade/tópico/tempo     │
                                    │ 5 Detect   → detectores sobre estado (radar)        │
                                    │ 6 Score    → Salience(factors) + explicação         │
                                    │ 7 Reason   → Claims (OBS/INT/ANT/REC) c/ evidências │
                                    │ 8 Validate → rejeita claim sem evidência válida     │
                                    │ 9 Propose  → Action + PolicyEngine → estado inicial │
                                    │10 Persist  → Insight, Claims, Action, Memory (1 tx) │
                                    └────┬───────────────────────────────────────────────┘
                                         │
                       ┌─────────────────▼──────────────────┐
                       │ EXECUTION: Outbox worker → Provider │
                       │ → Verify (read-back) → Audit ledger │
                       │ → Outcome → Memory (learning)       │
                       └────────────────────────────────────┘
Storage: PostgreSQL (+ pgvector na Fase 2) atrás das interfaces de repositório;
         adapter in-memory para testes unitários.
```

### O.3 Decisões estruturais recomendadas

1. **Insight como entidade persistida** (`insight_id, event_ids[], correlation_id, salience{factors, score, explanation}, claims[], proposed_action_id`). Hoje o insight só existe no SSE.
2. **Claim/Evidence:** `claim{type: FACT|INFERENCE|HYPOTHESIS|RECOMMENDATION, statement, confidence, evidence_refs[{kind: event|message|meeting|commitment|memory, id, span?}], derived_from_claim_ids[]}`. “Por que Wendy acha isso?” = percorrer `derived_from` até `evidence_refs`.
3. **Detectores como produtores de eventos internos:** `COMMITMENT_APPROACHING` e `PERSON_EVENT_APPROACHING` devem ser **gerados por um detector que lê o estado persistido**, com payload contendo apenas referências (`commitment_id`, `person_id`, `date_kind`). O pipeline então recupera os fatos do repositório. Isso resolve P5 e torna os testes 2 e 3 legítimos.
4. **Idempotência por identidade, não por conteúdo:** `idempotency_key = action_id + attempt_purpose`; conteúdo editado gera nova **versão** da mesma ação, nunca nova execução. Execução via **outbox** na mesma transação que muda o estado para `APPROVED`.
5. **Ledger:** hash sobre JSON canônico de **todos** os campos do bloco, com delimitação inequívoca; cabeça (`seq`, `hash`) ancorada separadamente (tabela/arquivo próprio) para detectar truncamento; qualquer erro de leitura/parse = falha → fail closed.
6. **Principal/tenant explícito** em todas as tabelas e chamadas (`principal_id`), nada de `person-exec-joao` no código.
7. **Persistência:** recomendo PostgreSQL já na Fase 1 (não SQLite intermediário). Justificativa: as garantias exigidas no item 37 — eventos concorrentes, duplicatas, restart no meio de uma ação — dependem de transações e constraints `UNIQUE`, que o JSON não oferece, e uma migração intermediária seria trabalho jogado fora. pgvector entra só na Fase 2, quando houver busca semântica a fazer.

---

## P. PHASED IMPLEMENTATION PLAN — WENDY V1 EXECUTION PLAN

Cada fase termina com **critérios de saída executáveis**. Nenhuma fase é dada como concluída por documento.

### Fase 0.5 — Higiene e honestidade (curta; pré-requisito)

- Remover código morto (`memoryStore.js`, `seedData.js`, `auditLedger.js`, `attentionFilter.js`, envelope do `eventBus.publishEvent`, `data/wendy_*.json`).
- Tirar `data/` do git; testes passam a usar diretório temporário por execução.
- Ledger fail-closed em erro de parse/arquivo ausente-com-cabeça-registrada.
- Adapter de email passa a retornar `status: SIMULATED` explícito; ações simuladas não viram `VERIFIED` nem memória episódica de “enviado”.
- UI: marcar visivelmente tudo que é estático/simulado (ou esconder), escapar HTML, persistir rejeição pelo servidor.
- Marcar `WENDY_PHASE_2_REALITY_AUDIT.md` como superado por este documento.

**Saída:** probes P3, P4, P9–P12 passam a falhar de forma segura; nenhuma tela exibe `VERIFIED`/`FACT` para algo simulado.

### Fase 1 — Cognitive Core

- Esquema Postgres + repositórios: `events`, `people`, `organizations`, `relationships`, `meetings`, `commitments`, `topics`, `messages`, `insights`, `claims`, `actions`, `action_versions`, `idempotency`, `audit_blocks`, `memories`; todos com `principal_id`.
- `DevLocalProvider` (Email/Calendar/Contacts) que lê fixtures **rotuladas** e emite eventos pelo mesmo caminho que o Gmail usará.
- Etapa **Understand** com Claude (structured output): extrai pessoas, tópicos, pedidos, prazos e sinais de urgência com spans.
- Entity/topic resolution; context retrieval por entidade + tópico + janela temporal + reuniões próximas + compromissos abertos.
- Salience com fatores nomeados (importance, urgency, relationship relevance, business impact, novelty, confidence, time sensitivity, actionability, executive preference) e explicação gerada a partir dos fatores.
- Reason → Claims com evidências; **Validator** rejeita claim sem evidência existente.
- PolicyEngine mínimo (nível de autorização por tipo de ação + override por preferência do usuário).
- Insight, claims e ação proposta persistidos numa transação.

**Saída (os três testes de verdade, agora legítimos):**
1. Email “We need to resolve pricing before tomorrow’s meeting” → Carlos resolvido por email; tópico extraído pelo modelo; reunião de amanhã encontrada **no repositório de reuniões**; emails anteriores do tópico recuperados; salience com fatores; claims OBS/INT/ANT/REC com evidências; briefing proposto; resposta proposta em `AWAITING_APPROVAL`; tudo persistido.
2. Detector encontra compromisso persistido vencendo hoje sem evidência de conclusão → insight “compromisso pendente… quer que eu prepare o follow-up?”.
3. Detector encontra data de aniversário persistida para amanhã → recupera relação/histórico → rascunho em `AWAITING_APPROVAL`.

**Testes anti-hardcode obrigatórios:**
- *Metamórfico:* renomear Carlos→“Beatriz Kaminski”, pricing→“headcount”, Mariana→outra pessoa com outra data — mesmos resultados estruturais.
- *Lint:* `src/` não pode conter nomes/emails/tópicos das fixtures (checado no CI).
- *Duplicata, restart no meio, pessoa desconhecida, contexto ausente* (o sistema deve dizer “não sei”, não inventar).
- Testes com LLM em dois modos: **live** (chave de API, conjunto pequeno de evals) e **replay** de respostas gravadas — o modo replay é rotulado como tal e nunca conta como prova de inteligência.

### Fase 2 — Persistent Memory + Context

- Memória semântica: fatos sobre pessoas/relações (`"Carlos prefere comunicação curta"`) com proveniência para mensagens/episódios de origem, confiança, data de última confirmação, contradição/supersessão.
- Write policy: o que vira memória, quem pode escrever (o modelo propõe, o validador aceita).
- pgvector para recuperação semântica de mensagens/episódios/fatos.
- Métricas relacionais **derivadas** de interações (cadência, última interação, reciprocidade) em vez de valores à mão.

**Saída:** “Como devo responder ao Carlos?” meses depois responde a partir do fato aprendido, citando a mensagem de origem; trocar o fato no banco muda a resposta sem mudar código.

### Fase 3 — Anticipation + Future Radar + Executive Brief

- Scheduler local (ticks) acionando detectores: compromissos próximos, datas de pessoas, reuniões sem briefing, aguardando resposta, projetos sem owner, renovações.
- Future Radar (próximos 7 dias) e Early Warnings **derivados de consultas**, nunca listas fixas.
- Executive Brief pré-reunião (participantes, último contato, tópicos abertos, divergências registradas, leitura e sugestão — cada linha com evidência).
- Supressão/agrupamento (proteger atenção) e feedback “isso não importa” virando preferência.

**Saída:** com o banco de fixtures, o radar lista itens que mudam quando os dados mudam; teste metamórfico idem.

### Fase 4 — Actions + Approval + Verification

- Máquina de estados com transições validadas e testadas exaustivamente; `EXPIRED` por prazo; `CANCELLED` quando o contexto muda.
- Outbox transacional + worker; idempotência por `action_id`; versões de conteúdo.
- Endpoints de aprovar/rejeitar/editar com auth e proteção CSRF; rejeição gera outcome e aprendizado.
- Verificação por read-back do provider (`verifyDelivery`), não por retorno do próprio adapter.
- Ledger endurecido (O.3-5) com testes de alteração de cada campo, remoção, reordenação, truncamento, corrupção.

**Saída:** kill -9 em cada ponto do fluxo de execução nunca produz execução duplicada; ledger adulterado impede boot.

### Fase 5 — Conversational Presence (Claude Agent SDK + AG-UI/CopilotKit)

- Agente único Wendy, com tools que são **consultas e propostas sobre o cérebro** (buscar contexto, explicar um insight, propor ação, aprovar com confirmação). O chat não guarda estado próprio crítico.
- Streaming AG-UI de progresso real das tools (não checkmarks estáticos); HITL via estados `AWAITING_APPROVAL` reais.
- Insights proativos do cérebro entram na conversa como mensagens da Wendy.

**Saída:** “Por que você acha isso?” percorre claims → evidências reais; aprovar no chat = mesma transição de estado que aprovar na UI.

### Fase 6 — Google Workspace (sensores reais)

- Ordem: leitura (Gmail, Calendar, Contacts) → rascunho (`stageDraft`) → envio (com política explícita). Drive em seguida.
- Sync incremental, dedupe por ID externo, backfill limitado, tratamento de credencial revogada.

### Fase 7 — Continuous Background Intelligence

- Worker durável fora do processo HTTP, filas, retries, rate limits, observabilidade, multiusuário real (isolamento por `principal_id`), custos de LLM controlados (batching, cache, modelo menor para extração).

### Fase 8 — Relationship, Organizational Intelligence & Change Detection

- Séries temporais por pessoa (latência de resposta, cancelamentos, participação) e detecção de mudança com evidência e incerteza explícitas (item 7).
- Grafo organizacional: responsabilidade formal vs. influência observada, sempre com evidência.

### Fase 9 — Serendipity Engine

- Detecção de convergência de tópicos entre pessoas sem conexão observada entre si; proposta de conexão com evidência e pauta.

### Fase 10 — Voice / Avatar / Multimodal Presence

- Novas superfícies sobre o mesmo runtime e as mesmas tools; zero lógica de inteligência na camada de presença.

### Reordenação em relação à proposta original

- **Adicionada Fase 0.5** (limpeza e honestidade), porque o código atual mente em pontos visíveis e isso contamina qualquer avaliação posterior.
- **“Real External Signals” (5) foi desmembrada:** a parte de sinais vira o `DevLocalProvider` da Fase 1 (mesmo caminho de ingestão que o Gmail usará) e as integrações reais ficam na Fase 6. News/sinais externos vão junto com a Fase 7 (exigem background contínuo).
- **Conversação (AG-UI/Claude SDK) entra como Fase 5**, depois que existe um cérebro para ela consultar, conforme o item 17 (“o chat não pode ser o cérebro”).

---

## DECISÕES EM ABERTO (precisam do responsável pelo produto antes da Fase 1)

| # | Decisão | Recomendação |
|---|---|---|
| D1 | **Linguagem do cérebro.** O código atual é Node/JS. A demo de referência do CopilotKit usa `claude-sdk-python`. | **TypeScript (Node).** Claude Agent SDK, AG-UI e o frontend do CopilotKit existem em TS; uma linguagem ponta a ponta; e o código reaproveitável atual é JS. Python faz sentido se você quiser seguir a demo exatamente. Como quase todo o núcleo cognitivo será escrito agora, o custo de mudar é baixo **neste momento** e alto depois. |
| D2 | **Postgres já na Fase 1?** | **Sim** (ver O.3-7). Alternativa: manter JSON na Fase 1 e migrar na Fase 4 — mais rápido de iniciar, mas os testes de concorrência/duplicata do DoD não seriam honestos até lá. |
| D3 | **Acesso à API do Claude** (chave, orçamento para evals ao vivo). | Necessário na Fase 1; sem ele, a etapa Understand não pode ser REAL. |
| D4 | **UI atual.** | Congelar e rotular como protótipo; não investir nela até a Fase 5. |
| D5 | **Commitar o trabalho “Phase 2.5”** que está não commitado antes de iniciar a Fase 0.5. | Sim, como checkpoint, com mensagem deixando claro que é estado pré-auditoria. |

---

## APÊNDICE — Classificação da cadeia do item 21 no código atual

| Etapa | Estado | Observação |
|---|---|---|
| EVENT | PARTIAL | Envelope ok; dedupe fraco; duplicata reprocessada |
| ENTITY RESOLUTION | PARTIAL | Email exato real; nomes/tópicos/reuniões não |
| CONTEXT RETRIEVAL | PARTIAL | Recupera, mas o resultado não é usado |
| MEMORY | PARTIAL | Persistente, mas sem semântica e com gravações falsas |
| REASONING | HARDCODED | Templates por palavra-chave |
| SALIENCE | PARTIAL | Fórmula real, fatores por palavra-chave |
| ANTICIPATION | HARDCODED | Frases fixas |
| PROACTIVE INSIGHT | PARTIAL | Emitido via SSE, não persistido |
| ACTION | PARTIAL | Persistida; sem política; rearmável |
| PERSISTENCE | REAL (JSON) | Com os limites de concorrência descritos em N-7 |
| EXECUTION / VERIFICATION | SIMULATED | Recibo SMTP fabricado |
| LEARNING | NOT IMPLEMENTED | Outcomes nunca lidos |
