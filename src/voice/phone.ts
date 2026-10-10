/**
 * Phone resolution from pages fetched by the existing web tools. Deterministic: numbers are read
 * from page text by pattern (no model reads the pages, so page content cannot steer anything), then
 * each number carries its evidence (page, source type) and is ranked:
 *   official site > business listing > other; more independent sources > fewer.
 * Policy-blocked numbers (emergency, premium, foreign, malformed) are discarded with the reason.
 * Two different numbers with the same top evidence = ambiguity → ask the principal.
 */
import type { VoicePolicy } from './policy.js';
import type { PhoneSource } from './types.js';

export interface PageText {
  url: string;
  title: string | null;
  text: string;
}

export interface PhoneCandidate {
  e164: string;
  sources: { url: string; title: string | null; sourceType: NonNullable<PhoneSource['sourceType']> }[];
}

export type PhoneResolution =
  | { status: 'resolved'; phone: string; source: PhoneSource; alternatives: string[]; blocked: { number: string; reason: string }[] }
  | { status: 'ambiguous'; candidates: PhoneCandidate[]; blocked: { number: string; reason: string }[] }
  | { status: 'not_found'; blocked: { number: string; reason: string }[] };

const RANK = { official_site: 3, business_listing: 2, other: 1 } as const;

/** Brazilian numbers written the usual ways → E.164 (+55…). Not a validity check (policy does that). */
export function extractBrazilianPhones(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\d/.-])(?:\+?55[\s.-]?)?\(?0?([1-9][1-9])\)?[\s.-]?(9?\d{4})[\s.-]?(\d{4})(?![\d/-])/g)) out.add(`+55${m[1]}${m[2]}${m[3]}`);
  for (const m of text.matchAll(/(?<!\d)0?(800|300|500|900)[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g)) out.add(`+55${m[1]}${m[2]}${m[3]}`);
  return [...out];
}

const words = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);

export function classifySource(url: string, targetName: string, listingDomains: string[]): NonNullable<PhoneSource['sourceType']> {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'other';
  }
  if (listingDomains.some((d) => host === d || host.endsWith(`.${d}`))) return 'business_listing';
  const label = host.split('.').slice(0, -1).join('.').replace(/[^a-z0-9]/g, '');
  return words(targetName).some((w) => label.includes(w)) ? 'official_site' : 'other';
}

export function resolvePhone(targetName: string, pages: PageText[], policy: VoicePolicy, listingDomains: string[], now: Date): PhoneResolution {
  const blocked: { number: string; reason: string }[] = [];
  const byNumber = new Map<string, PhoneCandidate>();
  for (const p of pages) {
    const sourceType = classifySource(p.url, targetName, listingDomains);
    for (const n of extractBrazilianPhones(p.text)) {
      const ok = policy.canCall(n, { kind: 'web_page', ref: p.url });
      if (!ok.ok) {
        if (!blocked.some((b) => b.number === n)) blocked.push({ number: n, reason: ok.reason });
        continue;
      }
      const c = byNumber.get(ok.e164) ?? { e164: ok.e164, sources: [] };
      if (!c.sources.some((s) => s.url === p.url)) c.sources.push({ url: p.url, title: p.title, sourceType });
      byNumber.set(ok.e164, c);
    }
  }
  if (!byNumber.size) return { status: 'not_found', blocked };

  const best = (c: PhoneCandidate) => Math.max(...c.sources.map((s) => RANK[s.sourceType]));
  const score = (c: PhoneCandidate) => best(c) * 10 + new Set(c.sources.map((s) => new URL(s.url).hostname)).size;
  const ranked = [...byNumber.values()].sort((a, b) => score(b) - score(a) || a.e164.localeCompare(b.e164));
  const top = ranked[0]!;
  const rival = ranked[1];
  if (rival && score(rival) === score(top)) return { status: 'ambiguous', candidates: ranked.slice(0, 3), blocked };

  const topSource = top.sources.sort((a, b) => RANK[b.sourceType] - RANK[a.sourceType])[0]!;
  const officialNumbers = ranked.filter((c) => c.sources.some((s) => s.sourceType === 'official_site')).length;
  const confidence: PhoneSource['confidence'] =
    topSource.sourceType === 'official_site' ? (officialNumbers === 1 ? 'high' : 'medium') : topSource.sourceType === 'business_listing' ? 'medium' : 'low';
  return {
    status: 'resolved',
    phone: top.e164,
    source: { kind: 'web_page', ref: topSource.url, title: topSource.title ?? undefined, sourceType: topSource.sourceType, confidence, verifiedAt: now.toISOString() },
    alternatives: ranked.slice(1, 4).map((c) => c.e164),
    blocked,
  };
}
