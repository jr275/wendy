/**
 * Connect Wendy to the principal's Google account, READ-ONLY (Gmail + Calendar).
 *   npm run google:connect
 * Opens the consent page in the browser; the code returns to a local one-shot server.
 * Prints the account and scopes only — never tokens.
 */
import { spawn } from 'node:child_process';
import { databaseUrl, loadEnv } from '../src/config.js';
import { createPool, migrate } from '../src/db/db.js';
import { connectGoogle } from '../src/sensors/google/auth.js';
import { registerConnection } from '../src/sensors/google/sync.js';

loadEnv();
const db = createPool(databaseUrl());
await migrate(db);
const email = (process.env.WENDY_PRINCIPAL_EMAIL ?? '').toLowerCase();
const p = (await db.query<{ id: string; primary_email: string }>('SELECT id, primary_email FROM principals WHERE primary_email = $1', [email])).rows[0];
if (!p) throw new Error(`principal ${email || '(WENDY_PRINCIPAL_EMAIL unset)'} not found`);

const { account, scopes } = await connectGoogle({
  open: (url) => {
    console.log('\nAbra esta página para autorizar a Wendy (só leitura):\n\n' + url + '\n');
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  },
});
if (account !== p.primary_email) console.log(`⚠ Conta autorizada (${account}) é diferente do cadastro da Wendy (${p.primary_email}); ela será tratada como um endereço seu.`);
await registerConnection(db, p.id, account, scopes, new Date());
console.log(`✓ Google conectado: ${account}\n  Permissões: ${scopes.join(', ')}\n  Próximo passo: npm run google:sync (ou o worker sincroniza sozinho).`);
await db.end();
