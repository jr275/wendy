/**
 * Search performance detector — deterministic, over stored Search Console windows.
 *
 * Compares CURRENT (last 7 days) with BASELINE (the 28 days before, normalized to one week) and
 * emits SEARCH_PERFORMANCE_CHANGE events only for changes that are both large and backed by enough
 * volume (thresholds below are policy, not scores). Payloads carry references to the metric rows and
 * the numbers computed here; the reasoner never sees a number that did not come from these rows.
 *
 * Honesty rules: a page/query missing from the CURRENT top rows is "unknown", never "zero"; at most
 * N events per property and window (largest changes first); idempotent per property/window/change.
 */
import type { Db, Queryable } from '../db/db.js';
import { ingestEvent } from '../events/ingest.js';
import { SEARCH_SYNC_CONFIG, type WebProperty } from './searchConsole.js';

export const SEARCH_DETECTOR_CONFIG = {
  siteClicksChangePct: 0.2, // whole site: ±20% weekly clicks
  siteMinBaselineWeeklyClicks: 20,
  pageMinBaselineWeeklyClicks: 30,
  pageDropPct: 0.3,
  pageRisePct: 0.5,
  queryMinWeeklyImpressions: 300,
  queryPositionWorseBy: 3, // average position got worse by at least this many places
  maxEventsPerPropertyWindow: 5,
};

export type SearchChangeKind = 'SITE_CLICKS_DROP' | 'SITE_CLICKS_RISE' | 'PAGE_CLICKS_DROP' | 'PAGE_CLICKS_RISE' | 'QUERY_POSITION_DROP';

interface Row {
  id: string;
  dimension: 'total' | 'page' | 'query';
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchChange {
  kind: SearchChangeKind;
  dimension: 'total' | 'page' | 'query';
  key: string;
  currentRowId: string;
  baselineRowId: string;
  baselineWeekly: { clicks: number; impressions: number; position: number };
  current: { clicks: number; impressions: number; position: number };
  changePct: number | null; // clicks change vs baseline weekly
  positionDelta: number | null; // positive = worse
  magnitude: number; // for ranking only
}

const WEEKS_IN_BASELINE = SEARCH_SYNC_CONFIG.baselineDays / SEARCH_SYNC_CONFIG.currentDays;
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Pure comparison of two windows of rows (exported for tests). */
export function compareWindows(current: Row[], baseline: Row[]): SearchChange[] {
  const c = SEARCH_DETECTOR_CONFIG;
  const cur = new Map(current.map((r) => [`${r.dimension}|${r.key}`, r]));
  const out: SearchChange[] = [];
  const weekly = (r: Row) => ({ clicks: r.clicks / WEEKS_IN_BASELINE, impressions: r.impressions / WEEKS_IN_BASELINE, position: r.position });

  for (const b of baseline) {
    const now = cur.get(`${b.dimension}|${b.key}`);
    if (!now) continue; // not in current top rows: unknown, never assumed zero
    const bw = weekly(b);
    const base = { baselineWeekly: { clicks: round1(bw.clicks), impressions: round1(bw.impressions), position: round1(bw.position) }, current: { clicks: now.clicks, impressions: now.impressions, position: round1(now.position) } };
    const pct = bw.clicks > 0 ? (now.clicks - bw.clicks) / bw.clicks : null;

    if (b.dimension === 'total' && bw.clicks >= c.siteMinBaselineWeeklyClicks && pct !== null && Math.abs(pct) >= c.siteClicksChangePct) {
      out.push({ kind: pct < 0 ? 'SITE_CLICKS_DROP' : 'SITE_CLICKS_RISE', dimension: 'total', key: '', currentRowId: now.id, baselineRowId: b.id, ...base, changePct: round1(pct * 100), positionDelta: round1(now.position - bw.position), magnitude: Number.MAX_SAFE_INTEGER });
    }
    if (b.dimension === 'page' && bw.clicks >= c.pageMinBaselineWeeklyClicks && pct !== null) {
      if (pct <= -c.pageDropPct || pct >= c.pageRisePct)
        out.push({ kind: pct < 0 ? 'PAGE_CLICKS_DROP' : 'PAGE_CLICKS_RISE', dimension: 'page', key: b.key, currentRowId: now.id, baselineRowId: b.id, ...base, changePct: round1(pct * 100), positionDelta: round1(now.position - bw.position), magnitude: Math.abs(now.clicks - bw.clicks) });
    }
    if (b.dimension === 'query' && bw.impressions >= c.queryMinWeeklyImpressions) {
      const delta = now.position - bw.position;
      if (delta >= c.queryPositionWorseBy)
        out.push({ kind: 'QUERY_POSITION_DROP', dimension: 'query', key: b.key, currentRowId: now.id, baselineRowId: b.id, ...base, changePct: pct === null ? null : round1(pct * 100), positionDelta: round1(delta), magnitude: delta * bw.impressions });
    }
  }
  return out.sort((a, b) => b.magnitude - a.magnitude).slice(0, c.maxEventsPerPropertyWindow);
}

async function latestWindows(q: Queryable, propertyId: string) {
  const ends = (
    await q.query<{ window_start: string; window_end: string }>(
      `SELECT DISTINCT to_char(window_start, 'YYYY-MM-DD') AS window_start, to_char(window_end, 'YYYY-MM-DD') AS window_end
       FROM search_metric_windows WHERE property_id = $1 ORDER BY window_end DESC LIMIT 2`,
      [propertyId],
    )
  ).rows;
  if (ends.length < 2) return null;
  const [current, baseline] = ends as [{ window_start: string; window_end: string }, { window_start: string; window_end: string }];
  const rows = async (w: { window_start: string; window_end: string }) =>
    (await q.query<Row>('SELECT id, dimension, key, clicks, impressions, ctr, position FROM search_metric_windows WHERE property_id = $1 AND window_start = $2 AND window_end = $3', [propertyId, w.window_start, w.window_end])).rows;
  return { current, baseline, currentRows: await rows(current), baselineRows: await rows(baseline) };
}

/** Emits events for the latest stored windows of every property. Idempotent. */
export async function runSearchDetector(db: Db, principalId: string, properties: WebProperty[], now: Date): Promise<string[]> {
  const emitted: string[] = [];
  for (const p of properties) {
    const w = await latestWindows(db, p.id);
    if (!w) continue;
    for (const ch of compareWindows(w.currentRows, w.baselineRows)) {
      const { event, duplicate } = await ingestEvent(db, {
        principalId,
        eventType: 'SEARCH_PERFORMANCE_CHANGE',
        source: 'DETECTOR',
        sourceEventKey: `search:${p.id}:${w.current.window_end}:${ch.kind}:${ch.dimension}:${ch.key}`,
        occurredAt: now,
        actor: { kind: 'DETECTOR' },
        entityRefs: [],
        payload: {
          property_id: p.id,
          site_url: p.site_url,
          current_window: w.current,
          baseline_window: w.baseline,
          change: { ...ch, magnitude: undefined },
        },
        confidence: 1,
        provenance: { origin: 'DETECTOR', detector: 'search-console-v1' },
      });
      if (!duplicate) emitted.push(event.id);
    }
  }
  return emitted;
}
