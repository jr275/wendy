/**
 * Google Search Console sensor — read-only (scope webmasters.readonly).
 *
 * Fetches, per web property, two aggregated windows ending at the latest final day (Search Console
 * data lags ~3 days): CURRENT = last 7 days, BASELINE = the 28 days before. For each window it
 * stores the site total and the top pages and queries (by clicks), plus 90 days of daily totals.
 * Nothing is interpreted here; the detector compares windows, the reasoner explains.
 */
import { GoogleAuth } from 'google-auth-library';
import { withTx, type Db, type Queryable } from '../db/db.js';
import { DAY_MS } from '../util/clock.js';
import { newId } from '../util/hash.js';

export const SEARCH_SYNC_CONFIG = {
  dataLagDays: 3, // Search Console "final" data is ~2–3 days behind
  currentDays: 7,
  baselineDays: 28,
  rowLimit: 5000, // top rows by clicks per window and dimension
  dailyTotalsDays: 90,
};

export interface WebProperty {
  id: string;
  principal_id: string;
  site_url: string;
  label: string;
  explicit_importance: number | null;
}

export interface SearchRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchConsoleApi {
  query(siteUrl: string, body: Record<string, unknown>): Promise<SearchRow[]>;
}

/** Real client: Application Default Credentials (gcloud login with webmasters.readonly). */
export class GoogleSearchConsoleApi implements SearchConsoleApi {
  private readonly auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] });

  async query(siteUrl: string, body: Record<string, unknown>): Promise<SearchRow[]> {
    const token = await this.auth.getAccessToken();
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(project ? { 'x-goog-user-project': project } : {}) },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { rows?: SearchRow[]; error?: { message?: string } };
    if (!res.ok) throw new Error(`Search Console ${res.status}: ${json.error?.message ?? 'error'}`);
    return json.rows ?? [];
  }
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const shift = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);

export function windowsFor(now: Date) {
  const c = SEARCH_SYNC_CONFIG;
  const end = shift(new Date(`${day(now)}T00:00:00Z`), -c.dataLagDays);
  const currentStart = shift(end, -(c.currentDays - 1));
  const baselineEnd = shift(currentStart, -1);
  const baselineStart = shift(baselineEnd, -(c.baselineDays - 1));
  return {
    current: { start: day(currentStart), end: day(end) },
    baseline: { start: day(baselineStart), end: day(baselineEnd) },
    daily: { start: day(shift(end, -(c.dailyTotalsDays - 1))), end: day(end) },
  };
}

export async function addWebProperty(q: Queryable, principalId: string, p: { siteUrl: string; label: string; importance?: number | null; source: string }): Promise<string> {
  const existing = (await q.query<{ id: string }>('SELECT id FROM web_properties WHERE principal_id = $1 AND site_url = $2', [principalId, p.siteUrl])).rows[0];
  if (existing) return existing.id;
  const id = newId();
  await q.query('INSERT INTO web_properties(id, principal_id, site_url, label, explicit_importance, source) VALUES ($1,$2,$3,$4,$5,$6)', [id, principalId, p.siteUrl, p.label, p.importance ?? null, p.source]);
  return id;
}

export async function listWebProperties(q: Queryable, principalId: string): Promise<WebProperty[]> {
  return (await q.query<WebProperty>('SELECT id, principal_id, site_url, label, explicit_importance FROM web_properties WHERE principal_id = $1 ORDER BY label', [principalId])).rows;
}

/** Fetches and stores both windows (total/page/query) and daily totals for one property. Idempotent. */
export async function syncProperty(db: Db, api: SearchConsoleApi, property: WebProperty, now: Date) {
  const w = windowsFor(now);
  const counts: Record<string, number> = {};
  const fetched = new Date();
  for (const [name, win] of Object.entries({ current: w.current, baseline: w.baseline })) {
    const total = await api.query(property.site_url, { startDate: win.start, endDate: win.end, dataState: 'final' });
    const pages = await api.query(property.site_url, { startDate: win.start, endDate: win.end, dimensions: ['page'], rowLimit: SEARCH_SYNC_CONFIG.rowLimit, dataState: 'final' });
    const queries = await api.query(property.site_url, { startDate: win.start, endDate: win.end, dimensions: ['query'], rowLimit: SEARCH_SYNC_CONFIG.rowLimit, dataState: 'final' });
    await withTx(db, async (tx) => {
      const put = async (dimension: 'total' | 'page' | 'query', key: string, r: SearchRow) =>
        tx.query(
          `INSERT INTO search_metric_windows(id, principal_id, property_id, window_start, window_end, dimension, key, clicks, impressions, ctr, position, row_limit, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (property_id, window_start, window_end, dimension, key)
           DO UPDATE SET clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, ctr = EXCLUDED.ctr, position = EXCLUDED.position, row_limit = EXCLUDED.row_limit, fetched_at = EXCLUDED.fetched_at`,
          [newId(), property.principal_id, property.id, win.start, win.end, dimension, key, r.clicks, r.impressions, r.ctr, r.position, SEARCH_SYNC_CONFIG.rowLimit, fetched],
        );
      await put('total', '', total[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 });
      for (const r of pages) await put('page', r.keys![0]!, r);
      for (const r of queries) await put('query', r.keys![0]!, r);
    });
    counts[`${name}_pages`] = pages.length;
    counts[`${name}_queries`] = queries.length;
  }
  const daily = await api.query(property.site_url, { startDate: w.daily.start, endDate: w.daily.end, dimensions: ['date'], rowLimit: 1000, dataState: 'final' });
  await withTx(db, async (tx) => {
    for (const r of daily)
      await tx.query(
        `INSERT INTO search_daily_totals(property_id, date, clicks, impressions, ctr, position, fetched_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (property_id, date) DO UPDATE SET clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, ctr = EXCLUDED.ctr, position = EXCLUDED.position, fetched_at = EXCLUDED.fetched_at`,
        [property.id, r.keys![0], r.clicks, r.impressions, r.ctr, r.position, fetched],
      );
    await tx.query('UPDATE web_properties SET last_synced_at = $2 WHERE id = $1', [property.id, fetched]);
  });
  counts.daily = daily.length;
  return { windows: w, counts };
}

/** Syncs every property whose last sync is older than `minIntervalHours` (any principal). Errors are reported, never thrown. */
export async function syncDueProperties(db: Db, api: SearchConsoleApi, now: Date, minIntervalHours = 20) {
  const due = (
    await db.query<WebProperty>(
      `SELECT id, principal_id, site_url, label, explicit_importance FROM web_properties
       WHERE last_synced_at IS NULL OR last_synced_at < $1 ORDER BY label`,
      [new Date(now.getTime() - minIntervalHours * 3_600_000)],
    )
  ).rows;
  const results: { label: string; ok: boolean; detail: string }[] = [];
  for (const p of due) {
    try {
      const r = await syncProperty(db, api, p, now);
      results.push({ label: p.label, ok: true, detail: `${r.windows.current.start}..${r.windows.current.end}` });
    } catch (e) {
      results.push({ label: p.label, ok: false, detail: (e as Error).message });
    }
  }
  return results;
}
