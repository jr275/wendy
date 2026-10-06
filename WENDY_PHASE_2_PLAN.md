# WENDY — Plano da Fase 2 (Memória persistente + Contexto)

**Status:** rascunho para aprovação. **Não começa** antes de o gate da Fase 1 dar `READY FOR PHASE 2` com o Claude real.
**Premissas** vêm de `WENDY_PRODUCT_DECISIONS.md` e ainda não foram confirmadas. Cada uma aparece marcada como **[P#]**.

---

## 1. Objetivo

A Wendy precisa **lembrar direito**: o que ela sabe sobre cada pessoa tem que ser verdadeiro, ter fonte, ser corrigível e aparecer no raciocínio certo, no momento certo.

Ao final da fase, a pergunta "Como devo responder ao Carlos?", feita meses depois, deve ser respondida a partir de memória confirmada, com a fonte original. Se as fontes conflitarem, isso deve aparecer na resposta. Nunca por código específico.

## 2. Ponto de partida (o que já existe)

- **Memória:** tabela `memories` com os tipos PREFERENCE, FACT, EPISODE e OUTCOME, evidência por registro e busca textual.
- **Escrita:** memórias propostas pelo Claude e validadas pelo código. Decisões do executivo viram OUTCOME.
- **Recuperação:** por pessoa, por termos e preferências gerais do executivo.
- **Conflitos:** só são **apresentados**, não resolvidos.

## 3. Entregas

### 3.1 Ciclo de vida da memória, com o executivo no circuito [P7]
- **Estados:** `PROPOSED → ACTIVE → SUPERSEDED | RETRACTED`. O que a Wendy deduz entra como `PROPOSED` e só vira `ACTIVE` com sua confirmação. O que você dita entra direto como `ACTIVE`.
- **Supersessão:** uma memória nova que contradiz outra gera um *conflito pendente*. Você escolhe qual vale, e a outra vira `SUPERSEDED` com o vínculo registrado.
- **Confirmação temporal:** `last_confirmed_at` e uma meia-vida por tipo. Preferências antigas pesam menos até serem reconfirmadas.
- **Auditoria:** toda mudança de estado vai para o ledger.

### 3.2 Relações derivadas de interações (fim dos números escritos à mão)
- **Métricas:** cadência, última interação, reciprocidade (quem responde e quanto demora) e tendência de 30 contra 90 dias, todas calculadas a partir de `messages` e `meetings`.
- **Importância:** a importância definida por você continua soberana. As métricas derivadas entram como fatores separados no salience.
- **Base para depois:** isso prepara a detecção de mudança humana da Fase 8 ("respostas mais lentas, duas reuniões canceladas").

### 3.3 Compromissos extraídos de mensagens
- **Extração:** a etapa de entendimento passa a extrair *promessas* ("vou te mandar X até Y") com citação literal e prazo resolvido.
- **Entrada:** o compromisso entra como `PROPOSED`, ligado à mensagem de origem, e você confirma ou descarta.
- **Conclusão:** ela é inferida por evidência (uma mensagem de saída que cumpre a promessa) e também fica `PROPOSED` até a confirmação.

### 3.4 Recuperação semântica (pgvector), só se a medição mostrar necessidade
- **Medição primeiro:** um conjunto de avaliação de recuperação, com perguntas e os registros que deveriam voltar, medido com a busca textual atual.
- **Critério:** se o recall@10 ficar abaixo de 0,8, entra pgvector com embeddings de mensagens, memórias e compromissos, numa busca híbrida (textual + vetorial). Se ficar acima, não entra.

### 3.5 Calibração do salience pelo seu feedback
- **Sinais:** aprovou, editou, rejeitou e "isso não importa" viram dados de calibração. Os pesos continuam constantes de política, mas passam a ser ajustados por relatório e revisados por você. Não há ajuste automático silencioso.
- **Pré-requisito:** a API de aprovação (3.6).

### 3.6 API mínima de escrita com autenticação (pré-requisito da interface)
- **Endpoints:** aprovar, rejeitar e editar ações; confirmar e descartar memórias e compromissos; editar pessoas importantes e a política de autonomia.
- **Proteções:** sessão local autenticada, proteção contra CSRF, cada escrita auditada e escopo por executivo.
- **Interface:** os botões hoje desativados (Aceitar, Modificar, Salvar) passam a funcionar.

## 4. Testes e critérios de saída

**Determinísticos:**
- Transições de memória e supersessão.
- Métricas de relação calculadas a partir de interações sintéticas.
- Compromisso proposto → confirmado → concluído.
- API de escrita: autenticação, CSRF, auditoria e isolamento por executivo.

**Live (Claude real):**
1. **Preferência:** a nota "Carlos prefere mensagens curtas", seguida de um restart, é usada na resposta e no rascunho, e a fonte aparece.
2. **Conflito:** duas preferências contraditórias geram um conflito pendente. Depois de você escolher uma, só ela é usada.
3. **Promessa em e-mail:** "vou te enviar a proposta até sexta" vira um compromisso proposto, com citação literal, e o detector o encontra perto do prazo.
4. **Metamórfico:** os mesmos casos com outra pessoa, outro assunto e outro idioma.

**Critério de saída:** todos passam, o scan anti-hardcode está limpo e o relatório da Fase 2 está publicado com PASS, FAIL ou BLOCKED por item.

## 5. Sequência das fases seguintes (resumo)

| Fase | Foco | Depende de |
|---|---|---|
| 3 | Antecipação + Future Radar (próximos 7 dias), briefing antes de cada reunião, alertas antecipados | 2 |
| 4 | Ações completas: mais tipos (rascunho no provedor, sugestão de reunião), expiração e cancelamento por mudança de contexto, verificação por leitura de volta no provedor real | 2 (3.6) |
| 5 | AG-UI / CopilotKit + Claude Agent SDK como camada de conversa sobre o cérebro (ferramentas = consultas e propostas) | 3, 4 |
| 6 | **Google Workspace, só leitura** [P2]: Gmail e Calendar com sync incremental, deduplicação por ID externo, histórico de 90 dias e lista de exclusão [P3]. Rascunhos no Gmail só depois, e envio só com aprovação [P4] | 4 |
| 7 | Inteligência contínua: worker 24h fora do Mac [P9], filas, limites e custo controlado [P8] | 6 |
| 8–10 | Relações e organização, Serendipity, presença (voz/avatar) | 7 |

### Notas de desenho para o Google (fase 6)
- **Escopos:** só leitura (`gmail.readonly`, `calendar.readonly`). Os escopos de escrita só entram junto com a política de aprovação.
- **Interface do provedor:** os provedores implementam as interfaces que já existem em `src/providers/interfaces.ts`. O cérebro não muda.
- **Idempotência:** o envio, quando existir, grava a chave de idempotência em um header da mensagem e verifica por busca, como o provedor local já faz.
- **Credenciais:** tokens OAuth guardados com criptografia em repouso e revogáveis pela interface.

## 6. Riscos

- **Custo do Claude** com histórico real de 90 dias → medir o custo por evento no gate e definir o teto [P8] antes da fase 6.
- **Privacidade** (texto completo enviado ao Claude) → lista de exclusão [P3] antes de ligar o Gmail.
- **Excesso de propostas para confirmar** → agrupar as confirmações no resumo diário [P5].
