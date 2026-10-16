/**
 * Makes the value for WENDY_WEB_PASSWORD_HASH (and a session secret for WENDY_SESSION_SECRET). Nothing is sent anywhere or written to disk.
 *
 *   read -s "P?Senha: " && printf '%s' "$P" | npx tsx scripts/web-password-hash.ts; unset P
 *
 * The password is read from stdin so it never appears in the process list or the shell history.
 */
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../web/lib/auth.js';

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
if (password.length < 12) {
  console.error('A senha precisa ter pelo menos 12 caracteres.');
  process.exit(1);
}
console.log(`WENDY_WEB_PASSWORD_HASH=${await hashPassword(password)}`);
console.log(`WENDY_SESSION_SECRET=${randomBytes(48).toString('base64url')}`);
