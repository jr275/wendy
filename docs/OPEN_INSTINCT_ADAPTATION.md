# Open Instinct → Wendy: o que foi adaptado

Fonte: https://github.com/mariagorskikh/open-instinct (MIT, v0.1 beta, TypeScript). Decisão: **adaptar padrões, não rodar o produto.**
Nenhum código do projeto foi copiado nem executado; as ideias foram reescritas para a arquitetura da Wendy (zod, sem dependências novas,
sem rede, sem chaves). Os módulos novos são **puros e NÃO estão ligados** ao agente: a Wendy ainda não tem um canal por onde outra
pessoa possa pedir algo nem uma ferramenta de pagamento. São a regra pronta, testada, para quando existirem.

| Recurso do Open Instinct | Situação na Wendy | Onde |
|---|---|---|
| Seis camadas de confiança (owner, partner, family, friend, contact, stranger) e tabela de capacidades | **Adaptado** (mais restritivo) | `src/permissions/trust.ts` |
| Concessões (grants) com escopo, janela e expiração | **Adaptado**: só elevam de negado para "pergunta", exigem expiração futura, algumas capacidades não são concedíveis | `trust.ts` |
| `beforeToolCall` (camada → concessão → limites, decisão registrada) | **Já coberto**: `policy.ts` (EXTERNAL/DESTRUCTIVE/PAYMENT nunca automáticos) + ledger encadeado. A confiança só se **soma** por `combineDecisions` (nunca afrouxa) | `policy.ts`, `trust.ts` |
| Política de gasto (`perActionUsd`, `perDayUsd`, `askAbove`, `neverWithoutAsk`, listas de comerciantes) | **Adaptado**: acima do limite é recusa (não "pergunta"), listas **aplicadas** (no original ainda não), centavos inteiros, sem arquivo = sem gasto, arquivo inválido = sem gasto | `src/permissions/spendPolicy.ts`, `config/spend-policy.example.json` |
| Cartão de uso único: nunca repetir número, validade ou CVC em mensagem, memória, diário ou arquivo | **Adaptado** como mascaramento de melhor esforço (rótulos + formato/Luhn), ver "Mascaramento de cartão" abaixo; **só** em dois destinos | `src/security/cardRedaction.ts`, `src/cognition/resilience.ts` |
| Auditoria `audit.jsonl` | **Já coberto** por algo mais forte (ledger com hash encadeado, falha fechada) | `src/audit/ledger.ts` |
| Aprovações, agendador, memória, loop do agente | **Já cobertos** (ações com aprovação, runtime de skills, ciclo de vida de memória) | — |
| `packages/payments` (carteira Stripe Link) | **Não adotado**: exige conta e chave externas e é ação de PAGAMENTO | — |
| `packages/inkbox` (iMessage, SMS, e-mail, agente-para-agente) | **Não adotado**: canais externos exigem conta, token, endpoint público e consentimento (ver `PROACTIVITY_DESIGN.md` §6) | — |
| `packages/computer` (desktop em microVM), `gateway`, `cli`, `server` | **Não adotados**: outra arquitetura de execução e hospedagem | — |
| `packages/apps` (Composio) | **Não adotado**: integra serviços de terceiros | — |
| `packages/network` (convites, protocolo entre agentes) | **Parcial**: camadas e concessões sim; convites e protocolo não (precisam de canal) | — |
| `skills/` (playbooks) | **Não adotado**: a Wendy já tem um registro de skills com contrato e testes | — |

## Diferenças deliberadas (a Wendy pergunta mais, nunca menos)
1. Capacidade desconhecida é negada; camada desconhecida vira `stranger`.
2. `apps.use` pergunta para todos, menos o dono (qualquer coisa que sai da máquina é EXTERNAL e sempre pergunta).
3. Uma concessão nunca vira "executa sozinho"; no gasto continua valendo a política de gasto.
4. `partner` não tem `calendar.read` (a tabela de capacidades diz só dono; o texto das camadas é mais frouxo).
5. Pagamento nunca é automático, qualquer que seja a camada (testado em todas as combinações).

## Mascaramento de cartão (`src/security/cardRedaction.ts`) — melhor esforço, sem garantia universal
Não é garantia de conformidade (PCI ou outra) nem prova de que nenhum cartão foi gravado. Reduz vazamento acidental nos destinos listados.

