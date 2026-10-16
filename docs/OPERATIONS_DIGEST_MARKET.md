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
