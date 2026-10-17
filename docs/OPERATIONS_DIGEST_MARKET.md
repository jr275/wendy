# Operação: resumo de ML/IA e monitor de mercado

Atualizado em 16/out/2026. Duas rotinas diárias que rodam no **worker** (`npm run worker`), só com o Mac ligado. Esquema do banco: `docs/DAILY_ROUTINES_SCHEMA.md` (migrations 009 e 010).

## Como funcionam (as duas)
- O worker verifica a cada 60 s (`WENDY_ROUTINES_CHECK_MS`). Cada rotina roda **no máximo uma vez por dia local** (`routine_runs`, chave `(rotina, data)`), mesmo com dois processos ao mesmo tempo.
- Execução que travou é retomada quando o `lease` expira (10 min); falha tenta de novo após 15 min, no máximo 3 vezes no dia.
- O ledger recebe `ROUTINE_RUN_STARTED/FINISHED/FAILED` **só com contagens**, nunca com o conteúdo.
- Erros são gravados com segredos mascarados.
- Se o Mac estava desligado no horário, a rotina roda quando ele voltar, se ainda for o mesmo dia.

## Resumo de ML e IA (`research_digest`, 07:30 São Paulo)
- **Fontes:** 13 feeds públicos (`src/research/sources.ts`): arXiv cs.LG e cs.AI, DeepMind, Google AI, OpenAI, Hugging Face, BAIR, The Gradient, Import AI, Raschka, Lilian Weng, Quanta, MIT Technology Review. Só `https`, hosts permitidos, redirecionamentos revalidados, limite de 3 MB.
- **Escolha:** regra determinística e explicada (recência + peso da fonte + temas; vagas reservadas para papers; sem duplicados). **O resumo é o trecho do resumo da própria fonte**, rotulado assim. Nenhum modelo é chamado.
- **Onde ver:** cartão "Leituras do dia" na Home; chat ("o que saiu de novo em ML?", skill `research-digest`).
- **Agora:** botão "Atualizar agora" ou `npx tsx scripts/digest-now.ts` (ainda vale uma execução por dia local).
- **Teste sem gravar nada:** `npx tsx scripts/digest-dry-run.ts`.
- **Mudar horário/pausar:** `UPDATE routines SET local_time='08:00' WHERE kind='research_digest';` / `UPDATE routines SET enabled=false WHERE kind='research_digest';`.

## Monitor de mercado (`market_watch`, dias úteis 18:30 São Paulo)
- **É monitoramento, não consultoria:** nunca diz comprar/vender, não dá preço-alvo nem probabilidade e **não faz ordens**. A informação tem atraso (~30 min) e usa candles diários.
- **Ativos:** as 300 maiores ações da B3 **por valor de mercado** (lista renovada a cada 7 dias) + a lista de tecnologia dos EUA em `config/market-watch.json` (exemplo em `config/market-watch.example.json`). Ativos com mediana de valor negociado abaixo de 1 milhão (R$/US$) são ignorados: a estatística não vale neles.
- **Sinais (último candle contra os anteriores):** variação fora do comum (z-score robusto ≥ 3,5), volume ≥ 3× a mediana de 20 pregões, amplitude ≥ 2,5× o ATR de 14 dias. Mesmo candle e mesmo tipo alertam uma vez; cooldown de 6 h.
- **brapi (plano gratuito):** 1 ativo por requisição, 15.000 requisições por 30 dias móveis. A varredura gasta ~330 por dia útil (~7.000 por mês). O limite de requisições é tratado (espera 65 s e tenta uma vez). O limite de 400 ativos por varredura protege a cota.
- **Token:** `~/.wendy/brapi-token`, modo 600, enviado em cabeçalho (nunca na URL), nunca no banco nem em log. Se o arquivo estiver legível por outras contas, a Wendy recusa usar: `chmod 600 ~/.wendy/brapi-token`.
- **Onde ver:** cartão "Mercado" na Home (os casos mais fortes dos últimos 7 dias); chat ("o que o mercado mostrou?", skill `market-watch`).
- **Agora:** `npx tsx scripts/market-now.ts` (gasta ~330 requisições). Consulta de um ativo só: `npx tsx scripts/market-probe.ts PETR4`.

