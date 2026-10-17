/**
 * AI Intelligence Briefing (preview only). No network (fetch is a fake), no database, no model.
 * Third-party text is hostile on purpose in several cases.
 */
import { describe, expect, it } from 'vitest';
import { buildBriefing, NOTHING, renderBriefingHtml, type Briefing } from '../../src/briefing/briefing.js';
import { periodDays, personFeed, RUMOUR_RE, SECTIONS, type PersonSection } from '../../src/briefing/sections.js';
import { isAllowedFeedUrl, type FetchLike } from '../../src/research/fetchFeed.js';

const NOW = new Date('2026-10-16T12:00:00Z');
const rss = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${items}</channel></rss>`;
const item = (title: string, link: string, date: string, desc = '') => `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate><description>${desc}</description></item>`;

/** A fake fetch: the answer depends on the host and on what is searched. */
function fakeFetch(answers: Record<string, string | number>): { impl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const impl: FetchLike = async (url) => {
    calls.push(url);
    const key = Object.keys(answers).find((k) => url.includes(k));
    const a = key ? answers[key]! : 404;
    if (typeof a === 'number') return { status: a, headers: { get: () => 'text/html' }, text: async () => '' };
    return { status: 200, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/xml' : null) }, text: async () => a };
  };
  return { impl, calls };
}
const noSleep = async () => undefined;
const run = (answers: Record<string, string | number>, extra: Partial<Parameters<typeof buildBriefing>[0]> = {}) => {
  const f = fakeFetch(answers);
  return buildBriefing({ now: NOW, fetchImpl: f.impl, sleep: noSleep, ...extra }).then((b) => ({ b, calls: f.calls }));
};
const section = (b: Briefing, id: string) => b.sections.find((s) => s.id === id)!;

const FULL = {
  'deepmind.google': rss(item('Gemini gets better at reasoning with agents', 'https://deepmind.google/blog/a', 'Thu, 15 Oct 2026 10:00:00 GMT', 'A new reasoning approach for agents.')),
  'blog.google': rss(item('Older post about transformers', 'https://blog.google/old', 'Sat, 26 Sep 2026 10:00:00 GMT', 'attention')),
  'openai.com': rss(item('New evaluation benchmark for agents', 'https://openai.com/n/b', 'Wed, 14 Oct 2026 10:00:00 GMT', 'A benchmark for agentic evaluation.')),
  'q=%22Eminem': rss(item('Eminem lança single novo - Rolling Stone Brasil', 'https://news.google.com/rss/articles/AAA', 'Thu, 15 Oct 2026 08:00:00 GMT')),
  'q=%22Ayrton': rss([item('BOMBA: Senna teria deixado carta secreta - Site Fofoca', 'https://news.google.com/rss/articles/B1', 'Thu, 15 Oct 2026 08:00:00 GMT'), item('Exposição homenageia Ayrton Senna em São Paulo - Folha', 'https://news.google.com/rss/articles/B2', 'Wed, 14 Oct 2026 08:00:00 GMT'), item('Campeonato de kart começa hoje - Globo', 'https://news.google.com/rss/articles/B3', 'Wed, 14 Oct 2026 09:00:00 GMT')].join('')),
  'q=%22Geoffrey': rss(''),
};

describe('sections and addresses', () => {
  it('covers exactly the six named subjects, and every feed address comes from the code', () => {
    expect(SECTIONS.map((s) => s.id)).toEqual(['deepmind', 'google-ai', 'openai', 'eminem', 'senna', 'hinton']);
    for (const s of SECTIONS.filter((x): x is PersonSection => x.kind === 'person')) {
      const url = personFeed(s, 7).url;
      expect(isAllowedFeedUrl(url), s.id).toBe(true);
      expect(decodeURIComponent(url)).toContain(`"${s.query}" when:7d`);
    }
  });
  it('the period is whole days between 1 and 30', () => {
    expect([periodDays(0), periodDays(7.9), periodDays(400), periodDays(-3)]).toEqual([1, 7, 30, 1]);
  });
  it('the rumour filter catches rumour words and not an ordinary headline', () => {
    for (const bad of ['BOMBA: algo', 'Fontes dizem que', 'Senna teria dito', 'Boato sobre show']) expect(RUMOUR_RE.test(bad), bad).toBe(true);
    for (const ok of ['Exposição homenageia Senna', 'Hinton fala sobre segurança de IA']) expect(RUMOUR_RE.test(ok), ok).toBe(false);
  });
});

describe('buildBriefing', () => {
  it('is a preview: it says nothing was sent and carries no recipient', async () => {
    const { b } = await run(FULL);
    expect(b.kind).toBe('PREVIEW');
    expect(b.notes.join(' ')).toMatch(/Nada deste briefing foi enviado/);
    expect(JSON.stringify(b)).not.toMatch(/recipient|destinat|@[a-z0-9-]+\.[a-z]{2,}/i);
  });
  it('fills lab sections with the source\'s own words, dated, and leaves a section empty (with the sentence) when nothing is relevant', async () => {
    const { b } = await run(FULL);
    expect(section(b, 'deepmind').items).toHaveLength(1);
    expect(section(b, 'deepmind').items[0]).toMatchObject({ origin: 'lab', source: 'Google DeepMind', url: 'https://deepmind.google/blog/a' });
    expect(section(b, 'deepmind').items[0]!.summary).toContain('reasoning approach');
    expect(section(b, 'google-ai').items).toEqual([]); // the only post is 20 days old: outside the 7-day period
    expect(section(b, 'google-ai').empty).toBe(NOTHING);
    expect(section(b, 'hinton').empty).toBe(NOTHING);
    expect(section(b, 'hinton').unavailable).toBeNull();
  });
  it('a placeholder summary from the source ("TBD") is dropped, not shown as if it were one', async () => {
    const { b } = await run({ ...FULL, 'blog.google': rss(item('Gemini news about agents', 'https://blog.google/n', 'Thu, 15 Oct 2026 10:00:00 GMT', 'TBD')) });
    expect(section(b, 'google-ai').items[0]!.summary).toBeNull();
  });
  it('press items: only headlines that name the person, no rumour, labelled as press coverage, not official, with no invented summary', async () => {
    const { b } = await run(FULL);
    const senna = section(b, 'senna');
    expect(senna.items.map((i) => i.title)).toEqual(['Exposição homenageia Ayrton Senna em São Paulo']); // the rumour and the headline without the name are out
    expect(senna.items[0]).toMatchObject({ origin: 'press', source: 'Folha', summary: null });
    expect(senna.items[0]!.relevance).toMatch(/não é fonte oficial/);
    expect(b.notes.join(' ')).toMatch(/Ayrton Senna: 1 manchete/);
    expect(section(b, 'eminem').items[0]!.title).toBe('Eminem lança single novo');
  });
  it('a source that cannot be read becomes a stated limitation, never made-up content, and the rest still works', async () => {
    const { b } = await run({ ...FULL, 'openai.com': 503 });
    expect(section(b, 'openai').items).toEqual([]);
    expect(section(b, 'openai').unavailable).toMatch(/Não consegui ler esta fonte/);
    expect(section(b, 'openai').empty).toBeNull();
    expect(b.sources.find((s) => s.name === 'OpenAI')!.status).toBe('indisponível');
    expect(section(b, 'deepmind').items).toHaveLength(1);
    expect(b.notes.join(' ')).toMatch(/Alguma fonte não pôde ser lida/);
  });
  it('a wider period brings back older posts; a link already shown is not repeated', async () => {
    const wide = await run(FULL, { days: 30 });
    expect(section(wide.b, 'google-ai').items).toHaveLength(1); // 20 days old: inside 30 days
    const seen = await run(FULL, { seenUrls: new Set(['https://deepmind.google/blog/a']) });
    expect(section(seen.b, 'deepmind').items).toEqual([]);
  });
  it('the period is recorded, and the highlights come from real items only (lab first), at most five, never padded', async () => {
    const { b } = await run(FULL);
    expect(b.period.days).toBe(7);
    expect(b.highlights.length).toBeGreaterThan(0);
    expect(b.highlights.length).toBeLessThanOrEqual(5);
    const all = new Set(b.sections.flatMap((s) => s.items.map((i) => i.url)));
    for (const h of b.highlights) expect(all.has(h.url)).toBe(true);
    expect(b.highlights[0]!.origin).toBe('lab');
    const empty = await run({ 'deepmind.google': rss(''), 'blog.google': rss(''), 'openai.com': rss(''), 'q=%22': rss('') });
    expect(empty.b.highlights).toEqual([]);
    expect(empty.b.attention.lines).toEqual([NOTHING]);
  });
  it('"o que merece atenção" is a labelled automatic count of repeated themes, not an opinion about the person\'s projects', async () => {
    const { b } = await run(FULL);
    expect(b.attention.label).toMatch(/não é um modelo de IA/);
    expect(b.attention.lines.join(' ')).toMatch(/raciocínio e agentes/);
  });
  it('asks only the allow-listed hosts', async () => {
    const { calls } = await run(FULL);
    expect(calls.length).toBe(6);
    for (const c of calls) expect(isAllowedFeedUrl(c), c).toBe(true);
  });
});

describe('renderBriefingHtml', () => {
  it('shows the ten parts in order, the preview banner and the empty sentence', async () => {
    const html = renderBriefingHtml((await run(FULL)).b);
    const heads = [...html.matchAll(/<h2[^>]*>(\d+)\. ([^<]+)<\/h2>/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(heads).toEqual(['2.Resumo executivo', '3.Google DeepMind', '4.Google AI', '5.OpenAI Research', '6.Eminem', '7.Ayrton Senna', '8.Geoffrey Hinton', '9.O que merece atenção', '10.Fontes']);
    expect(html).toContain('PRÉVIA');
    expect(html).toContain(`${NOTHING}.`);
    expect(html).toContain('name="viewport"');
  });
  it('escapes every third-party value and refuses links that are not plain https', () => {
    const evil: Briefing = {
      kind: 'PREVIEW', title: 'Wendy Intelligence Briefing', generatedAt: NOW.toISOString(), period: { from: NOW.toISOString(), to: NOW.toISOString(), days: 7 },
      highlights: [],
      sections: [{ id: 'x', title: 'T<script>alert(1)</script>', scope: 's', empty: null, unavailable: null, items: [{ title: '<img src=x onerror=alert(1)>"\'', url: 'javascript:alert(1)', source: '<b>S</b>', publishedAt: NOW.toISOString(), summary: '<script>x</script>', relevance: '"><svg onload=1>', origin: 'lab' }, { title: 'ok', url: 'https://a.test/x" onclick="y', source: 's', publishedAt: NOW.toISOString(), summary: null, relevance: 'r', origin: 'press' }] }],
      attention: { label: '<i>l</i>', lines: ['<u>x</u>'] }, sources: [{ name: '<s>n</s>', url: 'https://a.test', status: 'lida', items: 1 }], notes: ['<n>'],
    };
    const html = renderBriefingHtml(evil);
    expect(html).not.toMatch(/<script|<img|<svg|<b>|<i>|<u>|<s>|<n>/);
    expect(html).not.toMatch(/href="javascript:/);
    expect(html).not.toMatch(/href="https:\/\/a\.test\/x" onclick/); // the text stays visible but inert: its < and > are escaped
    expect(html.match(/href="#"/g)).toHaveLength(2);
  });
});
