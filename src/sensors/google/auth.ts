/**
 * Google OAuth for the principal's own account — READ-ONLY scopes only (Gmail, Calendar).
 *
 *  - OAuth client: a "Desktop app" client the principal creates in their own Google Cloud project,
 *    saved as JSON at WENDY_GOOGLE_CLIENT_FILE (default ~/.wendy/google-oauth-client.json).
 *  - Consent: loopback flow with PKCE on 127.0.0.1 (the code never leaves this machine).
 *  - Token: refresh token saved at WENDY_GOOGLE_TOKEN_FILE (default ~/.wendy/google-token.json),
 *    file mode 0600, never in the database, never printed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CodeChallengeMethod, OAuth2Client, type Credentials } from 'google-auth-library';

export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly'] as const;
const READ_ONLY = new Set<string>(GOOGLE_SCOPES);

const home = (...p: string[]) => path.join(os.homedir(), '.wendy', ...p);
export const clientFile = () => process.env.WENDY_GOOGLE_CLIENT_FILE ?? home('google-oauth-client.json');
export const tokenFile = () => process.env.WENDY_GOOGLE_TOKEN_FILE ?? home('google-token.json');

export class GoogleAuthError extends Error {}

function readClient(): { clientId: string; clientSecret: string } {
  const file = clientFile();
  if (!fs.existsSync(file)) throw new GoogleAuthError(`OAuth client file not found at ${file}`);
  const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { installed?: { client_id: string; client_secret: string } };
  if (!j.installed) throw new GoogleAuthError('the OAuth client must be of type "Desktop app" (key "installed")');
  return { clientId: j.installed.client_id, clientSecret: j.installed.client_secret };
}

interface StoredToken {
  account: string;
  scopes: string[];
  credentials: Credentials;
}

function saveToken(t: StoredToken): void {
  const file = tokenFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(t), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function connectedAccount(): { account: string; scopes: string[] } | null {
  const file = tokenFile();
  if (!fs.existsSync(file)) return null;
  const t = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredToken;
  return { account: t.account, scopes: t.scopes };
}

/** An authorized client; refreshed tokens are written back to the token file. */
export function authorizedClient(): OAuth2Client {
  const file = tokenFile();
  if (!fs.existsSync(file)) throw new GoogleAuthError('Google is not connected (run: npm run google:connect)');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredToken;
  const { clientId, clientSecret } = readClient();
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials(stored.credentials);
  client.on('tokens', (t) => saveToken({ ...stored, credentials: { ...stored.credentials, ...t } }));
  return client;
}

/**
 * Interactive consent. Prints the URL (and opens it), waits for Google to redirect back to a
 * one-shot local server, exchanges the code with PKCE, and refuses anything beyond read-only scopes.
 */
export async function connectGoogle(opts: { open?: (url: string) => void; timeoutMs?: number } = {}): Promise<{ account: string; scopes: string[] }> {
  const { clientId, clientSecret } = readClient();
  const state = crypto.randomBytes(16).toString('hex');
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [...GOOGLE_SCOPES], state, code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256 });

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GoogleAuthError('no authorization within the time limit')), opts.timeoutMs ?? 10 * 60_000);
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', redirectUri);
      if (u.pathname !== '/oauth2callback') return void res.writeHead(404).end();
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' }).end(ok ? '<p>Wendy conectada ao Google (só leitura). Pode fechar esta aba.</p>' : '<p>Autorização recusada ou inválida.</p>');
      clearTimeout(timer);
      if (ok) resolve(u.searchParams.get('code')!);
      else reject(new GoogleAuthError(u.searchParams.get('error') ?? 'invalid callback'));
    });
    (opts.open ?? (() => {}))(url);
  }).finally(() => server.close());

  const { tokens } = await client.getToken({ code, codeVerifier });
  const granted = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
  const extra = granted.filter((s) => !READ_ONLY.has(s) && !s.endsWith('/userinfo.email'));
  if (extra.length) throw new GoogleAuthError(`refusing token with non read-only scopes: ${extra.join(', ')}`);
  if (!granted.some((s) => s.includes('gmail.readonly')) || !granted.some((s) => s.includes('calendar.readonly'))) throw new GoogleAuthError('Gmail and Calendar read access were not both granted');
  if (!tokens.refresh_token) throw new GoogleAuthError('Google did not return a refresh token');
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token!, audience: clientId });
  const account = ticket.getPayload()?.email?.toLowerCase();
  if (!account) throw new GoogleAuthError('could not read the account email');
  saveToken({ account, scopes: granted, credentials: tokens });
  return { account, scopes: granted };
}

