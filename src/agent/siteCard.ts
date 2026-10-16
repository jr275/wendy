/** Deterministic website card data (no model involved): series, windows and largest movers. */
import type { Queryable } from '../db/db.js';
import { siteChangeContributors } from '../sensors/searchDetector.js';
import { inSearchScope } from '../sensors/searchScope.js';

export interface SiteCard {
  propertyId: string;
  label: string;
  siteUrl: string;
  importance: number | null;
  daily: { date: string; clicks: number; impressions: number }[];
  current: { start: string; end: string; clicks: number; impressions: number; ctr: number; position: number } | null;
  baseline: { start: string; end: string; clicks: number; impressions: number; ctr: number; position: number } | null;
  baselineWeekly: { clicks: number; impressions: number } | null;
  movers: { dimension: 'page' | 'query'; key: string; deltaClicks: number; deltaImpressions: number }[];
  direction: 'DROP' | 'RISE' | null;
  /** Where the last window's clicks came from: top pages + the rest (sums to the window total). */
  topPages: { key: string; clicks: number }[];
}

/** Top pages by clicks in one window, plus "rest" so the parts add up to the site total. */
export async function topPages(q: Queryable, propertyId: string, windowEnd: string, totalClicks: number, limit = 4): Promise<{ key: string; clicks: number }[]> {
  const rows = (
    await q.query<{ key: string; clicks: number }>(
      `SELECT key, clicks FROM search_metric_windows WHERE property_id = $1 AND dimension = 'page' AND window_end = $2 AND clicks > 0 ORDER BY clicks DESC, key LIMIT $3`,
      [propertyId, windowEnd, limit],
    )
  ).rows;
  const rest = totalClicks - rows.reduce((a, r) => a + r.clicks, 0);
  return rest > 0 ? [...rows, { key: '', clicks: rest }] : rows;
}

export async function siteCard(q: Queryable, principalId: string, propertyId: string): Promise<SiteCard | null> {
  const p = (await q.query<{ id: string; label: string; site_url: string; explicit_importance: number | null }>('SELECT id, label, site_url, explicit_importance FROM web_properties WHERE principal_id = $1 AND id = $2', [principalId, propertyId])).rows[0];
  if (!p || !inSearchScope(p)) return null;
  const daily = (await q.query<{ date: string; clicks: number; impressions: number }>(`SELECT to_char(date,'YYYY-MM-DD') AS date, clicks, impressions FROM search_daily_totals WHERE property_id = $1 ORDER BY date`, [p.id])).rows;
  const w = (
    await q.query<{ start: string; end: string; clicks: number; impressions: number; ctr: number; position: number }>(
      `SELECT to_char(window_start,'YYYY-MM-DD') AS start, to_char(window_end,'YYYY-MM-DD') AS "end", clicks, impressions, ctr, position
       FROM search_metric_windows WHERE property_id = $1 AND dimension = 'total' ORDER BY window_end DESC LIMIT 2`,
      [p.id],
    )
  ).rows;
  const current = w[0] ?? null;
  const baseline = w[1] ?? null;
  const baselineWeekly = baseline ? { clicks: Math.round((baseline.clicks / 4) * 10) / 10, impressions: Math.round(baseline.impressions / 4) } : null;
  const direction = current && baselineWeekly ? (current.clicks < baselineWeekly.clicks ? 'DROP' : 'RISE') : null;
  const movers = current && baseline && direction ? (await siteChangeContributors(q, p.id, current.end, baseline.end, direction, 5)).map(({ dimension, key, deltaClicks, deltaImpressions }) => ({ dimension, key, deltaClicks, deltaImpressions })) : [];
  const pages = current ? await topPages(q, p.id, current.end, current.clicks) : [];
  return { propertyId: p.id, label: p.label, siteUrl: p.site_url, importance: p.explicit_importance, daily, current, baseline, baselineWeekly, movers, direction, topPages: pages };
}
