# Wendy num servidor (tudo em uma máquina)

Decisão tomada em 16/out/2026: **web, agente, worker e banco no mesmo servidor; só o web fica público (com login); agente, API de leitura e banco ficam fechados.** A Vercel continua só como vitrine de demonstração.

**Estado deste kit: escrito e conferido por testes de texto e por `docker compose config`. As imagens NÃO foram construídas e o Caddy NÃO foi executado** (o Docker deste Mac estava desligado). O primeiro `docker compose up --build` no servidor é a primeira prova real.

## O que você precisa decidir e providenciar (eu não consigo por você)
1. **Servidor:** Ubuntu 24.04 LTS, 2 vCPU e 4 GB de RAM no mínimo (o build do Next e o Postgres pedem folga), disco de 40 GB ou mais. Região próxima do Brasil reduz a espera por resposta.
2. **Domínio:** um subdomínio (por exemplo `wendy.seudominio.com`) com registro **A** apontando para o IP do servidor, criado **antes** de subir.
3. **Acesso por chave SSH** ao servidor.
4. **Seus arquivos de credencial** (nunca no chat nem no Git): `vertex-sa.json`, `google-oauth-client.json`, `google-token.json` (ver a nota do Google abaixo), `brapi-token`.

## Passo a passo
### 1. Preparar o servidor (uma vez)
Instale o Docker pelo repositório oficial (docs.docker.com/engine/install/ubuntu), clone o repositório e rode como root, **depois de testar o login por chave em outro terminal**:
```bash
sudo deploy/bin/bootstrap-server.sh
```
Ele abre só as portas 22, 80 e 443, liga o fail2ban e as atualizações automáticas e desliga a senha do SSH. Recusa-se a rodar se não houver chave cadastrada.

### 2. Segredos e arquivos (no servidor, em `deploy/`)
```bash
cp env.example .env && chmod 600 .env
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" >> .env
printf 'WENDY_AGENT_TOKEN=%s\n'  "$(openssl rand -hex 24)" >> .env
printf 'WENDY_API_TOKEN=%s\n'    "$(openssl rand -hex 24)" >> .env
```
Edite `.env` (domínio, e-mail, projeto Google, e-mail do titular) **sem apagar** as linhas acima. Crie as pastas e traga os arquivos por `scp`:
```bash
mkdir -p data/.wendy data/Wendy/Documentos data/config secrets && chmod 700 data secrets
# do Mac:  scp ~/.wendy/google-oauth-client.json ~/.wendy/brapi-token SERVIDOR:.../deploy/data/.wendy/
# do Mac:  scp /caminho/vertex-sa.json SERVIDOR:.../deploy/secrets/vertex-sa.json
```
**Login do site:** gere o hash **no Mac**, sem mostrar a senha, e anexe ao `.env` do servidor:
```bash
read -s "P?Senha (12+ caracteres): " && printf '%s' "$P" | npx tsx scripts/web-password-hash.ts > ~/wendy-web-login.env && unset P && chmod 600 ~/wendy-web-login.env
scp ~/wendy-web-login.env SERVIDOR:/tmp/ && ssh SERVIDOR 'cat /tmp/wendy-web-login.env >> ~/.../deploy/.env && shred -u /tmp/wendy-web-login.env'; rm -P ~/wendy-web-login.env
```

### 3. Levar seus dados (Mac → servidor)
```bash
deploy/bin/dump-local.sh                       # no Mac: gera ~/wendy-transfer-….dump (modo 600)
scp ~/wendy-transfer-*.dump SERVIDOR:/tmp/    # só por scp/ssh
# no servidor, em deploy/:
bin/restore.sh /tmp/wendy-transfer-*.dump && shred -u /tmp/wendy-transfer-*.dump
```
No Mac, apague o dump depois (`rm -P`). O dump contém e-mails, memórias e conversas.

### 4. Subir
```bash
docker compose up -d --build
docker compose ps          # tudo "healthy"/"running"
```
Só `caddy` deve aparecer com portas publicadas (80 e 443). Confira de fora: `curl -sI https://SEU_DOMINIO | head -3` e que `nc -vz IP 5432`, `3457` e `3458` **não** conectam.

### 5. Depois de subir
- Entre no site, faça uma pergunta e veja que a resposta chega e que, ao recarregar, a conversa continua.
- `docker compose logs worker --tail 20`: as rotinas das 07:30 (resumo) e 18:30 (mercado) rodam sozinhas, **sem depender do Mac**.
- Backup noturno, no cron do servidor (`crontab -e`): `30 3 * * * cd /CAMINHO/deploy && bin/backup.sh >> backups/cron.log 2>&1`. Copie `deploy/backups` também para **outro lugar** (outro servidor ou armazenamento): backup só no mesmo servidor não protege contra perdê-lo.

## Google (Gmail e Agenda)
O consentimento abre um navegador e usa o endereço local `127.0.0.1`, então se refaz **no Mac**: `npm run google:connect`, e se copia o `google-token.json` novo para `deploy/data/.wendy/`. Se o aplicativo OAuth estiver em modo "Testing", o token expira em 7 dias (hipótese da auditoria): publique o app no Google Cloud para não repetir isso.

## Segurança, em ordem de importância
1. O login tem **uma senha e nenhum segundo fator**, e atrás dele estarão seus dados reais. Use uma senha longa e única. Enquanto não houver 2º fator, descomente o bloco `remote_ip` do `Caddyfile` para aceitar só os seus endereços.
2. Os limites de tentativa de login valem para um único processo (é o caso aqui).
3. Atualizar: `git pull && docker compose up -d --build`. Reverter: volte o commit e suba de novo. Os dados ficam no volume `pgdata`.
4. Trocar `WENDY_SESSION_SECRET` desconecta todas as sessões.
5. O mesmo service account serve o Gemini e o Search Console; o 403 do Search Console precisa de credencial própria (ver auditoria).

## O que não está verificado
Construção das imagens, o `next build` sem o modo demonstração, a emissão do certificado, o tempo de resposta a partir do servidor e a restauração do dump real. Cada um se confirma no passo indicado acima.
