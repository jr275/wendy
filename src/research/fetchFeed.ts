/**
 * Fetches one feed, safely. `fetch` is injected, so tests need no network.
 *  - https only, and only the hosts in sources.ts (the same check on every redirect: a feed cannot send us somewhere else);
 *  - a size cap while reading (a huge or endless body is cut off, not stored), a timeout, and an XML content type;
 *  - no cookies, no credentials, an honest User-Agent; and nothing from the response is ever executed.
 */
import { FeedError, MAX_FEED_CHARS } from './feed.js';
import { ALLOWED_FEED_HOSTS } from './sources.js';

export interface FetchLike {
  (url: string, init: { headers: Record<string, string>; redirect: 'manual'; signal?: AbortSignal }): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
    text(): Promise<string>;
  }>;
}

export const USER_AGENT = 'wendy-research-digest/1.0 (personal assistant; reads public RSS/Atom feeds)';
const MAX_REDIRECTS = 3;

export const isAllowedFeedUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && ALLOWED_FEED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
};

async function readLimited(res: Awaited<ReturnType<FetchLike>>): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const t = await res.text();
    if (t.length > MAX_FEED_CHARS) throw new FeedError('feed grande demais');
    return t;
  }
  const dec = new TextDecoder('utf-8');
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
    if (out.length > MAX_FEED_CHARS) {
      await reader.cancel().catch(() => undefined);
      throw new FeedError('feed grande demais');
    }
  }
  return out + dec.decode();
}

export async function fetchFeedXml(url: string, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<string> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init) as ReturnType<FetchLike>);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedFeedUrl(current)) throw new FeedError('endereço de feed não permitido');
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(current, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9' }, redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
    } catch {
      throw new FeedError('não consegui falar com a fonte');
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new FeedError('redirecionamento sem destino');
      current = new URL(loc, current).toString(); // re-checked at the top of the loop
      continue;
    }
    if (res.status === 429) throw new FeedError('a fonte limitou as consultas');
    if (res.status < 200 || res.status >= 300) throw new FeedError(`a fonte respondeu ${res.status}`);
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!/xml|rss|atom/.test(type)) throw new FeedError('a fonte não devolveu um feed');
    return readLimited(res);
  }
  throw new FeedError('redirecionamentos demais');
}
