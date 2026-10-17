/**
 * AI Intelligence Briefing — PREVIEW ONLY. Builds the briefing from public feeds and shows it; nothing is sent to anyone (there is no recipient,
 * no address and no mail provider here). No model is called: facts are the sources' own words (title, date, link, a trimmed abstract); the only
 * thing Wendy adds is labelled "análise automática simples". A section with nothing relevant says so instead of being filled.
 */
import { parseFeed, type FeedItem } from '../research/feed.js';
import { fetchFeedXml, type FetchLike } from '../research/fetchFeed.js';
import { excerpt, normTitle, scoreItem } from '../research/rank.js';
import { FEED_SOURCES, type FeedSource } from '../research/sources.js';
import { periodDays, personFeed, RUMOUR_RE, SECTIONS, type SectionDef } from './sections.js';

export const NOTHING = 'Nenhuma novidade relevante identificada no período';

export interface BriefingItem {
  title: string;
  url: string;
  source: string;
  /** Date the source published it. The date of the event itself is not in a feed, so it is never guessed. */
  publishedAt: string;
  /** The source's own abstract, trimmed; null when the source gives none (press headlines have none). */
  summary: string | null;
  /** Why it is here, in words (a fact about the item, not an opinion). */
  relevance: string;
  /** 'lab' = the lab's own post; 'press' = coverage by a news outlet (not an official channel). */
  origin: 'lab' | 'press';
}
export interface BriefingSectionOut {
  id: string;
  title: string;
  scope: string;
  items: BriefingItem[];
  /** Set when there are no items: the sentence to show. */
  empty: string | null;
  /** Set when the source could not be read: the limitation, never invented content. */
  unavailable: string | null;
}
export interface Briefing {
  kind: 'PREVIEW';
  title: 'Wendy Intelligence Briefing';
  generatedAt: string;
  period: { from: string; to: string; days: number };
  highlights: BriefingItem[];
  sections: BriefingSectionOut[];
  attention: { label: string; lines: string[] };
  sources: { name: string; url: string; status: 'lida' | 'indisponível'; items: number }[];
  notes: string[];
}

export interface BriefingOptions {
  now: Date;
  days?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  gapMs?: number;
  /** Links already shown in an earlier briefing: not repeated. */
  seenUrls?: ReadonlySet<string>;
  maxPerSection?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DAY = 86_400_000;

/** Google News headlines end with " - Publisher": that is the outlet. */
function splitPublisher(title: string): { headline: string; publisher: string | null } {
  const i = title.lastIndexOf(' - ');
  if (i > 10 && title.length - i <= 60) return { headline: title.slice(0, i).trim(), publisher: title.slice(i + 3).trim() };
  return { headline: title, publisher: null };
}

function labItems(items: readonly FeedItem[], now: Date, days: number, seen: ReadonlySet<string>, max: number): BriefingItem[] {
  const out = items
    .filter((i) => !seen.has(i.url))
    .map((i) => scoreItem(i, now, days * 24))
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.score - a.score || a.item.url.localeCompare(b.item.url))
    .slice(0, max);
  // A placeholder such as "TBD" is not a summary: under 20 characters it is dropped.
  return out.map((r) => ({ title: r.item.title, url: r.item.url, source: r.item.sourceName, publishedAt: r.item.publishedAt!.toISOString(), summary: r.excerpt.length >= 20 ? r.excerpt : null, relevance: r.why.filter((w) => !w.startsWith('Fonte:')).join(' · '), origin: 'lab' as const }));
}

