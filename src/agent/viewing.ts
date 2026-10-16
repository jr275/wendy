/**
 * Shared state from the UI: what the principal has on screen while asking (CopilotKit agent state).
 *
 * The browser only says *which kind of thing* and *which id*. Everything else is resolved here, from
 * the database, scoped to the principal — an id that is not theirs is ignored, never trusted.
 * The result is context for understanding ("isso", "este site") and extra retrieval terms; it is not
 * evidence by itself, so it can never make a claim valid.
 */
import { z } from 'zod';
import type { Queryable } from '../db/db.js';
import { inSearchScope } from '../sensors/searchScope.js';

export const ViewingSchema = z.object({
  kind: z.enum(['today', 'sites', 'site', 'insight']),
  id: z.uuid().optional(),
});
export type Viewing = z.infer<typeof ViewingSchema>;

export interface ResolvedViewing {
  /** For the model, in English like the rest of the prompt. */
  description: string;
  /** Short pt-BR label the UI shows back ("Vendo agora: …"). */
  label: string;
  searchTerms: string[];
}

export async function resolveViewing(q: Queryable, principalId: string, raw: unknown): Promise<ResolvedViewing | null> {
  const parsed = ViewingSchema.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;

  if (v.kind === 'today') return { description: "the Today overview (what needs the principal's attention)", label: 'Hoje', searchTerms: [] };

  if (v.kind === 'sites') {
    const sites = (await q.query<{ label: string; site_url: string }>('SELECT label, site_url FROM web_properties WHERE principal_id = $1 ORDER BY label', [principalId])).rows.filter((s) => inSearchScope(s));
    return { description: `the list of the principal's websites (${sites.map((s) => s.label).join(', ')})`, label: 'Sites', searchTerms: sites.map((s) => s.label) };
  }

  if (!v.id) return null;

  if (v.kind === 'site') {
    const s = (await q.query<{ label: string; site_url: string }>('SELECT label, site_url FROM web_properties WHERE id = $1 AND principal_id = $2', [v.id, principalId])).rows[0];
    return s && inSearchScope(s) ? { description: `the website "${s.label}" (${s.site_url}) and its Search Console numbers`, label: s.label, searchTerms: [s.label] } : null;
  }

  const i = (
    await q.query<{ headline: string | null; site_label: string | null }>(
      `SELECT i.headline, w.label AS site_label
         FROM insights i
         JOIN events e ON e.id = i.event_id
         LEFT JOIN web_properties w ON w.principal_id = i.principal_id AND w.id::text = e.payload->>'property_id'
        WHERE i.id = $1 AND i.principal_id = $2`,
      [v.id, principalId],
    )
  ).rows[0];
  if (!i) return null;
  const headline = i.headline?.replace(/\s*\[[A-Z]+\d+\]/g, '') ?? 'an insight';
  return {
    description: `an insight Wendy raised earlier: "${headline}"${i.site_label ? ` (about the website "${i.site_label}")` : ''}`,
    label: i.site_label ? `Insight · ${i.site_label}` : 'Insight',
    searchTerms: i.site_label ? [i.site_label] : [],
  };
}
