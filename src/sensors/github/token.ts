/**
 * The GitHub token: a fine-grained, READ-ONLY personal access token the principal creates and saves at
 * WENDY_GITHUB_TOKEN_FILE (default ~/.wendy/github-token). Same rules as the Google token: a file with mode 0600, never in the database,
 * never printed, never part of an error message.
 *
 * It is NOT the token of the `gh` CLI (that one can write). A file readable by other users is refused, not used.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const githubTokenFile = (): string => process.env.WENDY_GITHUB_TOKEN_FILE ?? path.join(os.homedir(), '.wendy', 'github-token');

export class GithubTokenError extends Error {}

/** Shapes GitHub issues for personal access tokens. Anything else is not a token we will send anywhere. */
const SHAPE = /^(github_pat_[A-Za-z0-9_]{20,}|gh[pous]_[A-Za-z0-9]{20,})$/;

export function readGithubToken(file: string = githubTokenFile()): string {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new GithubTokenError('GitHub não está conectado: não há arquivo de token.');
  }
  if (!st.isFile()) throw new GithubTokenError('O caminho do token do GitHub não é um arquivo.');
  if ((st.mode & 0o077) !== 0) throw new GithubTokenError('O arquivo do token do GitHub pode ser lido por outros usuários (use chmod 600). Ele não foi usado.');
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!SHAPE.test(token)) throw new GithubTokenError('O arquivo do token do GitHub não contém um token válido.');
  return token;
}
