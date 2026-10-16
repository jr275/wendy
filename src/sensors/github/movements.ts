/**
 * GitHub "movements": what happens to the principal's pull requests, reduced to METADATA.
 *
 * Wendy takes from a pull request only: repository, number, title (as plain text), author, state, link, and a few status fields. The body and the
 * comments are never requested and never stored. Twelve of the repositories are public, so any title can be written by a stranger: it is treated
 * as DATA (shown as text), never as an instruction, and it is sanitized here before anything else sees it.
 *
 * Pure: it parses a response and derives movements. It makes no request and reads no file. (client.ts fetches; scope.ts filters.)
 */
import { z } from 'zod';
import { inGithubScope, type GithubScope } from './scope.js';

export type MovementKind = 'review_requested' | 'pr_approved' | 'pr_changes_requested' | 'pr_checks_failing';

export interface Movement {
  /** Stable key for the events table's dedupe: the same fact never becomes two events. */
  key: string;
  kind: MovementKind;
  repo: string; // owner/name
  number: number;
  title: string; // sanitized, plain text
  author: string;
  url: string;
  at: string; // when the PR was last updated (ISO)
}

// Control characters and the bidirectional overrides that can make a title read differently from what it is.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
export const TITLE_MAX = 200;

export function sanitizeTitle(raw: string): string {
  const t = raw.replace(UNSAFE, '').replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

const Pr = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().url(),
  isDraft: z.boolean(),
  updatedAt: z.string(),
  author: z.object({ login: z.string() }).nullable(),
  repository: z.object({ nameWithOwner: z.string() }),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ oid: z.string(), statusCheckRollup: z.object({ state: z.string() }).nullable() }) })) }),
});
type PrNode = z.infer<typeof Pr>;

const SearchResult = z.object({ nodes: z.array(z.unknown()) });
export const GraphqlResponse = z.object({
  data: z.object({ reviewRequested: SearchResult, authored: SearchResult }),
});

export class GithubResponseError extends Error {}

/** Nodes that are not pull requests (the search can return other shapes) are skipped; a PR that does not fit the shape is a malformed response. */
function pulls(nodes: unknown[]): PrNode[] {
  const out: PrNode[] = [];
  for (const n of nodes) {
    if (!n || typeof n !== 'object' || Object.keys(n).length === 0) continue; // an empty node: a non-PR hit
    const r = Pr.safeParse(n);
    if (!r.success) throw new GithubResponseError('Resposta do GitHub em formato inesperado.');
    out.push(r.data);
  }
  return out;
}

const FAILING = new Set(['FAILURE', 'ERROR']);

export function deriveMovements(body: unknown, user: string, scope: GithubScope | null): Movement[] {
  const parsed = GraphqlResponse.safeParse(body);
  if (!parsed.success) throw new GithubResponseError('Resposta do GitHub em formato inesperado.');
  const me = user.toLowerCase();
  const out = new Map<string, Movement>();
  const add = (pr: PrNode, kind: MovementKind, extra = '') => {
    const m: Movement = {
      key: `${pr.repository.nameWithOwner.toLowerCase()}#${pr.number}:${kind}${extra ? `:${extra}` : ''}`,
      kind,
      repo: pr.repository.nameWithOwner,
      number: pr.number,
      title: sanitizeTitle(pr.title),
      author: pr.author?.login ?? 'desconhecido',
      url: pr.url,
      at: pr.updatedAt,
    };
    out.set(m.key, m);
  };

  for (const pr of pulls(parsed.data.data.reviewRequested.nodes)) {
    if (!inGithubScope(pr.repository.nameWithOwner, scope) || pr.isDraft) continue;
    if (pr.author?.login.toLowerCase() === me) continue; // your own PR is not "waiting for your review"
    add(pr, 'review_requested');
  }
  for (const pr of pulls(parsed.data.data.authored.nodes)) {
    if (!inGithubScope(pr.repository.nameWithOwner, scope) || pr.isDraft) continue;
    if (pr.author?.login.toLowerCase() !== me) continue;
    if (pr.reviewDecision === 'APPROVED') add(pr, 'pr_approved');
    if (pr.reviewDecision === 'CHANGES_REQUESTED') add(pr, 'pr_changes_requested');
    const head = pr.commits.nodes[0]?.commit;
    if (head?.statusCheckRollup && FAILING.has(head.statusCheckRollup.state)) add(pr, 'pr_checks_failing', head.oid.slice(0, 12)); // a new failing commit is a new fact
  }
  return [...out.values()].sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
}

/** The GraphQL query: metadata only. No body, no comments, no diff. `user` is validated by scope.ts before it reaches here. */
export function buildQuery(user: string): { query: string; variables: Record<string, string> } {
  const fields = `... on PullRequest { number title url isDraft updatedAt author { login } repository { nameWithOwner }
    reviewDecision commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } } }`;
  return {
    query: `query($rr: String!, $au: String!) {
      reviewRequested: search(query: $rr, type: ISSUE, first: 50) { nodes { ${fields} } }
      authored: search(query: $au, type: ISSUE, first: 50) { nodes { ${fields} } }
    }`,
    variables: { rr: `is:pr is:open archived:false user:${user} review-requested:${user}`, au: `is:pr is:open archived:false user:${user} author:${user}` },
  };
}
