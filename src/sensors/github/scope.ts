/**
 * Which GitHub repositories Wendy may look at — a personal, reversible setting, like the Search Console scope, but DENY BY DEFAULT.
 *
 * `config/github-scope.json` (not in git; see config/github-scope.example.json):
 *   { "owner": "jr275", "repos": ["wendy-web-v0", "plataforma"] }
 *
 *   - no file                      → NOTHING is considered (twelve of the repositories are public: anyone can open a pull request in them);
 *   - a file that is present but invalid → fail closed: nothing is considered, and the reason is logged once;
 *   - a repository not in the list → ignored, never fetched into Wendy's records, never shown.
 *
 * Names are compared case-insensitively against `owner/repo`. WENDY_GITHUB_SCOPE_FILE overrides the path (tests).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultFile = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../config/github-scope.json');

export interface GithubScope {
  owner: string; // lower-cased
  repos: Set<string>; // lower-cased bare names
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

let warned = false;
const warnOnce = (why: string) => {
  if (warned) return;
  warned = true;
  console.error(`[github-scope] ${why}: no GitHub repository is considered until the file is fixed.`);
};

/** null = there is no scope file, which means nothing is considered (deny by default). */
export function loadGithubScope(): GithubScope | null {
  const file = process.env.WENDY_GITHUB_SCOPE_FILE ?? defaultFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    warnOnce(`cannot read ${path.basename(file)}`);
    return { owner: '', repos: new Set() };
  }
  try {
    const j = JSON.parse(raw) as { owner?: unknown; repos?: unknown };
    if (typeof j.owner !== 'string' || !OWNER.test(j.owner)) throw new Error('"owner" must be a GitHub user name');
    if (!Array.isArray(j.repos) || j.repos.some((x) => typeof x !== 'string' || !NAME.test(x))) throw new Error('"repos" must be a list of repository names');
    return { owner: j.owner.toLowerCase(), repos: new Set((j.repos as string[]).map((x) => x.toLowerCase())) };
  } catch {
    warnOnce(`${path.basename(file)} is not valid`);
    return { owner: '', repos: new Set() };
  }
}

/** `nameWithOwner` is "owner/repo". Anything outside the scope — or with no scope at all — is out. */
export function inGithubScope(nameWithOwner: string, scope: GithubScope | null): boolean {
  if (!scope || !scope.owner || !scope.repos.size) return false;
  const [owner, repo, ...rest] = nameWithOwner.toLowerCase().split('/');
  return rest.length === 0 && owner === scope.owner && !!repo && scope.repos.has(repo);
}