function pressItems(items: readonly FeedItem[], nameRe: RegExp, now: Date, days: number, seen: ReadonlySet<string>, max: number): { items: BriefingItem[]; dropped: number } {
  let dropped = 0;
  const titles = new Set<string>();
  const out: BriefingItem[] = [];
  const sorted = items.filter((i) => i.publishedAt && now.getTime() - i.publishedAt.getTime() <= days * DAY && i.publishedAt.getTime() - now.getTime() < 3_600_000).sort((a, b) => b.publishedAt!.getTime() - a.publishedAt!.getTime() || a.url.localeCompare(b.url));
  for (const i of sorted) {
    if (out.length >= max) break;
    if (seen.has(i.url)) continue;
    const { headline, publisher } = splitPublisher(i.title);
    if (!nameRe.test(headline)) continue; // not about the person
    if (RUMOUR_RE.test(headline)) {
      dropped++;
      continue;
    }
    const key = normTitle(headline);
    if (titles.has(key)) continue;
    titles.add(key);
    out.push({ title: headline, url: i.url, source: publisher ?? i.sourceName, publishedAt: i.publishedAt!.toISOString(), summary: null, relevance: `Citado na imprensa${publisher ? ` (${publisher})` : ''}; o link é do Google Notícias; não é fonte oficial`, origin: 'press' });
  }
  return { items: out, dropped };
}

export async function buildBriefing(o: BriefingOptions): Promise<Briefing> {
  const days = periodDays(o.days ?? 7);
  const max = o.maxPerSection ?? 4;
  const seen = o.seenUrls ?? new Set<string>();
  const sleep = o.sleep ?? defaultSleep;
  const labFeeds = new Map(FEED_SOURCES.map((s) => [s.id, s]));
  const sections: BriefingSectionOut[] = [];
  const sources: Briefing['sources'] = [];
  const notes: string[] = [];
  const topicCount = new Map<string, number>();
  let first = true;

  for (const def of SECTIONS as readonly SectionDef[]) {
    const feed: FeedSource | undefined = def.kind === 'lab' ? labFeeds.get(def.feedId) : personFeed(def, days);
    const base = { id: def.id, title: def.title, scope: def.scope };
    if (!feed) {
      sections.push({ ...base, items: [], empty: null, unavailable: 'fonte não configurada' });
      continue;
    }
    if (!first) await sleep(o.gapMs ?? 1000);
    first = false;
    let parsed: FeedItem[];
    try {
      parsed = parseFeed(await fetchFeedXml(feed.url, { fetchImpl: o.fetchImpl }), feed);
    } catch (e) {
      const why = e instanceof Error ? e.message : 'erro desconhecido';
      sources.push({ name: feed.name, url: feed.url, status: 'indisponível', items: 0 });
      sections.push({ ...base, items: [], empty: null, unavailable: `Não consegui ler esta fonte (${why}). Nada foi inventado no lugar.` });
      continue;
    }
    sources.push({ name: feed.name, url: feed.url, status: 'lida', items: parsed.length });
    if (def.kind === 'lab') {
      const items = labItems(parsed, o.now, days, seen, max);
      for (const it of parsed) {
        const r = scoreItem(it, o.now, days * 24);
        if (r && items.some((x) => x.url === it.url)) for (const w of r.why) if (w.startsWith('Temas: ')) for (const t of w.slice(7).split(', ')) topicCount.set(t, (topicCount.get(t) ?? 0) + 1);
      }
      sections.push({ ...base, items, empty: items.length ? null : NOTHING, unavailable: null });
    } else {
      const { items, dropped } = pressItems(parsed, def.nameRe, o.now, days, seen, max);
      if (dropped) notes.push(`${def.title}: ${dropped} manchete(s) com cara de boato ou sensacionalismo foram deixadas de fora.`);
      sections.push({ ...base, items, empty: items.length ? null : NOTHING, unavailable: null });
    }
  }

  const all = sections.flatMap((s) => s.items);
  // Highlights: the lab posts first (they are the sources the person named), newest first, at most five. Never padded.
  const highlights = [...all].sort((a, b) => (a.origin === b.origin ? 0 : a.origin === 'lab' ? -1 : 1) || b.publishedAt.localeCompare(a.publishedAt)).slice(0, 5);
  const repeated = [...topicCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const attention = {
    label: 'Análise automática simples da Wendy (contagem de temas; não é um modelo de IA e não conhece seus projetos)',
    lines: repeated.length ? repeated.map(([t, n]) => `O tema "${t}" apareceu em ${n} publicações dos laboratórios neste período.`) : [NOTHING],
  };
  if (sections.some((s) => s.unavailable)) notes.push('Alguma fonte não pôde ser lida: veja a seção correspondente.');
  notes.push('Nada deste briefing foi enviado a ninguém. É uma prévia dentro da Wendy.');
  return { kind: 'PREVIEW', title: 'Wendy Intelligence Briefing', generatedAt: o.now.toISOString(), period: { from: new Date(o.now.getTime() - days * DAY).toISOString(), to: o.now.toISOString(), days }, highlights, sections, attention, sources, notes };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });
