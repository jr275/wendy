/**
 * What the AI Intelligence Briefing covers (docs/CONCIERGE_2_PLAN.md, phase 2). The lab sections reuse the feeds already in src/research/sources.ts;
 * the three people are followed through a public news search, which is press coverage and NOT an official channel — the briefing says so.
 */
import type { FeedSource } from '../research/sources.js';
import { NEWS_SEARCH_HOST } from '../research/sources.js';

export interface LabSection {
  kind: 'lab';
  id: string;
  title: string;
  /** Ids in FEED_SOURCES. */
  feedId: string;
  scope: string;
}
export interface PersonSection {
  kind: 'person';
  id: string;
  title: string;
  /** What is searched (an exact phrase). */
  query: string;
  /** The name must appear in the headline, or the item is not about the person. */
  nameRe: RegExp;
  scope: string;
}
export type SectionDef = LabSection | PersonSection;

export const SECTIONS: readonly SectionDef[] = [
  { kind: 'lab', id: 'deepmind', title: 'Google DeepMind', feedId: 'deepmind', scope: 'pesquisas, modelos, publicações e avanços' },
  { kind: 'lab', id: 'google-ai', title: 'Google AI', feedId: 'google-ai', scope: 'produtos, infraestrutura e aplicações' },
  { kind: 'lab', id: 'openai', title: 'OpenAI Research', feedId: 'openai', scope: 'artigos, modelos, avaliações e resultados' },
  { kind: 'person', id: 'eminem', title: 'Eminem', query: 'Eminem', nameRe: /\beminem\b/i, scope: 'novidades relevantes' },
  { kind: 'person', id: 'senna', title: 'Ayrton Senna', query: 'Ayrton Senna', nameRe: /\bsenna\b/i, scope: 'novidades, homenagens, eventos e projetos relacionados' },
  { kind: 'person', id: 'hinton', title: 'Geoffrey Hinton', query: 'Geoffrey Hinton', nameRe: /\bhinton\b/i, scope: 'pesquisas, entrevistas, declarações e contribuições recentes' },
];

/** Headlines that read as rumour or sensationalism are left out (and counted, so the person can see it happened). */
export const RUMOUR_RE = /\b(boato|rumor(?:es)?|supostamente|teria|fontes? (?:dizem|afirmam)|segundo fontes|vazou|vazamento|bomba|chocante|você não vai acreditar|polêmica|treta|fofoca)\b/i;

export const periodDays = (d: number) => Math.min(30, Math.max(1, Math.floor(d)));

export function personFeed(p: PersonSection, days: number): FeedSource {
  const q = encodeURIComponent(`"${p.query}" when:${periodDays(days)}d`);
  return { id: `news-${p.id}`, name: `Google Notícias · ${p.title}`, url: `https://${NEWS_SEARCH_HOST}/rss/search?q=${q}&hl=pt-BR&gl=BR&ceid=BR%3Apt-419`, kind: 'news', weight: 1 };
}
