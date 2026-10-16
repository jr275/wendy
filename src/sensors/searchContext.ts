/**
 * Search Console evidence for questions: resolves websites by their stored label / URL against the
 * search terms the understanding step produced (the same kind of deterministic entity resolution used
 * for people), and returns the latest window totals plus the largest movers as citable records.
 */
import type { Queryable } from '../db/db.js';
import { DAY_MS } from '../util/clock.js';
import { siteChangeContributors } from './searchDetector.js';
import { inSearchScope } from './searchScope.js';

export interface SearchEvidenceItem {
  id: string;
  at: Date;
  text: string;
  meta: Record<string, unknown>;
}

interface MetricRow {
  id: string;
  window_start: string;
  window_end: string;
  dimension: string;
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export function renderSearchMetric(label: string, siteUrl: string, r: MetricRow): string {
  const days = Math.round((Date.parse(r.window_end) - Date.parse(r.window_start)) / DAY_MS) + 1;
  return `Search Console, ${label} (${siteUrl}), ${r.dimension === 'total' ? 'whole site' : `${r.dimension}: ${r.key}`}, ${r.window_start} to ${r.window_end} (${days} days): clicks ${r.clicks}, impressions ${r.impressions}, CTR ${(r.ctr * 100).toFixed(2)}%, average position ${r.position.toFixed(1)}`;
}

const ROW_SQL = `SELECT id, to_char(window_start,'YYYY-MM-DD') AS window_start, to_char(window_end,'YYYY-MM-DD') AS window_end, dimension, key, clicks, impressions, ctr, position
                 FROM search_metric_windows`;

export async function searchEvidenceForTerms(q: Queryable, principalId: string, terms: string[]): Promise<SearchEvidenceItem[]> {
  const clean = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 3))].slice(0, 20);
  if (!clean.length) return [];
  const props = (
    await q.query<{ id: string; label: string; site_url: string }>(
      `SELECT id, label, site_url FROM web_properties
       WHERE principal_id = $1 AND EXISTS (SELECT 1 FROM unnest($2::text[]) t WHERE label ILIKE '%' || t || '%' OR site_url ILIKE '%' || t || '%')`,
      [principalId, clean],
    )
  ).rows.filter((p) => inSearchScope(p)); // only the properties the principal chose to consider (searchScope.ts)
  const out: SearchEvidenceItem[] = [];
  for (const p of props) {
    const totals = (await q.query<MetricRow>(`${ROW_SQL} WHERE property_id = $1 AND dimension = 'total' ORDER BY window_end DESC LIMIT 2`, [p.id])).rows;
    if (totals.length < 2) continue;
    const [cur, base] = totals as [MetricRow, MetricRow];
    const direction = cur.clicks - base.clicks / 4 < 0 ? 'DROP' : 'RISE';
    const movers = await siteChangeContributors(q, p.id, cur.window_end, base.window_end, direction, 3);
    const moverRows = movers.length ? (await q.query<MetricRow>(`${ROW_SQL} WHERE id = ANY($1::uuid[])`, [movers.flatMap((m) => [m.currentRowId, m.baselineRowId])])).rows : [];
    for (const r of [cur, base, ...moverRows])
      out.push({ id: r.id, at: new Date(`${r.window_end}T23:59:59Z`), text: renderSearchMetric(p.label, p.site_url, r), meta: { property_id: p.id, dimension: r.dimension, window_end: r.window_end } });
  }
  return out;
}