**Como reconhece (só o trecho encontrado é trocado por `[cartão ocultado]`; o texto original não é normalizado):**
1. **Contextual (evidência forte):** número logo após um rótulo (`cartão`, `card number`, `credit card`, `cc`, `pan`…), mesmo sem Luhn e com emissor desconhecido; código de segurança após `CVC/CVV/CVC2/CVV2/CID/security code/código de segurança/card verification value`; validade após `exp/expires/expiry date/validade/vencimento/venc./val./valid thru/MM/YY` (e `exp_month/exp_year`). Valor malformado ao lado do rótulo (`cvc: 12`, `cvv: abc`) não apaga o texto.
2. **Sem rótulo, agrupado:** 13–19 dígitos em grupos de formato de cartão (4-4-4-4, 4-6-5, 4-6-4…) separados por 1–3 caracteres (espaço, tab, NBSP, hífen, ponto, barra, quebra de linha, largura zero) **e** Luhn válido.
3. **Sem rótulo, contíguo ou dígito a dígito:** exige Luhn **e** prefixo de rede conhecida (tabela parcial, sinal adicional, não é lista completa nem universal).
Dígitos de largura total e árabe-índicos são reconhecidos dígito a dígito. Luhn nunca é prova isolada para o caso 1; nos casos 2–3 é só um dos sinais.

**Medição** (sintética, determinística, `tests/helpers/cardCorpus.ts`): positivos = 240 números Luhn-válidos em 12 famílias de rede (20 cada) + 100 de emissor desconhecido; negativos = 12 conjuntos de 2 000 (timestamp ms, celular BR +55, CNPJ com e sem máscara, telefone formatado, id aleatório de 16 e de 19 dígitos, id de 16 dígitos Luhn-válido, timestamp de 13 dígitos Luhn-válido, UUID, ISO, decimal). Resultado:

| Estratégia | Vazamentos (240 positivos conhecidos) | Falsos positivos |
|---|---|---|
| A: só contextual (`{unlabeled:false}`) | 240/240 sem rótulo (inclui JSON `"number":"…"`); 0 com rótulo | 0 em todos os 12 conjuntos |
| B: contextual + sem rótulo (**padrão**) | 0/240 em contíguo, agrupado, hífen-adjacente, rotulado e JSON | 0 em 7 conjuntos; CNPJ sem máscara 7/2 000; decimal 10/2 000; id 16 dígitos 59/2 000; id 19 dígitos 41/2 000; id 16 Luhn-válido ≈ 30% (indistinguível de cartão) |
| Regra anterior (Luhn puro) | vazava todo número colado a hífen | ≈ 8–12% nos conjuntos aleatórios |

**Não coberto (documentado e fixado em teste):** conteúdo codificado (Base64, URL-encoding, hex), números por extenso, número dividido em mensagens/campos, cartões de ≤ 12 dígitos, dígitos dentro de sequência de 20+ dígitos, dígitos de outras escritas além de ASCII/largura total/árabe-índico, CVC e validade sem rótulo, número de emissor fora da tabela **sem** rótulo e **sem** agrupamento (100/100 vazam). Máscaras parciais (`4111 11** **** 1111`, "final 1111") ficam como estão.

**Falsos positivos conhecidos:** qualquer número de 13–19 dígitos Luhn-válido com prefixo de rede conhecida é ocultado (ex.: ids, pedidos, timestamps de 13 dígitos podem coincidir); o mascaramento é idempotente, mas não é reversível.

**Destinos protegidos (verificados por teste, Fases 1.3.15 e 1.3.16):**
- `recordedError` → `model_calls.error`; `loggableError` → `console.error` (mascara antes de cortar em 400 caracteres).
- `chat_messages.content` e os argumentos de `tool_calls` (`saveMessages`), `model_calls.input` e `model_calls.output` (`maskCardDeep`: mascara cada valor de texto, não o JSON serializado, porque `\n` escapado deixaria de ser separador) e `skill_executions.error` (`toExecutionError`, todos os tipos de erro).
- Os `console.error` diretos do worker (4 pontos) e do agente (retomada de skills e log de conversa) agora passam por `loggableError`. Sem teste automatizado próprio: verificação por revisão do código e `tsc`.
- **Efeito colateral deliberado:** o que fica gravado da conversa já não é o texto original; o histórico reexibido e o que uma skill lê pelo `messageId` mostram `[cartão ocultado]`. O que já estava gravado antes desta fase **continua em claro** (nenhuma limpeza foi feita; exigiria decisão e backup à parte).

**Destinos NÃO protegidos:** `captured_sources`, `events`, `memories`, payload do ledger, qualquer outro texto gravado fora dos pontos acima, o texto que o modelo recebe durante a própria execução (só o registro é mascarado) e dados já gravados. O reconhecimento continua de melhor esforço (formatos não cobertos acima; `\n` escapado dentro de uma string já serializada não é separador).

## Limites conhecidos
- Falsos positivos e vazamentos do mascaramento de cartão: ver a seção acima (substitui a estimativa anterior de "1 em 10", que era imprecisa).
- As listas de comerciantes comparam o nome normalizado (sem acento, minúsculas); não cobrem variações de grafia.
- Nada disso protege um canal que ainda não existe.
