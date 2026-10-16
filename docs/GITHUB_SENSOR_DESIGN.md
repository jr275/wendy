# Wendy — sensor do GitHub ("Movimentos"): desenho

Status: 15/out/2026. **As peças puras estão feitas e testadas; o sensor NÃO está ligado.** Nenhum token foi criado, nenhuma migration foi feita, nenhuma chamada ao GitHub aconteceu e nada roda num ciclo. Escrito a partir da leitura do código (`src/sensors/google/*`, `src/permissions/policy.ts`, `docs/PROACTIVITY_DESIGN.md`) e de uma consulta de leitura à lista de repositórios.

## 1. Decisões já tomadas (por você)
- **O que acompanhar (v1):** PRs e revisões.
- **Onde:** todos os repositórios da conta pessoal `jr275` (18 em 15/out/2026: 12 públicos, 6 privados, 2 forks, nenhum arquivado). A organização `Aerivaio` **não** entra, e nada presume que entre.

## 2. O que a Wendy mostraria (v1, só leitura)
Movimentos **que envolvem você**, não todo o tráfego dos repositórios:
1. PR esperando a **sua revisão** (você foi pedido como revisor).
2. PR **seu** que recebeu revisão aprovada, mudanças pedidas ou comentário novo.
3. PR **seu** com checks falhando (quando a permissão de checks existir).
4. PR **seu** aprovado e pronto para merge.

Cada movimento mostra repositório, título, autor, estado e **link para o GitHub**. Aparece no "Agora" quando pede você e como lista de "Movimentos" na Home. Nunca afirma algo que a API não disse.

## 3. Como (mesmo molde do sensor do Google)
- **Consulta periódica no Mac**, com ETag (`If-None-Match`) para respeitar o limite da API. Sem webhook: webhooks exigem endereço público, que depende de hospedar o agente (docs/DEPLOY.md).
- **Fonte dos dados:** a API de busca de PRs do GitHub (por exemplo `review-requested:jr275` e `author:jr275`, estado aberto). **A confirmar na implementação:** pelo que consta na documentação do GitHub, tokens *fine-grained* não atendem o endpoint `/notifications`, que é de token clássico; por isso o desenho usa a busca, e não as notificações.
- **Token:** *fine-grained*, **só leitura**, criado por você, restrito aos seus repositórios, com validade. Permissões mínimas: `Metadata: read` e `Pull requests: read` (mais `Checks: read` se quiser o item 3). **Não** é o token do `gh` (esse tem `repo` e `workflow`, ou seja, escrita).
- **Armazenamento:** `~/.wendy/github-token`, modo 0600, **nunca no banco, nunca em log**. O redator de segredos (`redactSecrets`) ganha o padrão `github_pat_…`/`ghp_…`.
- **Eventos:** entram na mesma esteira dos demais (deduplicação por `UNIQUE (principal_id, source, source_event_key)`, validação de evidência, limiar de relevância). Chave estável: `repo#número:tipo:estado`.
- **Lista de repositórios:** `config/github-scope.json` (no `.gitignore`, como `search-scope.json`), com os 18 nomes. Repositório fora da lista é ignorado.

## 4. Riscos específicos (e o que o desenho faz)
- **Texto de terceiros é dado, não instrução.** 12 dos repositórios são públicos: qualquer pessoa pode abrir um PR com título ou corpo hostil ("ignore suas regras…"). O sensor guarda e exibe **apenas metadados** (repo, número, título como texto puro, autor, estado, link); **corpo e comentários não entram** no raciocínio. Título passa pelo mesmo sanitizador de Markdown seguro da conversa.
- **Forks (`vercel`, `SimDeck`):** PRs do projeto original não envolvem você, e o filtro "envolve você" os deixa de fora.
- **Nenhuma escrita no v1.** Comentar, aprovar ou fazer merge é ação **externa**: sempre pede aprovação (`policy.ts`) e fica para uma fase própria.
- **Privacidade:** títulos de PR de repositórios privados (`menlo`, `agent-knowledge-graph`, …) podem aparecer em respostas e, portanto, chegar ao Gemini. A lista é explícita e você pode retirar qualquer um.
- **Segredo vazado:** o token nunca passa pelo chat. Se aparecer num log ou mensagem, revogue e gere outro.

## 5. Dependências (decisões suas, nada feito)
1. **Banco:** `connected_sources.provider` tem `CHECK (provider IN ('google'))`; para o GitHub é preciso uma migration (ou tabela nova). Exige a sua aprovação, backup e teste em `wendy_test`.
2. **Token:** você cria no GitHub (Settings → Developer settings → Fine-grained tokens), só leitura, e o salva no arquivo acima. Eu não crio tokens.
3. **Agendamento:** o worker já roda ciclos no Mac (`src/runtime/workerCli.ts`); o sensor entra nele. Com o Mac desligado, não há consulta (limite igual ao do Google).

## 6. Critérios de aceitação do v1
- Sem token ou com token inválido: a Wendy diz que o GitHub não está conectado; **nenhuma** afirmação é inventada.
- Um PR com título hostil aparece como texto puro e **não altera** nenhum comportamento (teste).
- Reingerir o mesmo PR não duplica o evento (teste).
- Nenhum valor do token aparece em log, banco ou resposta (teste com `redactSecrets`).
- Repositório fora de `github-scope.json` não gera evento (teste).
- Verificação no navegador com fixtures, nas larguras 1440, 1280, 768, 390 e 375 px, sem chamar o GitHub nem o Gemini.

## 7. Fora do v1
Issues e menções, CI/deploys, commits do `wendy-web-v0` (revisão contra o `LEIA-ME_V0`), webhooks, qualquer escrita, a organização `Aerivaio`.

## 8. O que já existe no código (15/out/2026, local, não commitado)
- `src/sensors/github/scope.ts`: escopo **negado por padrão** (sem arquivo = nada; arquivo inválido = nada). `config/github-scope.json` (fora do Git) já lista os 18 repositórios; `config/github-scope.example.json` é o modelo.
- `src/sensors/github/token.ts`: lê `~/.wendy/github-token` só se o arquivo for 0600 e tiver cara de token; nenhuma mensagem de erro contém o token.
- `src/sensors/github/movements.ts`: consulta GraphQL **só de metadados** (sem corpo, comentários nem diff), título sanitizado (controles e overrides bidirecionais), movimentos derivados com chave estável para a deduplicação.
- `src/sensors/github/client.ts`: uma requisição por ciclo, `fetch` injetável; **não faz nenhuma requisição** com escopo vazio; 401, limite de taxa, erro do servidor, erro do GraphQL e JSON quebrado são falhas distintas, nunca uma lista vazia.
- `redactSecrets` agora mascara `github_pat_…` e `ghp_/gho_/ghu_/ghs_/ghr_…`.
- Testes: `tests/unit/githubSensor.test.ts` (23 casos), com três mutações comprovadas (sem negar por padrão, sem sanitizar overrides, sem filtro de escopo).
- **Falta:** a migration do `connected_sources` (ou tabela nova), ligar o sensor a um ciclo do worker, mostrar "Movimentos" na Home, e **o token criado por você**. A confirmação de que a busca com token fine-grained responde como esperado só acontece com o token real.
