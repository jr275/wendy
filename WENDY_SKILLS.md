# Wendy — Skills (S1: fundação)

Wendy é a super assistente pessoal do João. As Skills são a camada que permite a ela **fazer** coisas
(pesquisar, ler documentos, cuidar de tarefas) com as mesmas regras do núcleo: fatos vêm de registros,
o modelo só conclui sobre eles, e toda ação com efeito passa pelo motor de permissões.

> Modelo: enquanto o Claude não estiver disponível, os passos de modelo rodam no Gemini (Vertex),
> marcados "não é o Claude" no banco e na tela. O gate da Fase 1 continua exigindo o Claude.

## Fluxo de uma mensagem

```
mensagem → intenção (modelo escolhe 1 id do registry, ou "none") → validação do input (zod da skill)
  ├─ "none" → resposta com evidência (answerQuestion, como antes)
  └─ skill  → SkillRuntime.start → passos → tools READ diretas / efeitos via ações → verificação
             → cartão no chat (show_execution) que se atualiza sozinho
```

## Peças

| Peça | Arquivo | O que faz |
|---|---|---|
| Tipos | `src/skills/types.ts` | `SkillDefinition` (manifesto + passos), `StepContext`, erros estruturados |
| Registry | `src/skills/registry.ts` | registrar, validar (ferramentas, risco, dependências, ciclos), buscar, compor, ligar/desligar |
| Descoberta | `src/skills/discovery.ts` | intenção → skill; o modelo escolhe de um `enum` com os ids registrados |
| Runtime | `src/skills/runtime.ts` | lease, passos persistidos, retentativa, timeout, espera por aprovação e por filho, eventos |
| Visão | `src/skills/view.ts` | leitura de uma execução (árvore, passos, aprovações) para a UI |
| Permissões | `src/permissions/policy.ts` | READ/WRITE/EXTERNAL/DESTRUCTIVE/PAYMENT, AUTO/ASK/DENY |
| Tools | `src/tools/*` | catálogo (`specs.ts`), web (busca + leitura segura), documentos, tarefas |
| Tarefas | `src/tasks/taskService.ts` | tarefas do João; escrita só por ação aprovada, idempotente |

## Skills incluídas (v1.0.0)

| Skill | Tools | Risco | Observações |
|---|---|---|---|
| `web-research` | web.search, web.fetch | LOW | cada afirmação cita uma página lida (W1…) |
| `document-analysis` | documents.read | LOW | só `~/Wendy/Documentos`; cita trechos (D1…); txt, md, pdf |
| `task-management` | tasks.* | MEDIUM | criar pede aprovação; concluir é automático; apagar sempre pede |
| `research-and-plan` | — (compõe as duas acima) | MEDIUM | tarefas só a partir de afirmações válidas; criação pede aprovação |
| `learn-about-me` (S3) | documents.read, web.fetch, memory.propose, memory.proposals | LOW | propõe memórias sobre o João a partir de uma fonte dele; cada uma com citação literal verificada pelo código; temas sensíveis nunca são gravados; nada vale até ele confirmar |

## Permissões

| Categoria | Padrão | Pode virar automático? |
|---|---|---|
| READ | executa | — |
| WRITE | o que a tool declarar (padrão: pede) | sim |
| EXTERNAL / DESTRUCTIVE / PAYMENT | sempre pede | **não** |
| qualquer uma com política DENY | recusada, a tool nunca roda | — |

O modelo nunca decide permissão. Aprovar é uma ação do João (`AWAITING_APPROVAL → APPROVED`); silêncio
não aprova; a aprovação pode expirar. O que é aprovado é exatamente o que executa (hash da versão),
uma única vez (idempotência), e é verificado por leitura de volta.

## Banco (migração 006, só adições)

- `skill_executions` — uma execução (pai/filho, status, cursor de passo, estado, lease, espera)
- `skill_execution_events` — eventos estruturados: `skill.*`, `tool.*`, `permission.*`, `model.called`
- `tasks` — tarefas do João (exclusão é lógica: status `DELETED`)
- `captured_sources` — páginas e documentos exatamente como lidos (evidência citável)
- `actions.skill_execution_id` / `skill_step_key` — liga a aprovação ao passo (pedido idempotente)
- `approval_policies.mode` aceita `DENY`

Reaproveitados (não duplicados): `actions` e `approval_policies` (permissões e aprovações), ledger de
auditoria, `model_calls`, o worker com lease, o validador e o `EvidenceRegistry`.

## Segurança

- **Injeção de prompt:** texto da web e de documentos entra como `<untrusted_source>` (o fechamento da
  tag dentro do conteúdo é neutralizado); as skills de leitura não têm nenhuma tool com efeito; o modelo
  não chama tools — só produz texto que o validador confere.
- **SSRF:** só http/https nas portas 80/443, só endereços públicos, DNS fixado na conexão, cada
  redirecionamento reavaliado. Os serviços da Wendy em 127.0.0.1 são inalcançáveis.
- **Documentos:** caminho resolvido com realpath e preso à pasta; atalhos ignorados; tamanho limitado.
- **Mínimo privilégio:** uma skill só usa as tools e os filhos que declara.

## Assíncrono e recuperação

O chat espera até 90 s; depois a execução continua em segundo plano e o cartão se atualiza. O agente
retoma execuções prontas a cada 3 s, e o worker (`npm run worker`) também. Uma execução interrompida por
queda é retomada no passo em que estava, sem refazer os anteriores.

## Testes

`tests/unit/skills.test.ts` e `tests/unit/tools.test.ts` (+ `agent.test.ts`): descoberta, permissões
(aprovar, recusar, DENY, destrutivo), mínimo privilégio, composição, retentativa, recuperação após
queda, injeção de prompt, SSRF, pasta de documentos, PDF. Modelo: dublê roteirizado (não é o Claude);
rede: falsa.

## Memória "sobre você" (S3, primeira fatia)

- A fonte (documento da pasta ou link) é lida e dividida em trechos; o modelo propõe itens com
  `quote` + trecho; o **código** só aceita o item se a citação existir literalmente naquele trecho.
- `sensitive = true` (saúde, remédios, conflitos de família, dinheiro, vida íntima, disputas legais)
  → descartado e só contado; nunca é gravado.
- Gravação: `memory.propose` (WRITE, automática por padrão porque proposta não vale nada até ser
  confirmada) cria memórias `PROPOSED`, com a fonte, a data e a citação no texto e o trecho + a ação na
  evidência. O João confirma ou descarta cada uma no cartão (MemoryService, auditado).

## Próximas fases

S2 permissões na UI e página de execuções · S3 memória estruturada · S4 grafo de composição ·
S5 gatilhos e agenda · S6 criação e evolução de skills (sempre com aprovação).
