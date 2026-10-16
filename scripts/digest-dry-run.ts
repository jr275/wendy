/** npx tsx scripts/digest-dry-run.ts — fetches the real public feeds and prints the ranked digest. Reads the internet; writes NOTHING (no database). */
import { fetchFeedXml } from '../src/research/fetchFeed.js';
import { parseFeed, type FeedItem } from '../src/research/feed.js';
import { rankItems } from '../src/research/rank.js';
import { FEED_SOURCES } from '../src/research/sources.js';

const all: FeedItem[] = [];
for (const [i, s] of FEED_SOURCES.entries()) {
  if (i) await new Promise((r) => setTimeout(r, 1200));
  try {
    const items = parseFeed(await fetchFeedXml(s.url), s);
    console.log(`ok   ${s.id.padEnd(22)} ${items.length} itens`);
    all.push(...items);
  } catch (e) {
    console.log(`FAIL ${s.id.padEnd(22)} ${(e as Error).message.slice(0, 80)}`);
  }
}
const ranked = rankItems(all, { now: new Date(), limit: 8, seenUrls: new Set() });
console.log(`\n== ${ranked.length} escolhidos de ${all.length} ==`);
for (const r of ranked) console.log(`\n[${r.score.toFixed(2)}] ${r.item.title}\n  ${r.item.sourceName} · ${r.item.publishedAt?.toISOString().slice(0, 10)}\n  porquê: ${r.why.join(' · ')}\n  ${r.item.url}\n  “${r.excerpt.slice(0, 160)}…”`);
