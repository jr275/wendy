/**
 * Which items make the daily reading list, and WHY. Deterministic and explainable: no model, no randomness, nothing invented. Every item carries
 * the reasons it was picked, in words, and its "summary" is the source's own abstract trimmed to a few sentences (labelled as such by the UI).
 */
import type { FeedItem } from './feed.js';
import { FEED_SOURCES, TOPICS } from './sources.js';

export interface RankOptions {
  now: Date;
  /** Items older than this are not considered. */
  maxAgeHours?: number;
  limit?: number;
  /** Places reserved for the best papers (arXiv is a firehose that would otherwise never reach the list). */
  paperQuota?: number;
  /** Links already delivered: never repeated. */
  seenUrls?: ReadonlySet<string>;
}

export interface RankedItem {
  item: FeedItem;
  score: number;
  /** Reasons in pt-BR, ready to show. */
  why: string[];
  excerpt: string;
}

const SOURCE_WEIGHT = new Map(FEED_SOURCES.map((s) => [s.id, s.weight]));
const HOUR = 3_600_000;

export const normTitle = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** A short excerpt of the source's own summary, ending on a sentence when there is one. */
export function excerpt(summary: string, max = 280): string {
  const s = summary.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > max * 0.5 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

function ago(hours: number): string {
  if (hours < 1) return 'há menos de 1 h';
  if (hours < 24) return `há ${Math.floor(hours)} h`;
  const d = Math.floor(hours / 24);
  return d === 1 ? 'há 1 dia' : `há ${d} dias`;
}

export function scoreItem(item: FeedItem, now: Date, maxAgeHours: number): RankedItem | null {
  if (!item.publishedAt) return null; // an undated item cannot be called "new"
  const age = (now.getTime() - item.publishedAt.getTime()) / HOUR;
  if (age < -1 || age > maxAgeHours) return null; // future-dated (a clock error) or too old
  const matched = TOPICS.filter((t) => t.re.test(item.topicsText));
  const topicScore = Math.min(3, matched.reduce((a, t) => a + t.weight, 0));
  if (item.kind === 'paper' && matched.length === 0) return null; // a paper with no theme of interest is noise
  const recency = Math.max(0, 3 * (1 - Math.max(0, age) / maxAgeHours));
  const source = SOURCE_WEIGHT.get(item.sourceId) ?? 1;
  const score = Math.round((source + recency + topicScore) * 100) / 100;
  const why = [`Publicado ${ago(Math.max(0, age))}`, `Fonte: ${item.sourceName}`];
  if (matched.length) why.push(`Temas: ${matched.slice(0, 3).map((t) => t.label).join(', ')}`);
  return { item, score, why, excerpt: excerpt(item.summary) };
}

export function rankItems(items: readonly FeedItem[], o: RankOptions): RankedItem[] {
  const maxAge = o.maxAgeHours ?? 72;
  const limit = o.limit ?? 8;
  const paperQuota = o.paperQuota ?? 3;
  const seen = o.seenUrls ?? new Set<string>();
  const scored = items
    .filter((i) => !seen.has(i.url))
    .map((i) => scoreItem(i, o.now, maxAge))
    .filter((r): r is RankedItem => r !== null)
    .sort((a, b) => b.score - a.score || b.item.publishedAt!.getTime() - a.item.publishedAt!.getTime() || a.item.url.localeCompare(b.item.url));
  const titles = new Set<string>();
  const take = (pool: RankedItem[], n: number): RankedItem[] => {
    const out: RankedItem[] = [];
    for (const r of pool) {
      if (out.length >= n) break;
      const key = normTitle(r.item.title);
      if (titles.has(key)) continue; // the same story from two sources: once
      titles.add(key);
      out.push(r);
    }
    return out;
  };
  // Papers are a firehose that would never outrank a lab's own post, so a few places are RESERVED for the best papers; blogs and news fill the rest
  // (and take any place a missing paper leaves free). The list is then ordered by score.
  const papers = take(scored.filter((r) => r.item.kind === 'paper'), Math.min(paperQuota, limit));
  const rest = take(scored.filter((r) => r.item.kind !== 'paper'), limit - papers.length);
  return [...papers, ...rest].sort((a, b) => b.score - a.score || b.item.publishedAt!.getTime() - a.item.publishedAt!.getTime() || a.item.url.localeCompare(b.item.url));
}
