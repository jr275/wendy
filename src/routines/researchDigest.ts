/**
 * The "research_digest" routine: the best new reading in machine learning, AI and science, from the sources in src/research/sources.ts.
 * Deterministic and explained (src/research/rank.ts); the summary is the source's own abstract, shortened. No model is called, nothing is invented.
 */
import { fetchFeedXml, type FetchLike } from '../research/fetchFeed.js';
import { parseFeed, type FeedItem } from '../research/feed.js';
import { rankItems } from '../research/rank.js';
import { FEED_SOURCES, type FeedSource } from '../research/sources.js';
import type { RoutineHandler } from './runner.js';

export interface DigestDeps {
  fetchImpl?: FetchLike;
  /** Pause between feeds (arXiv asks for a few seconds between requests). */
  sleep?: (ms: number) => Promise<void>;
  sources?: readonly FeedSource[];
  gapMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function researchDigestHandler(deps: DigestDeps = {}): RoutineHandler {
  return async ({ db, principalId, config, now }) => {
    const wanted = Array.isArray(config.sources) ? new Set((config.sources as unknown[]).filter((x): x is string => typeof x === 'string')) : null;
    const sources = (deps.sources ?? FEED_SOURCES).filter((s) => !wanted || wanted.has(s.id));
    const limit = typeof config.limit === 'number' && config.limit >= 1 && config.limit <= 20 ? Math.floor(config.limit) : 8;
    const all: FeedItem[] = [];
    const failed: string[] = [];
    for (const [i, s] of sources.entries()) {
      if (i > 0) await (deps.sleep ?? defaultSleep)(deps.gapMs ?? 1500);
      try {
        all.push(...parseFeed(await fetchFeedXml(s.url, { fetchImpl: deps.fetchImpl }), s));
      } catch {
        failed.push(s.id);
      }
    }
    if (failed.length === sources.length) throw new Error('nenhuma das fontes respondeu');
    const seen = new Set((await db.query<{ source_url: string }>(`SELECT source_url FROM digest_items WHERE principal_id = $1 AND created_at > $2`, [principalId, new Date(now.getTime() - 90 * 86_400_000)])).rows.map((r) => r.source_url));
    const ranked = rankItems(all, { now, limit, seenUrls: seen });
    return {
      items: ranked.map((r) => ({
        kind: 'article' as const,
        sourceName: r.item.sourceName,
        sourceUrl: r.item.url,
        title: r.item.title,
        publishedAt: r.item.publishedAt,
        summary: r.excerpt || null,
        why: r.why.join(' · '),
        score: r.score,
        evidence: { sourceId: r.item.sourceId, sourceKind: r.item.kind, summaryIs: 'trecho do resumo da própria fonte' },
      })),
      ...(failed.length ? { note: `Algumas fontes não responderam: ${failed.join(', ')}` } : {}),
    };
  };
}
