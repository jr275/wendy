# WENDY — Medição da busca (recall@10)

Gerado por `npm run eval:retrieval` em 2026-10-07. **Corpus sintético** (`fixtures/retrievalEval.ts`): 19 perguntas sobre 26 registros em português e inglês (mensagens, reuniões, compromissos e memórias).

Mede a busca textual **atual**: as mesmas funções que o núcleo usa, sem nenhuma mudança. Cada tipo de registro é buscado com limite 10 e sem filtro de data, para isolar a parte textual. As colunas mudam apenas **de onde vêm os termos de busca**:

- **Literal:** as palavras como a pessoa escreveria. É o **piso**.
- **Como o prompt pede:** variantes, sinônimos e as duas línguas, que é o que o prompt de entendimento pede ao Claude. **Atenção:** escrevi esses termos à mão, conhecendo o corpus, então é um **teto otimista**, não uma medição do Claude.
- **Claude real:** os termos que o passo de entendimento do Claude realmente gera para cada pergunta. **BLOCKED** (sem saldo de API): rode `npm run eval:retrieval -- --claude` quando houver crédito.

## Resultado

| | Literal (piso) | Como o prompt pede (teto) | Claude real |
|---|---|---|---|
| **Geral** | **42%** | **100%** | **BLOCKED** |
| exato (4) | 92% | 100% | — |
| flexão (4) | 75% | 100% | — |
| acento (2) | 63% | 100% | — |
| sinônimo (3) | 0% | 100% | — |
| tradução (3) | 0% | 100% | — |
| paráfrase (3) | 0% | 100% | — |

## O que isso significa

- **Piso:** ABAIXO do critério (0,8). Desde a migração 004, a busca ignora acentos e reduz palavras à raiz em português e inglês ("propostas" acha "proposta", "preco" acha "preço"). Ela continua lexical: não conhece sinônimos e não traduz. O que ainda falha em "flexão" e "acento" é, na prática, tradução ("renovações" × "renewal", "precos" × "pricing").
- **Teto:** acima do critério (0,8). Se o Claude expandir os termos como o prompt pede, a busca textual basta para este corpus.
- **Decisão do 3.4 (pgvector):** ainda **não dá para decidir**. Tudo depende de quanto o Claude expande os termos, e isso só a coluna "Claude real" mede.
- **Sinônimos, traduções e paráfrases** dependem dos termos que o Claude gera, ou de busca vetorial (pgvector). A coluna "Claude real" decide entre os dois.
- **Limite desta medição:** o corpus é sintético e pequeno. Com a importação dos seus dados reais (`npm run import`), dá para repetir a medição com perguntas suas.

## Por pergunta

| Categoria | Pergunta | Esperado | Literal | Como o prompt pede | Claude real |
|---|---|---|---|---|---|
| exato | Qual o status do pricing com o Carlos? | M1, MT1, C1 | 100% | 100% | — |
| exato | O que mudou no term sheet? | M15 | 100% | 100% | — |
| exato | Como está a auditoria? | M6, MT3, C3 | 67% (faltou MT3) | 100% | — |
| exato | Como o Carlos gosta de receber mensagens? | MEM1 | 100% | 100% | — |
| flexão | Quais propostas estão abertas? | M3, C2 | 100% | 100% | — |
| flexão | O que temos de renovações? | M1, M2, M17 | 33% (faltou M1, M2) | 100% | — |
| flexão | Which discounts did we offer? | M1, M2, M3 | 67% (faltou M3) | 100% | — |
| flexão | Novidades sobre investimentos? | M10 | 100% | 100% | — |
| acento | Quais os precos combinados? | M1, M3, MT1, C1 | 25% (faltou M1, MT1, C1) | 100% | — |
| acento | Quando é a reunião do conselho? | M13, MT2 | 100% | 100% | — |
| sinônimo | Como está o acordo com a Horizon? | M4, M17 | 0% (faltou M4, M17) | 100% | — |
| sinônimo | Tem algum boleto atrasado? | M9, M16 | 0% (faltou M9, M16) | 100% | — |
| sinônimo | Qual o valuation atual? | M15 | 0% (faltou M15) | 100% | — |
| tradução | What is the budget for next year? | M11 | 0% (faltou M11) | 100% | — |
| tradução | Any news on data residency? | M5, MEM2 | 0% (faltou M5, MEM2) | 100% | — |
| tradução | Quais vagas vamos abrir? | M12 | 0% (faltou M12) | 100% | — |
| paráfrase | Alguém está cobrando um pagamento? | M9, M16 | 0% (faltou M9, M16) | 100% | — |
| paráfrase | Quando vamos para a nova sede? | M7, M8 | 0% (faltou M7, M8) | 100% | — |
| paráfrase | Quem cuida da proteção de dados dos clientes? | M5, MEM2 | 0% (faltou M5, MEM2) | 100% | — |
