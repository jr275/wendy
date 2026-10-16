/**
 * Feed text → plain, safe items. Pure: no network, no clock.
 *
 * Everything inside a feed is written by a third party, so it is DATA: it is parsed, cleaned and capped here, and shown as plain text. It is never
 * given to a model as an instruction and never fetched (only its link is shown to the person, who decides whether to open it).
 */
import { XMLParser } from 'fast-xml-parser';
import type { FeedSource } from './sources.js';

export interface FeedItem {
  sourceId: string;
  sourceName: string;
  kind: FeedSource['kind'];
  title: string;
  url: string;
  publishedAt: Date | null;
  /** Plain text taken from the feed's own summary (an abstract/description); never generated. */
  summary: string;
  topicsText: string; // title + summary, for matching
}

export const MAX_FEED_CHARS = 3_000_000;
export const TITLE_MAX = 200;
export const SUMMARY_MAX = 600;

export class FeedError extends Error {}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export function plainText(raw: unknown, max: number): string {
  // A string, or an element with only text. An element with NESTED elements (raw HTML inside the XML) has lost the order of its text in parsing: it is
  // treated as having no text, because a missing summary is better than a scrambled one.
  let s = typeof raw === 'string' ? raw : typeof raw === 'object' && raw && '#text' in raw && Object.keys(raw).every((k) => k === '#text' || k.startsWith('@_')) ? String((raw as { '#text': unknown })['#text']) : '';
  s = s.replace(/<!\[CDATA\[|\]\]>/g, ' ').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  s = s.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** https only, no credentials, no fragment, no tracking parameters. http://arxiv.org and http://bair.berkeley.edu (feeds that still emit http links) are upgraded; any other http link is dropped. */
export function cleanLink(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol === 'http:' && /(^|\.)(arxiv\.org|bair\.berkeley\.edu)$/.test(u.hostname)) u.protocol = 'https:';
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ref$|ref_)/i.test(k)) u.searchParams.delete(k);
  const out = u.toString();
  return out.length <= 500 ? out : null;
}

const toArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

function linkOf(item: Record<string, unknown>): string | null {
  const l = item.link;
  if (typeof l === 'string') return cleanLink(l);
  for (const x of toArray(l as unknown)) {
    if (typeof x === 'string') return cleanLink(x);
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (!o['@_rel'] || o['@_rel'] === 'alternate') return cleanLink(o['@_href'] ?? o['#text']);
    }
  }
  return cleanLink(item.guid && typeof item.guid === 'object' ? (item.guid as Record<string, unknown>)['#text'] : item.guid);
}

function dateOf(item: Record<string, unknown>): Date | null {
  for (const k of ['pubDate', 'published', 'updated', 'date']) {
    const raw = text(item[k]);
    const s = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && '#text' in raw ? String((raw as { '#text': unknown })['#text']) : '';
    const d = s ? new Date(s) : null;
    if (d && !Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** arXiv's RSS puts "arXiv:ID Announce Type: new Abstract: …" in the description: only the abstract is wanted. */
function abstractOf(summary: string): string {
  const m = /\bAbstract:\s*(.*)$/s.exec(summary);
  return m ? m[1]!.trim() : summary;
}

export function parseFeed(xml: string, source: FeedSource): FeedItem[] {
  if (typeof xml !== 'string' || !xml.trim()) throw new FeedError('feed vazio');
  if (xml.length > MAX_FEED_CHARS) throw new FeedError('feed grande demais');
  if (/<!ENTITY/i.test(xml)) throw new FeedError('feed recusado: declara entidades'); // entity-expansion attacks need a declaration
  let doc: Record<string, unknown>;
  try {
    doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, processEntities: true, parseTagValue: false, trimValues: true, htmlEntities: true }).parse(xml);
  } catch {
    throw new FeedError('feed não é XML válido');
  }
  const rss = doc.rss as { channel?: { item?: unknown } } | undefined;
  const atom = doc.feed as { entry?: unknown } | undefined;
  const raw = rss?.channel ? toArray(rss.channel.item as Record<string, unknown> | Record<string, unknown>[]) : atom ? toArray(atom.entry as Record<string, unknown> | Record<string, unknown>[]) : null;
  if (!raw) throw new FeedError('formato de feed desconhecido');

  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const url = linkOf(it);
    const title = plainText(text(it.title), TITLE_MAX);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    // arXiv re-announces old papers ("replace", "replace-cross"): those are not new reading.
    const announce = /Announce Type:\s*([a-z-]+)/i.exec(String(text(it.description) ?? ''))?.[1]?.toLowerCase();
    if (announce && announce.startsWith('replace')) continue;
    const sumRaw = text(it.description) ?? text(it.summary) ?? text(it.encoded) ?? text(it.content);
    const summary = abstractOf(plainText(sumRaw, SUMMARY_MAX * 3)).slice(0, SUMMARY_MAX * 3);
    out.push({ sourceId: source.id, sourceName: source.name, kind: source.kind, title, url, publishedAt: dateOf(it), summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : summary, topicsText: `${title} ${summary}` });
  }
  return out;
}