const safeHref = (u: string) => (/^https:\/\/[^\s"'<>]+$/.test(u) ? u : '#');

function itemHtml(i: BriefingItem): string {
  return `<div style="margin:0 0 16px"><a href="${esc(safeHref(i.url))}" style="color:#2f5d3a;font-weight:600;text-decoration:none">${esc(i.title)}</a><div style="font-size:12px;color:#6b6b60;margin:2px 0">${esc(i.source)} · ${esc(day(i.publishedAt))}${i.origin === 'press' ? ' · imprensa' : ''}</div>${i.summary ? `<div style="font-size:14px;color:#3a3a32;margin:4px 0">${esc(i.summary)} <span style="color:#6b6b60">(trecho da própria fonte)</span></div>` : ''}<div style="font-size:12px;color:#6b6b60">Relevância: ${esc(i.relevance)}</div></div>`;
}

/** A self-contained, responsive HTML page (also what an e-mail would carry). Every value is escaped; links are https only. */
export function renderBriefingHtml(b: Briefing): string {
  const head = (n: number, t: string) => `<h2 style="font-size:18px;margin:28px 0 8px;color:#23301f">${n}. ${esc(t)}</h2>`;
  const parts: string[] = [
    `<div style="background:#f3e9c6;border:1px solid #d9c98a;padding:8px 12px;border-radius:8px;font-size:13px;margin-bottom:16px"><strong>PRÉVIA</strong> — nada foi enviado a ninguém.</div>`,
    `<h1 style="font-size:24px;margin:0 0 4px;color:#23301f">${esc(b.title)}</h1>`,
    `<div style="font-size:13px;color:#6b6b60">${esc(day(b.generatedAt))} · período coberto: ${esc(day(b.period.from))} a ${esc(day(b.period.to))} (${b.period.days} dias)</div>`,
    head(2, 'Resumo executivo'),
    b.highlights.length ? b.highlights.map(itemHtml).join('') : `<p>${esc(NOTHING)}.</p>`,
  ];
  b.sections.forEach((s, idx) => {
    parts.push(head(3 + idx, `${s.title}`), `<div style="font-size:12px;color:#6b6b60;margin-bottom:8px">${esc(s.scope)}</div>`);
    parts.push(s.unavailable ? `<p>${esc(s.unavailable)}</p>` : s.items.length ? s.items.map(itemHtml).join('') : `<p>${esc(s.empty ?? NOTHING)}.</p>`);
  });
  parts.push(head(9, 'O que merece atenção'), `<div style="font-size:12px;color:#6b6b60;margin-bottom:8px">${esc(b.attention.label)}</div>`, ...b.attention.lines.map((l) => `<p style="margin:4px 0">${esc(l)}${l === NOTHING ? '.' : ''}</p>`));
  parts.push(head(10, 'Fontes'), `<ul style="padding-left:18px;font-size:13px">${b.sources.map((s) => `<li>${esc(s.name)} — ${s.status === 'lida' ? `lida (${s.items} itens no feed)` : 'indisponível'}</li>`).join('')}</ul>`);
  parts.push(...b.notes.map((n) => `<p style="font-size:12px;color:#6b6b60">${esc(n)}</p>`));
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(b.title)}</title></head><body style="margin:0;background:#f7f3e8;font-family:Georgia,serif;color:#23301f"><div style="max-width:640px;margin:0 auto;padding:24px 16px">${parts.join('')}</div></body></html>`;
}