## Tela do Mercado (`/mercado`, `/mercado/<ativo>`) — 16/out/2026
- **Panorama:** Ibovespa e um ETF do Nasdaq-100 (QQQ) como referências, com mini-gráfico, e um parágrafo montado só com números guardados (sem modelo, sem "por quê", sem "o que fazer"). **O dólar não aparece**: o câmbio exige o plano pago da brapi.
- **Maiores altas e quedas** entre os seus ativos, ignorando os de volume muito baixo; uma alta nunca aparece como queda.
- **Gráfico por ativo:** candles diários (corpo vazio = alta, cheio = queda, sem depender só de cor), volume, marcador nos dias com observação, 1 mês ou 3 meses, e tabela com os mesmos números.
- **Histórico de alertas** dos últimos 30 dias, com número e explicação, e **lista editável**: adicionar valida o código com 1 consulta à brapi e já guarda o histórico; remover é permanente (sobrevive à atualização semanal); "restaurar" traz de volta.
- **Cota:** a tela mostra quantas consultas cada verificação usa e a estimativa mensal contra as 15.000 do plano gratuito. Limite de 398 ativos.
- **Candles guardados:** a varredura passou a guardar o histórico que já baixava (sem consultas extras); `npx tsx scripts/market-backfill.ts PETR4 …` busca o histórico de ativos já na lista (1 consulta por ativo), útil antes da próxima verificação. Migration `012_market_view.sql`.

## Contatos e importação (Concierge, Fase 1)
- Salvar e buscar contatos pelo chat (skill `contact-management`), sempre com aprovação e só com o que você disse.
- **Importar uma agenda em CSV** (Google Contatos): copie o arquivo para `~/Wendy/Importar` e rode `npx tsx scripts/contacts-import.ts --file "caminho.csv" [--default-area 21]` (simula, sem gravar). Com `--propose` o lote entra na fila de aprovação (um cartão com as contagens). Só nome e telefone são lidos; número sem código do país ou sem DDD **não é completado por chute** (só com `--default-area`); o relatório das linhas de fora fica ao lado do arquivo (modo 600).

## Subir tudo no Mac
`./scripts/dev-up.sh` inicia o que não estiver rodando (agente 3458, inspetor 3457, worker e site 3010), sem duplicar. Logs em `~/Wendy/logs`. Os processos iniciados por uma sessão do app morrem quando ela reinicia; este comando os sobe de novo.

## Migrations
O worker e os scripts que apontam para o banco real **não aplicam migrations sozinhos**: com uma pendente, recusam iniciar e dizem o que fazer (backup, depois `npm run migrate`). `WENDY_AUTO_MIGRATE=1` restaura o comportamento antigo.

## Quando algo não aparece
| Sintoma | Causa provável |
|---|---|
| Cartão vazio no site publicado | O site da Vercel roda em modo demonstração, sem agente: só tem dados na sua máquina |
| Nada rodou no horário | Mac dormindo/desligado, ou worker parado (`pgrep -fl workerCli`) |
| Mercado: "sem token" | `~/.wendy/brapi-token` ausente ou token inválido |
| Mercado: "a brapi limitou" | Cota ou taxa; a execução tenta de novo em 15 min |
| Resumo: fonte sem resposta | A nota da execução lista quais; as outras seguem |

## Reverter
Rotinas: `UPDATE routines SET enabled=false;`. Migrations: o cabeçalho de `009_routines.sql` e `010_market_watch.sql` traz a ordem de remoção. Backups antes de cada uma em `~/wendy-backups/`.

## Briefing de IA (prévia) e retenção de e-mails
- Ver: abra `/briefing` no app (7, 14 ou 30 dias) ou rode `npx tsx scripts/briefing-preview.ts [--days 7]` (salva `~/Wendy/Briefing/briefing-<data>.html`, modo 600). Lê só feeds públicos; nada é enviado.
- Contar corpos de e-mail que a política esvaziaria (não altera nada): `npx tsx scripts/mail-retention.ts --days 180`.
- Esvaziar de verdade (irreversível; faça backup antes): `npx tsx scripts/mail-retention.ts --days 180 --apply --yes`.

## Agenda
- Abra `/agenda` no app (7, 14 ou 30 dias). Só lê e sugere; não escreve no Google.

## Depois de reiniciar o Mac: o banco não sobe
Se tudo der "conexão recusada" na porta 5432, veja `tail /opt/homebrew/var/log/postgresql@16.log`. Se aparecer `lock file "postmaster.pid" already exists` apontando para um processo que NÃO é o Postgres (acontece quando o Mac reinicia sem desligar o banco), a trava é velha:
1. Confirme: `ps -p <pid do arquivo>` mostra outro programa, e `pgrep -fl postgres` não mostra nada.
2. Faça uma cópia da pasta de dados: `cp -Rp /opt/homebrew/var/postgresql@16 ~/wendy-backups/pgdata-antes-$(date +%Y%m%d)`.
3. Remova só a trava: `rm /opt/homebrew/var/postgresql@16/postmaster.pid`. O serviço do Homebrew sobe sozinho em até ~15 s e recupera o log de transações.
4. `./scripts/dev-up.sh` para subir o agente, o inspetor, o worker e o web.
