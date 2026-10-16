# Wendy na web: estado, o que foi feito e o que falta

Atualizado em 15/out/2026. **A interface (modo demonstração) está publicada; a Wendy de verdade (agente + banco) continua só no Mac.**

## Estado atual
| Peça | Onde | Situação |
|---|---|---|
| Web, modo demonstração | Vercel, time **Menlo**, projeto **`wendy-web`** (conta `jm-2384`) | Publicado em produção. Endereços: `wendy-web.vercel.app` e `wendy-web-menlo6.vercel.app` |
| Login do web | no próprio app | Uma senha, cookie de sessão assinado. Obrigatório em produção |
| Agente (`npm run agent`, porta 3458) e inspector (3457) | só `127.0.0.1` do Mac | Não hospedados |
| Postgres | Mac | Não hospedado |
| Repositório da interface para o v0 | GitHub `jr275/wendy-web-v0` (**privado**) | Cópia de `web/` sem segredos; ver `LEIA-ME_V0.md` dentro dela |

Na Vercel o app não tem agente nem banco: mostra **demonstração** (lista vazia, "Visitante") e não responde. Proteção do projeto: em 14/out a **Vercel Authentication** estava ligada em "All Deployments" (só membros do time abrem o endereço, antes do login da Wendy). Confira em Settings → Deployment Protection se foi alterada.

## Variáveis do projeto `wendy-web` (Production, todas marcadas como sensíveis)
Só os **nomes** ficam aqui; os valores nunca vão para o chat, o Git ou este arquivo.
- `WENDY_WEB_PASSWORD_HASH`: hash PBKDF2 da senha.
- `WENDY_SESSION_SECRET`: segredo que assina a sessão (≥ 32 caracteres).
- `WENDY_DEMO=1`: modo demonstração.
- `WENDY_AGENT=off`: o agente não existe nesse ambiente.

Não coloque `WENDY_AGENT_TOKEN`, chaves de modelo, `DATABASE_URL` nem variáveis do Google no projeto enquanto não houver agente e banco hospedados.

### Gerar a senha e o segredo já direto para a Vercel (nada é impresso)
Cole o bloco inteiro; a senha é pedida em silêncio e os valores seguem para a Vercel sem passar pela tela:
```bash
cd ~/.gemini/antigravity/scratch/wendy && read -s "P?Senha (12+ caracteres): " && echo && OUT=$(printf '%s' "$P" | npx tsx scripts/web-password-hash.ts) && unset P && H=${${(f)OUT}[1]#WENDY_WEB_PASSWORD_HASH=} && S=${${(f)OUT}[2]#WENDY_SESSION_SECRET=} && unset OUT && cd web && printf '%s' "$H" | vercel env add WENDY_WEB_PASSWORD_HASH production --sensitive --scope menlo6 && printf '%s' "$S" | vercel env add WENDY_SESSION_SECRET production --sensitive --scope menlo6; unset H S
```
Trocar a senha = rodar de novo (a variável já existe: remova antes com `vercel env rm NOME production --scope menlo6`) e republicar. Se um valor aparecer no chat ou num log, **descarte-o e gere outro**.

## Publicar de novo
```bash
cd ~/.gemini/antigravity/scratch/wendy/web && vercel deploy --prod --scope menlo6
```
O código sobe pela CLI (sem Git), respeitando o `web/.gitignore` (`.env*`, `.next`, `.vercel`, `node_modules` ficam de fora).

## Armadilhas encontradas (já custaram tempo)
- **`vercel link` grava `VERCEL_OIDC_TOKEN` em `web/.env.local`.** Esse arquivo é protegido: remova só o bloco que a CLI acrescentou ("Created by Vercel CLI" + a variável).
- **`~/.vercel/project.json` na pasta pessoal** faz `vercel whoami` rodado de `~` responder "Not authorized" (vínculo de outra conta). Rode `vercel` de dentro de uma pasta de projeto ou apague essa pasta.
- **Logout e login repetidos** invalidam o token anterior; espere um minuto depois do login.
- **Login por formulário e `Referrer-Policy`:** com `no-referrer` o navegador não envia `Origin` no POST e o login respondia "Pedido recusado". Agora a página usa `same-origin`, e a verificação aceita `Sec-Fetch-Site: same-origin` quando falta `Origin` (`web/lib/auth.ts`, `requestIsSameSite`). Regressão coberta em `tests/unit/webAuth.test.ts` e `webAuthRoutes.test.ts`.

## Login (código)
`web/lib/auth.ts`, `web/proxy.ts`, `web/app/login/route.ts`, `web/app/logout/route.ts`, `web/components/sign-out.tsx`.
- Senha só como hash PBKDF2-SHA256; sessão assinada (HMAC-SHA256), `HttpOnly`, `SameSite=Strict`, `Secure` em produção, 7 dias.
- **Produção exige login em tudo** (páginas e API, inclusive `/api/copilotkit`). Sem hash ou segredo: **503** em tudo (falha fechada). `/dev/*` responde 404.
- Em desenvolvimento o login fica **desligado**, a menos que `WENDY_AUTH=on`.
- Limite de tentativas: 5 falhas em 15 min por endereço, **em memória de um processo**; com várias instâncias só atrasa quem adivinha.
- Botão **Sair** (`POST /logout`) aparece só onde o login é exigido (produção); **não foi visto renderizado** em produção.

