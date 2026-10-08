/** Search Console sensor: deterministic detection, honest gaps, and the full path to a validated insight. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx, type Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import { runCycle } from '../../src/runtime/worker.js';
import { addWebProperty, listWebProperties, syncProperty, windowsFor, type SearchConsoleApi, type SearchRow } from '../../src/sensors/searchConsole.js';
import { compareWindows, runSearchDetector, SEARCH_DETECTOR_CONFIG } from '../../src/sensors/searchDetector.js';
import { fixedClock } from '../../src/util/clock.js';
import { createTestDb } from '../helpers/db.js';
import { handlesIn, minimalReasoning, ScriptedReasoner } from '../helpers/scriptedReasoner.js';

const row = (id: string, dimension: 'total' | 'page' | 'query', key: string, clicks: number, impressions: number, position: number) => ({ id, dimension, key, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

describe('compareWindows (pure)', () => {
  it('flags large, well-supported changes and ignores small or low-volume ones', () => {
    const baseline = [
      row('b0', 'total', '', 4000, 100000, 8), // 1000/week
      row('b1', 'page', '/imoveis', 800, 20000, 5), // 200/week
      row('b2', 'page', '/tiny', 40, 900, 9), // 10/week: below volume threshold
      row('b3', 'page', '/stable', 400, 8000, 6), // 100/week
      row('b4', 'query', 'casa à venda', 300, 8000, 4), // 2000 impressions/week
      row('b5', 'page', '/gone', 400, 9000, 7), // missing from current top rows
    ];
    const current = [
      row('c0', 'total', '', 700, 24000, 8.4), // -30%
      row('c1', 'page', '/imoveis', 90, 5200, 9), // -55%
      row('c2', 'page', '/tiny', 1, 200, 30),
      row('c3', 'page', '/stable', 95, 2000, 6),
      row('c4', 'query', 'casa à venda', 60, 1900, 9.5), // position +5.5 worse
    ];
    const ch = compareWindows(current, baseline);
    const kinds = ch.map((c) => `${c.kind}:${c.key}`);
    expect(kinds).toContain('SITE_CLICKS_DROP:');
    expect(kinds).toContain('PAGE_CLICKS_DROP:/imoveis');
    expect(kinds).toContain('QUERY_POSITION_DROP:casa à venda');
    expect(kinds.some((k) => k.endsWith('/tiny') || k.endsWith('/stable'))).toBe(false);
    expect(kinds.some((k) => k.endsWith('/gone'))).toBe(false); // unknown, never assumed zero
    const page = ch.find((c) => c.key === '/imoveis')!;
    expect(page).toMatchObject({ baselineWeekly: { clicks: 200 }, current: { clicks: 90 }, changePct: -55, positionDelta: 4 });
    expect(ch[0]!.kind).toBe('SITE_CLICKS_DROP'); // whole-site change ranks first
  });

  it('caps the number of changes per property and window', () => {
    const base = Array.from({ length: 20 }, (_, i) => row(`b${i}`, 'page', `/p${i}`, 400, 8000, 5));
    const cur = Array.from({ length: 20 }, (_, i) => row(`c${i}`, 'page', `/p${i}`, 10 + i, 2000, 9));
    expect(compareWindows(cur, base)).toHaveLength(SEARCH_DETECTOR_CONFIG.maxEventsPerPropertyWindow);
  });
});

describe('sync → detector → cycle (scripted reasoner, no network)', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let principalId: string;
  const now = new Date('2026-10-08T12:00:00Z');

  /** Fake Search Console: baseline had a strong page; the current week it collapsed. */
  const fakeApi: SearchConsoleApi = {
    async query(_site, body): Promise<SearchRow[]> {
      const w = windowsFor(now);
      const isCurrent = body.startDate === w.current.start;
      const dims = (body.dimensions as string[] | undefined) ?? [];
      if (dims[0] === 'date') return [{ keys: [w.current.end], clicks: 100, impressions: 3000, ctr: 0.033, position: 8 }];
      if (dims[0] === 'page') return [{ keys: ['https://site.test/imoveis'], ...(isCurrent ? { clicks: 80, impressions: 5000, ctr: 0.016, position: 9 } : { clicks: 800, impressions: 20000, ctr: 0.04, position: 5 }) }];
      if (dims[0] === 'query') return [];
      return [isCurrent ? { clicks: 700, impressions: 24000, ctr: 0.029, position: 8.4 } : { clicks: 4000, impressions: 100000, ctr: 0.04, position: 8 }];
    },
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    principalId = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
    await addWebProperty(db, principalId, { siteUrl: 'https://site.test/', label: 'Site Teste', importance: 0.9, source: 'TEST' });
  });
  afterAll(() => t.drop());

  it('stores windows idempotently and emits each change once', async () => {
    const [p] = await listWebProperties(db, principalId);
    await syncProperty(db, fakeApi, p!, now);
    await syncProperty(db, fakeApi, p!, now);
    expect(Number((await db.query('SELECT count(*) n FROM search_metric_windows')).rows[0].n)).toBe(4); // 2 windows × (total + 1 page)
    const first = await runSearchDetector(db, principalId, [p!], now);
    const second = await runSearchDetector(db, principalId, [p!], now);
    expect(first.length).toBe(2); // site drop + page drop
    expect(second).toEqual([]);
  });

  it('the reasoner sees only the stored numbers as citable evidence; the site importance drives salience', async () => {
    const reasoner = new ScriptedReasoner(db, {
      reason: (req) => {
        const sc = handlesIn(req.user, 'SC');
        const e = handlesIn(req.user, 'E')[0]!;
        return minimalReasoning({
          relevant_evidence: sc,
          claims: [
            { id: 'C1', kind: 'INFERENCE', statement: 'Clicks fell sharply week over week.', confidence: 0.9, evidence: sc, derived_from: [], about_people: [] },
            { id: 'C2', kind: 'HYPOTHESIS', statement: 'Possibly a ranking change.', confidence: 0.4, evidence: [e], derived_from: ['C1'], about_people: [] },
            { id: 'C3', kind: 'INFERENCE', statement: 'invented number', confidence: 0.9, evidence: ['SC99'], derived_from: [], about_people: [] },
          ],
          narrative: 'Queda [C1]; hipótese [C2].',
          assessment: { urgency: null, business_impact: { value: 0.7, rationale: 'main page', evidence: sc }, applicable_preferences: [] },
        });
      },
    });
    const report = await runCycle(createContext({ db, reasoner, clock: fixedClock(now), emailProvider: new DevMailboxProvider(db) }));
    expect(report.failures).toEqual([]);
    const processed = report.outcomes.filter((o) => o.status === 'PROCESSED');
    expect(processed.length).toBeGreaterThanOrEqual(2);
    const reasonCalls = reasoner.calls.filter((c) => c.purpose === 'reason');
    expect(reasonCalls.every((c) => /\[SC1\] \(search_metric\)/.test(c.user))).toBe(true);
    expect(reasonCalls.some((c) => /whole site, .*clicks 4000, impressions 100000/.test(c.user))).toBe(true);
    expect(reasonCalls.some((c) => /page: https:\/\/site\.test\/imoveis, .*clicks 800, impressions 20000/.test(c.user))).toBe(true);
    const insight = (await db.query(`SELECT salience FROM insights ORDER BY created_at LIMIT 1`)).rows[0];
    const importance = insight.salience.factors.find((f: { name: string }) => f.name === 'importance');
    expect(importance).toMatchObject({ value: 0.9 });
    expect(importance.basis).toMatch(/site Site Teste/);
    const claims = (await db.query(`SELECT statement, validation_status, produced_by, kind FROM claims WHERE statement = 'invented number'`)).rows;
    expect(claims[0].validation_status).not.toBe('VALID'); // cites a handle that does not exist
  });
});
