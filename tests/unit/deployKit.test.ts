import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => fs.readFileSync(p, 'utf8');
const composeRaw = read('deploy/docker-compose.yml');
/** The compose file without comment lines: the rules below are about what the file DOES, not what it says. */
const compose = composeRaw.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
/** The text of one top-level service block. */
const service = (name: string) => {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start, `service ${name}`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z_]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe('deployment kit: what is exposed', () => {
  it('only Caddy publishes ports; the database, agent, read API, worker and web are reachable only inside the Docker network', () => {
    expect(compose.match(/^\s+ports:/gm)).toHaveLength(1);
    expect(service('caddy')).toMatch(/ports:\s*\n\s*- "80:80"\s*\n\s*- "443:443"/);
    for (const s of ['db', 'migrate', 'agent', 'inspector', 'worker', 'web']) expect(service(s), s).not.toMatch(/ports:/);
  });
  it('the read API runs in hosted mode (token required) and the agent in the private network', () => {
    expect(service('inspector')).toMatch(/WENDY_API_TOKEN: \$\{WENDY_API_TOKEN:\?/);
    expect(service('agent')).toMatch(/WENDY_AGENT_TOKEN: \$\{WENDY_AGENT_TOKEN:\?/);
  });
  it('the web runs in production mode with the login required, and never in demonstration mode', () => {
    const web = service('web');
    expect(web).toMatch(/NODE_ENV: production/);
    expect(web).toMatch(/WENDY_WEB_PASSWORD_HASH: \$\{WENDY_WEB_PASSWORD_HASH:\?/);
    expect(web).toMatch(/WENDY_SESSION_SECRET: \$\{WENDY_SESSION_SECRET:\?/);
    expect(compose).not.toMatch(/WENDY_DEMO/);
    expect(compose).not.toMatch(/WENDY_AGENT: off/);
  });
  it('each service gets only the secrets it uses: no catch-all env_file, and the web never sees the database or model credentials', () => {
    expect(compose).not.toMatch(/env_file/);
    const web = service('web');
    for (const secret of ['POSTGRES_PASSWORD', 'DATABASE_URL', 'GOOGLE_APPLICATION_CREDENTIALS', 'vertex-sa']) expect(web, secret).not.toContain(secret);
    for (const s of ['agent', 'inspector', 'worker']) expect(service(s), s).not.toContain('WENDY_SESSION_SECRET');
  });
  it('services recover by themselves and the images are pinned to a major version, not "latest"', () => {
    expect(compose).not.toMatch(/image:.*:latest/);
    expect(compose).toMatch(/image: postgres:16-alpine/);
    expect(compose).toMatch(/restart: unless-stopped/);
  });
});

describe('deployment kit: proxy, secrets and images', () => {
  it('the proxy overwrites X-Forwarded-For (the login limiter trusts it), streams the conversation, and sets HSTS', () => {
    const c = read('deploy/Caddyfile');
    expect(c).toContain('header_up X-Forwarded-For {remote_host}');
    expect(c).toContain('flush_interval -1');
    expect(c).toContain('Strict-Transport-Security');
    expect(c).toMatch(/max_size 2MB/);
  });
  it('the env template holds names only (no values), and the real files and data are ignored by Git and by the image build', () => {
    const env = read('deploy/env.example');
    for (const line of env.split('\n').filter((l) => /^[A-Z_]+=/.test(l))) {
      const [k, v = ''] = line.split('=');
      if (/PASSWORD|TOKEN|SECRET|HASH/.test(k!)) expect(v, k).toBe('');
    }
    const gi = read('deploy/.gitignore');
    for (const p of ['.env', 'data/', 'secrets/', 'backups/']) expect(gi).toContain(p);
    const di = read('.dockerignore');
    for (const p of ['.env', 'node_modules', 'web', 'shot.png', 'deploy/secrets', 'deploy/data', 'config/search-scope.json', 'config/github-scope.json']) expect(di, p).toContain(p);
    expect(read('web/.dockerignore')).toContain('.env');
  });
  it('the images run as an unprivileged user', () => {
    expect(read('deploy/Dockerfile.backend')).toMatch(/^USER node$/m);
    expect(read('deploy/Dockerfile.web')).toMatch(/^USER node$/m);
  });
  it('the helper scripts fail fast, protect the files they write, and the restore refuses a non-empty database', () => {
    for (const f of ['dump-local', 'restore', 'backup', 'bootstrap-server']) expect(read(`deploy/bin/${f}.sh`), f).toMatch(/set -euo pipefail/);
    expect(read('deploy/bin/dump-local.sh')).toMatch(/umask 077/);
    expect(read('deploy/bin/backup.sh')).toMatch(/umask 077/);
    expect(read('deploy/bin/restore.sh')).toMatch(/FORCE/);
    expect(read('deploy/bin/bootstrap-server.sh')).toMatch(/No SSH key found/);
  });
});
