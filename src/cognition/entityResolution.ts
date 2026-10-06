/**
 * ENTITY RESOLUTION. Deterministic and conservative: an identity is resolved only when the
 * evidence is unambiguous. Ambiguous mentions are reported as such, never guessed.
 *   1. email identifier (exact)
 *   2. exact full name (unique)
 *   3. all name tokens contained in exactly one person's name (e.g. a first name used alone)
 */
import type { Queryable } from '../db/db.js';
import type { Person } from '../domain/types.js';
import type { Repositories } from '../repositories/pg.js';

export interface Mention {
  name: string | null;
  email: string | null;
}

export interface ResolutionResult {
  resolved: { mention: Mention; personId: string; method: 'EMAIL_IDENTIFIER' | 'EXACT_NAME' | 'NAME_TOKENS_UNIQUE' }[];
  ambiguous: { mention: Mention; candidateIds: string[] }[];
  unresolved: Mention[];
}

const tokens = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

export async function resolveMentions(q: Queryable, repos: Repositories, principalId: string, mentions: Mention[]): Promise<ResolutionResult> {
  const result: ResolutionResult = { resolved: [], ambiguous: [], unresolved: [] };
  let everyone: Person[] | null = null;

  for (const mention of mentions) {
    if (mention.email) {
      const p = await repos.entities.findPersonByIdentifier(q, principalId, 'email', mention.email);
      if (p) {
        result.resolved.push({ mention, personId: p.id, method: 'EMAIL_IDENTIFIER' });
        continue;
      }
    }
    if (!mention.name?.trim()) {
      result.unresolved.push(mention);
      continue;
    }
    const exact = await repos.entities.findPeopleByExactName(q, principalId, mention.name);
    if (exact.length === 1) {
      result.resolved.push({ mention, personId: exact[0]!.id, method: 'EXACT_NAME' });
      continue;
    }
    everyone ??= (await q.query<Person>('SELECT * FROM people WHERE principal_id = $1', [principalId])).rows;
    const wanted = tokens(mention.name);
    const candidates = wanted.length ? everyone.filter((p) => wanted.every((t) => tokens(p.full_name).includes(t))) : [];
    if (candidates.length === 1) result.resolved.push({ mention, personId: candidates[0]!.id, method: 'NAME_TOKENS_UNIQUE' });
    else if (candidates.length > 1) result.ambiguous.push({ mention, candidateIds: candidates.map((c) => c.id) });
    else result.unresolved.push(mention);
  }

  const seen = new Set<string>();
  result.resolved = result.resolved.filter((r) => (seen.has(r.personId) ? false : (seen.add(r.personId), true)));
  return result;
}
