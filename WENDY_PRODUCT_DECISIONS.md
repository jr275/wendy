# WENDY — Decisões de produto pendentes

> **Proposta pré-preenchida (2026-10-06), aguardando confirmação.** Você pediu "faz tudo", então a tabela abaixo traz as minhas recomendações (★). **Nada disto foi decidido por você ainda.** O plano da Fase 2 (`WENDY_PHASE_2_PLAN.md`) trata estes itens como *premissas*, e cada uma está marcada lá. Para confirmar, responda "confirmo" ou diga o que muda.
>
> | # | Proposta | Status |
> |---|---|---|
> | 1 | Wendy trabalha só para João Mendes no início; fuso `America/Sao_Paulo`; insights em `pt-BR` | aguardando confirmação |
> | 2 | Primeiros sensores: Gmail + Google Calendar, **só leitura**, 90 dias de histórico; conta: **a definir** (Workspace ou pessoal) | aguardando confirmação |
> | 3 | Postgres local neste Mac durante a validação; texto completo do e-mail vai para o Claude; lista de exclusão **a definir**; retenção total durante a validação | aguardando confirmação |
> | 4 | Autonomia: briefing e rascunho automáticos; enviar e-mail, criar/alterar/cancelar reunião pedem aprovação; nada financeiro | aguardando confirmação |
> | 5 | Página local como canal, imediato para urgente + resumo diário de manhã; até 5 interrupções por dia; horário silencioso **a definir** | aguardando confirmação |
> | 6 | Você lista de 10 a 20 pessoas-chave com importância alta ou média — **a lista é sua, eu não tenho como inventar** | aguardando a lista |
> | 7 | Preferências deduzidas pela Wendy entram como **proposta**, e você confirma | aguardando confirmação |
> | 8 | Opus 5.5 em todas as etapas até medir o custo real; teto mensal **a definir** | aguardando confirmação |
> | 9 | Roda neste Mac durante a validação; servidor 24h na fase de inteligência contínua | aguardando confirmação |

Essas decisões não bloqueiam o gate da Fase 1, mas definem como serão a Fase 2 e as seguintes. Marque um `[x]` por pergunta, ou escreva outra resposta. ★ = minha recomendação.

---

## 1. Para quem a Wendy trabalha
- [ ] ★ Só para você, João, no início (um único executivo, com dados reais seus)
- [ ] Você e mais pessoas desde já (o sistema já separa os executivos, mas aumenta o escopo de testes e de privacidade)

Dados do executivo: nome, e-mail principal, fuso (`America/Sao_Paulo`?) e idioma dos insights (`pt-BR`?).

## 2. Primeira fonte real de sinais (Fase 5/6)
- [ ] ★ Gmail em **modo só leitura** (é onde está a maior parte do contexto: pessoas, compromissos, urgência)
- [ ] Google Calendar em modo só leitura (reuniões, participantes, preparação)
- [ ] ★ Os dois juntos, ambos só leitura (o caso "e-mail urgente + reunião amanhã" só aparece com os dois)

Conta: [ ] Google Workspace (empresa) · [ ] Gmail pessoal

Histórico importado na primeira carga: [ ] 30 dias · [ ] ★ 90 dias · [ ] 1 ano

## 3. Onde os dados ficam e o que vai para o Claude
- Banco: [ ] ★ Postgres local neste Mac por enquanto · [ ] servidor na nuvem
- Conteúdo enviado ao Claude: [ ] ★ texto completo do e-mail, para que o raciocínio seja bom · [ ] só assunto e trechos
- Excluir da Wendy (nunca ler): ____________ (marcadores, domínios ou remetentes, por exemplo bancos, saúde)
- Retenção: [ ] ★ manter tudo enquanto o projeto estiver em validação · [ ] apagar após ___ dias

## 4. Autonomia: o que a Wendy faz sozinha
| Ação | Sozinha | Pede aprovação | Nunca |
|---|---|---|---|
| Preparar briefing interno | ★ | | |
| Escrever rascunho de e-mail (fica como rascunho) | ★ | | |
| Enviar e-mail | | ★ | |
| Criar ou alterar evento no calendário | | ★ | |
| Cancelar reunião | | ★ | |
| Lembrete só para você | ★ | | |
| Qualquer ação financeira | | | ★ |

Princípio já implementado: quanto maior o impacto, mais autorização é exigida. Hoje, briefing é automático e envio de e-mail sempre pede aprovação.

## 5. Como a Wendy aparece para você (antes do AG-UI)
- Canal do primeiro insight: [ ] ★ página local (evolução do inspetor) · [ ] e-mail de resumo · [ ] notificação no celular (depois)
- Ritmo: [ ] ★ imediato para o que é urgente, mais um resumo diário (manhã) para o resto · [ ] só o resumo diário
- Horário silencioso: das ___ às ___
- Limite de interrupções por dia: [ ] ★ no máximo 5 · [ ] sem limite

## 6. Pessoas importantes
O fator "importância" do salience vem do que **você** define; a Wendy não chuta.
- [ ] ★ Você lista de 10 a 20 pessoas-chave com importância (alta/média) para começar
- [ ] Importar dos contatos e deixar a importância ser aprendida pelas interações (mais lento para ficar bom)

## 7. Memória
- Preferências que a Wendy *deduz* (ex.: "fulano prefere mensagens curtas"):
  - [ ] Gravar direto, com a evidência (como é hoje)
  - [ ] ★ Gravar como "proposta" e você confirma ou descarta
- Você pode ditar fatos e preferências por nota: [ ] ★ sim (já implementado)

## 8. Custo do Claude
- Modelo: [ ] ★ Claude Opus 5.5 em todas as etapas (atual) · [ ] avaliar um modelo mais barato só para a etapa de entendimento, depois de medir a qualidade
- Teto mensal de gasto: US$ ____ (vou medir o custo real por evento assim que houver saldo, antes de qualquer integração)

## 9. Onde a Wendy roda
- [ ] ★ Neste Mac durante a validação (o worker só funciona com o Mac ligado)
- [ ] Servidor sempre ligado (necessário para ela ser realmente proativa 24h; Fase 7)

---

**Próximo passo depois do gate:** com as respostas 1, 2, 3 e 6 eu consigo planejar a Fase 2 (memória e contexto) já pensando nos sensores reais, sem retrabalho.