## Fatia de interface P0 (15/out/2026, só `web/`, local, não commitada)
- **Entrada única:** no desktop o único campo real é o da coluna da conversa; o campo do centro virou um atalho que leva o foco até ele. No celular e no tablet o campo do centro é o real; o botão flutuante agora é "Abrir conversa".
- **"Continuar de onde parou"** (antes "Retomar"): cada pergunta mostra o estado real da tarefa que iniciou (`web/lib/resume.ts`), **só quando o servidor gravou o vínculo** (`skill_executions.trigger.messageId`). Pedidos antigos não têm vínculo e não mostram estado (nada é inferido do texto). Botão "Ocultar textos" (por dispositivo, desligado por padrão).
- **Alvos de toque ≥ 44 px** no celular: menu, tema, logo, seletor Conversa/Painel, "Mostrar mais", linhas da lista e "Aprovar"/"Recusar".
- **Defeito antigo corrigido:** a rota `/api/executions` do inspector ficava depois da checagem de `id`, então toda chamada respondia "invalid id" e a Home nunca mostrava "Em andamento", "Agora" nem aprovações pendentes. Coberto por `tests/unit/inspectorRoutes.test.ts` (checagem estrutural do código-fonte, comprovada por mutação).
- **Redação de cartão** nos destinos de gravação e log: ver `docs/OPEN_INSTINCT_ADAPTATION.md`.
- Verificação: `tsc` (raiz e web), ESLint dos arquivos tocados, 172 testes sem banco, inspeção no navegador em 1440/1280/768/390/375 px (sem overflow).
- **Não verificado:** tema escuro e foco por teclado dessa fatia; o cartão de aprovação renderizado em 390 px (a janela estava minimizada; só o estilo calculado foi conferido); testes com banco.

## Pré-requisitos de código para hospedar (feitos em 15/out/2026; local, não commitado)
- **API de leitura do inspector com credencial.** Com `WENDY_API_TOKEN` definido (≥ 32 caracteres) o inspector entra em **modo hospedado**: responde só `GET /api/*` com `Authorization: Bearer <token>` (401 sem ele), `GET /healthz` aberto (sem dados), e **não existem** nesse modo as páginas do inspector, o login `/login` nem `/api/write/*` (404, mesmo com token). Sem `WENDY_API_TOKEN` tudo continua como antes, em `127.0.0.1`.
- **Não sobe exposto sem credencial:** `INSPECT_HOST` (padrão `127.0.0.1`) diferente de loopback sem token = o processo **recusa iniciar** (saída 1). Lógica em `src/security/apiAuth.ts`, testada em `tests/unit/apiAccess.test.ts` e comprovada rodando o servidor.
- **Agente:** o endereço de escuta agora é `WENDY_AGENT_HOST` (padrão `127.0.0.1`); o bearer `WENDY_AGENT_TOKEN` continua obrigatório.
- **Web:** envia `Authorization: Bearer $WENDY_API_TOKEN` ao inspector quando a variável existe. Se a API não responder, Home, Sites, Memória e Semana mostram "Não consegui falar com a Wendy agora" (verificado com o inspector parado), em vez de quebrar ou dizer "nenhum executivo cadastrado".
- **Ainda não verificado:** o web na Vercel falando com um inspector remoto de verdade (só o cabeçalho foi testado, e as requisições com `curl`).

## O que ainda falta para a Wendy de verdade na web
| Peça | Situação |
|---|---|
| Agente e inspector sempre ligados | Escutam só em `127.0.0.1`. Precisam de um servidor, **sem porta pública**, acessível só pelo web (token `WENDY_AGENT_TOKEN`) |
| Postgres hospedado | Backup e migração (`npm run migrate`). O disco do Mac já encheu uma vez e derrubou o banco |
| Variáveis do web quando houver agente | `WENDY_AGUI_URL`, `WENDY_AGENT_TOKEN`, `WENDY_PRINCIPAL_EMAIL`, `WENDY_API_URL`, `WENDY_SCHEMA`; remover `WENDY_DEMO` |
| Revisão de segurança antes de abrir o endereço ao público | Pendente (cabeçalhos, segredos do Google, política de dados, limite de tentativas que valha para várias instâncias) |
| Segundo fator no login | Não existe |

## Riscos que continuam
- Seus dados (e-mail, agenda, memórias) passariam a viver fora da sua máquina.
- Senha única, sem segundo fator.
- O agente precisa de crédito no provedor do modelo e fala com serviços externos quando ligado.
- O histórico gravado **antes** do mascaramento de cartão continua em claro no banco.
