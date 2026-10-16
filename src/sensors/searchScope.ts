/**
 * Which Search Console properties Wendy considers — a personal, reversible setting, not data.
 *
 * `config/search-scope.json` (not in git; see config/search-scope.example.json):
 *   { "include": ["Remax"] }
 * names the properties to consider, by label or exact site URL (case-insensitive). Every other
 * property is left out of what Wendy syncs, detects, reasons over and shows. Nothing is deleted:
 * the rows and history stay in the database, so removing the file (or adding a name) restores them
 * at once. The file is read on every use, so an edit applies without restarting anything.
 *
 *   - no file → no restriction (the previous behaviour);
 *   - a file that is present but invalid → fail closed: nothing is considered, and the reason is
 *     logged once. A broken setting must never quietly widen what Wendy looks at.
 *
 * WENDY_SEARCH_SCOPE_FILE overrides the path (tests).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Queryable } from '../db/db.js';

const defaultFile = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config/search-scope.json');

export interface SearchScope {
  include: string[]; // lower-cased labels / site URLs
}

let warned = false;
const warnOnce = (why: string) => {
  if (warned) return;
  warned = true;
  console.error(`[search-scope] ${why}: no Search Console property is considered until the file is fixed.`);
};

export function loadSearchScope(): SearchScope | null {
  const file = process.env.WENDY_SEARCH_SCOPE_FILE ?? defaultFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    warnOnce(`cannot read ${path.basename(file)}`);
    return { include: [] };
  }
  try {
    const j = JSON.parse(raw) as { include?: unknown };
    if (!Array.isArray(j.include) || j.include.some((x) => typeof x !== 'string' || !x.trim())) throw new Error('"include" must be a list of names');
    return { include: j.include.map((x) => String(x).trim().toLowerCase()) };
  } catch {
    warnOnce(`${path.basename(file)} is not valid`);
    return { include: [] };
  }
}

export function inSearchScope(p: { label: string; site_url: string }, scope: SearchScope | null = loadSearchScope()): boolean {
  if (!scope) return true;
  return scope.include.includes(p.label.trim().toLowerCase()) || scope.include.includes(p.site_url.trim().toLowerCase());
}

/** Ids of the principal's properties that are outside the scope (empty when there is no restriction). */
export async function outOfScopePropertyIds(q: Queryable, principalId: string): Promise<string[]> {
  const scope = loadSearchScope();
  if (!scope) return [];
  const rows = (await q.query<{ id: string; label: string; site_url: string }>('SELECT id, label, site_url FROM web_properties WHERE principal_id = $1', [principalId])).rows;
  return rows.filter((r) => !inSearchScope(r, scope)).map((r) => r.id);
}

/** Ids of the insights that were raised about a property outside the scope. */
export async function outOfScopeInsightIds(q: Queryable, principalId: string): Promise<Set<string>> {
  const props = await outOfScopePropertyIds(q, principalId);
  if (!props.length) return new Set();
  const rows = (
    await q.query<{ id: string }>(
      `SELECT i.id FROM insights i JOIN events e ON e.id = i.event_id
        WHERE i.principal_id = $1 AND e.event_type = 'SEARCH_PERFORMANCE_CHANGE' AND e.payload->>'property_id' = ANY($2::text[])`,
      [principalId, props],
    )
  ).rows;
  return new Set(rows.map((r) => r.id));
}
