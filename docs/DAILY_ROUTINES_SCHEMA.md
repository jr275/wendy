# Rotinas diárias — esquema de banco proposto e plano de reversão

Status: **PROPOSTA. Nenhuma migration foi escrita em `src/db/migrations/` nem executada.** Só tabelas **novas**; nenhuma tabela existente é alterada. Pedido de aprovação na seção 5.

## 1. Para que serve
Uma rotina é "algo que a Wendy faz uma vez por dia, no seu horário, e guarda o resultado". V1: **resumo de leitura** (ML/IA/ciências), **citação verificável**, **desafio de ML**. Cada rodada é **idempotente por rotina e por data local** (`America/Sao_Paulo`), tem histórico e pode ser pausada.

## 2. Tabelas (SQL proposto)
```sql
CREATE TABLE routines (
  id           uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id),
  kind         text NOT NULL CHECK (kind IN ('research_digest', 'daily_quote', 'ml_challenge')),
  enabled      boolean NOT NULL DEFAULT true,
  local_time   time NOT NULL DEFAULT '07:30',
  timezone     text NOT NULL DEFAULT 'America/Sao_Paulo',
  paused_until timestamptz,
  config       jsonb NOT NULL DEFAULT '{}',          -- fontes escolhidas, número de itens, temas
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  UNIQUE (principal_id, kind)
);

CREATE TABLE routine_runs (
  id          uuid PRIMARY KEY,
  routine_id  uuid NOT NULL REFERENCES routines(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  run_date    date NOT NULL,                          -- a data LOCAL (fuso da rotina): a chave da idempotência
  status      text NOT NULL CHECK (status IN ('RUNNING', 'DONE', 'FAILED')),
  attempts    integer NOT NULL DEFAULT 1,
  lease_until timestamptz,                            -- recuperação: uma rodada travada pode ser retomada, nunca duplicada
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  error       text,                                   -- sempre passado por redactSecrets
  UNIQUE (routine_id, run_date)
);

CREATE TABLE digest_items (
  id           uuid PRIMARY KEY,
  run_id       uuid NOT NULL REFERENCES routine_runs(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  kind         text NOT NULL CHECK (kind IN ('article', 'quote', 'challenge')),
  source_name  text NOT NULL,
  source_url   text NOT NULL,                         -- link original, sempre
  title        text NOT NULL,
  published_at timestamptz,
  summary      text,                                  -- em palavras da Wendy, curto: nunca o texto do autor
  why          text,                                  -- por que entrou (critério explícito)
  score        real,
  evidence     jsonb NOT NULL DEFAULT '{}',           -- citação: texto, fonte primária, data de verificação
  answered_at  timestamptz,                           -- desafio: só depois da sua tentativa a solução é mostrada
  read_at      timestamptz,
  created_at   timestamptz NOT NULL,
  UNIQUE (principal_id, source_url)                   -- o mesmo link nunca aparece duas vezes
);
CREATE INDEX digest_items_unread ON digest_items (principal_id, created_at DESC) WHERE read_at IS NULL;
```

## 3. Regras de comportamento
- **Disparo:** o worker, a cada ciclo, procura rotinas devidas (`enabled`, não pausadas, horário local atingido, sem `routine_runs` para a data de hoje) e tenta `INSERT … ON CONFLICT (routine_id, run_date) DO NOTHING`: **quem inserir executa**, os demais veem que já existe. Rodada `RUNNING` com `lease_until` vencido pode ser retomada; `DONE` nunca roda de novo no mesmo dia.
- **Falha:** `FAILED` registra o erro; a rodada seguinte (mesmo dia) pode tentar de novo até um teto de tentativas, sem criar itens duplicados (o `UNIQUE` do link protege).
- **Pausar/desativar:** `paused_until` e `enabled`, pela interface; histórico preservado.
- **Entrega:** só **dentro do app** (cartão na Home). Notificação externa **não existe**.
- **Fuso:** a data é calculada no fuso da rotina, não em UTC (um teste cobre 23:30 local).
- **Ledger:** início e fim de rodada vão ao ledger sem conteúdo.

## 4. Reversão
1. **Antes:** `pg_dump` do banco `wendy` (backup completo) e teste da migration em `wendy_test`.
2. **Desfazer** (só tabelas novas, em ordem inversa de dependência):
```sql
DROP TABLE digest_items;
DROP TABLE routine_runs;
DROP TABLE routines;
```
3. Nada nas tabelas existentes muda; portanto desfazer **não** afeta mensagens, memórias, tarefas nem o ledger.
4. Se a migration falhar no meio, ela roda dentro de uma transação; nada fica pela metade.

## 5. O que preciso de você
**Aprovação explícita** para escrever e executar essa migration (primeiro em `wendy_test`, depois em `wendy`, com backup). Sem ela, a rotina fica só em planejamento e o resumo pode ser gerado **sob demanda**, sem agendamento e sem histórico.
