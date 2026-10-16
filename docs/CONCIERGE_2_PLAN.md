# Wendy Personal Concierge 2.0 — auditoria (Fase 0) e plano

Atualizado em 16/out/2026. Auditoria **somente leitura**, feita antes de qualquer alteração. Decisões de aprovação do João estão na seção F. Regra geral: uma fase por vez, com teste e relatório; nada de commit, push, deploy, compra, transação ou mensagem externa sem autorização expressa.

## A. O que existe hoje

| Área | Estado real | Evidência |
|---|---|---|
| Contatos | 16 pessoas, nenhum "Alexandre". `people` não tem telefone, mas `person_identifiers` (tipo + valor) aceita `phone` sem mudar o esquema (hoje só `email`). Pessoas só nascem por ingestão (`src/events/world.ts`). `PeopleService` só tem `setImportance`. | banco, código |
| Tarefas | Título, notas, prazo, estado `OPEN/DONE/DELETED`; skill `task-management` (listar, criar, concluir, apagar, com aprovação). Faltam prioridade, categoria, contexto, etapas, adiar, delegar, arquivar, detecção de paradas. | `tasks`, `src/skills/builtin/taskManagement.ts` |
| Memória | `PROPOSED/ACTIVE/SUPERSEDED/RETRACTED`, `evidence`, confirmar e retratar na tela Memória, peso de frescor. Faltam fato × hipótese e política de retenção. | `memories` |
| Gmail | Somente leitura (`gmail.readonly`); 90 dias importados (41 recebidos, 27 enviados) com **corpo armazenado e sem retenção**. Sem classificação, rascunhos, acompanhamento ou envio. | `src/sensors/google/` |
| Envio de e-mail | Só o `DevMailbox` (grava em `dev_outbound_mail`; nada sai). | `src/providers/devMailbox.ts` |
| Agenda | Somente leitura (`calendar.readonly`); 10 reuniões. Não escreve no Google. | `GOOGLE_SCOPES` |
| Agendador | Reutilizável (um por período, `lease`, tentativas, ledger). A chave é a data local e o tipo da rotina é uma lista fixa (`CHECK`). Não há rotina das 21h. | migrations 009/010 |
| Notificação ativa | Não existe canal (só dentro do app). | código |
| Briefing de IA | DeepMind, Google AI e OpenAI já são lidos pelo resumo diário. Faltam Eminem, Senna, Hinton, o modelo de e-mail e a prévia. | `src/research/` |
| Voz | Web Speech do navegador é real (relato do usuário; testada só por simulação). Não há provedor de voz de servidor (`VOICE_PROVIDER` não definido; só o simulado). | `src/voice/provider.ts` |
| Spline | Cena "Wendy Orb" publicada; falta o endereço do arquivo `scene.splinecode`. O registro aceita cenas com 2D de reserva. | `web/lib/characters.ts` |
| Conteúdo não confiável | Regra `UNTRUSTED_RULE` para páginas e documentos; nenhum texto equivalente no caminho dos e-mails na cognição (a confirmar com testes). | `src/skills/prompts.ts` |
| Maps, saúde, finanças, astrologia, ideias, relacionamentos | Nada implementado. Maps exige chave e cobrança (adiado). | busca no código |

## B. Dependências externas
1. Envio real de e-mail: Gmail API de envio (novo escopo), SMTP/serviço transacional ou só prévia. **Decisão: só prévia.**
2. Rascunhos no Gmail exigem `gmail.compose`. **Decisão: rascunhos só na Wendy.**
3. Aviso ativo às 21h exige canal de notificação. **Decisão: só dentro do app.**
4. Escrever na agenda exige escopo novo. **Decisão: só sugerir.**
5. Deslocamento (Maps): adiado (chave e cobrança).
6. Mapa astral completo exige biblioteca de efemérides (a confirmar). Signo solar e compatibilidade básica não.
7. Notícias sobre pessoas: Google News RSS e GDELT responderam; a API do arXiv limita a taxa (429). Nenhuma garante "fonte oficial": a Wendy classifica o nível da fonte e rotula repercussão.

## C. Plano por fase

| Fase | Entrega | Dados | Aceitação (resumo) |
|---|---|---|---|
| 1 | Contato Alexandre; tarefas melhoradas; rotinas por período | Migration 011 pequena | ver seção D |
| 2 | Briefing de IA (prévia); triagem e rascunhos locais de Gmail | tabelas de briefing e triagem | 10 seções, "Nenhuma novidade relevante" quando vazio, fontes e datas, sem envio; instruções em e-mails não executam nada |
| 3 | Agenda inteligente; planejamento às 21h | nenhuma | sobrecarga e conflitos com dados reais; lembretes em camadas; fuso `America/Sao_Paulo`; nada aceito/cancelado/remarcado sozinho |
| 4 | Memória contextual, relacionamentos, astrologia | marca fato/hipótese/desatualizado | "De onde você tirou isso?" responde origem e data; até 3 sugestões de mensagem, sem manipulação; signo sem exigir dados |
| 5 | Saúde, documentos, finanças | tabelas separadas, retenção, log sem dados de saúde | lembrete de medicamento só com nome, instrução e horário confirmados; anomalia sempre "possível" |
| 6 | Voz e interface | nenhuma | cena Spline sob demanda com 2D de reserva; estados da interface ligados ao estado real |

## D. Fase 1 em detalhe
- **Contato:** `contacts.find` (leitura) e `contacts.save` (escrita com aprovação). Telefone normalizado em `person_identifiers` (`kind='phone'`); contexto e notas em `relationships.notes` (acrescentadas com data); **nada inventado** (sem sobrenome, e-mail, empresa). Deduplicação por telefone normalizado e, na falta dele, por nome exato; suspeita de duplicidade pede confirmação. Busca por nome, telefone ou contexto. Nunca envia mensagem nem liga.
- **Tarefas:** prioridade e categoria, adiar (`snoozed_until`), arquivar (`ARCHIVED`); a Wendy não cria prazo que o usuário não disse.
- **Rotinas:** cadência `daily|weekly|monthly`, com dia da semana ou do mês; a chave de idempotência passa a ser o **início do período** (em `America/Sao_Paulo`), com recuperação se o Mac estava desligado; o tipo da rotina deixa de ser lista fixa no banco e passa a ser validado no código.
- **Migration 011:** aditiva e reversível (reversão no cabeçalho do arquivo); backup antes, teste em banco isolado, aplicação só depois.

## E. Riscos
- O Gmail guarda corpos sem retenção: definir a política **antes** de ler mais (fases 2 e 4).
- Dados de saúde exigem separação e outra proteção em logs (fase 5). Se a Wendy migrar para o servidor, as fases 5 e 6 devem esperar essa decisão.
- Relacionamentos e saúde envolvem terceiros: usar só o que o usuário fornecer e nunca inferir informação sensível.

## F. Aprovações do João (16/out/2026)
1. Iniciar a Fase 1, com a migration pequena descrita. **Aprovado.**
2. Briefing por e-mail só com prévia, sem envio real. **Aprovado.**
3. Rascunhos e agenda só dentro da Wendy, sem escopos novos do Google. **Aprovado.**
4. Canal das 21h só dentro do app. **Aprovado.**
5. Guardar este plano no repositório. **Aprovado.**
