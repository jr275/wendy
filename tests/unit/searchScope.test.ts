/** Search Console scope: the principal chooses which properties Wendy considers; the rest is left out everywhere, and nothing is deleted. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { siteCard } from '../../src/agent/siteCard.js';
import { resolveViewing } from '../../src/agent/viewing.js';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { DevMailboxProvider } from '../../src/providers/devMailbox.js';
import { createContext } from '../../src/runtime/context.js';
import { runCycle } from '../../src/runtime/worker.js';
import { addWebProperty, listWebProperties, syncDueProperties, syncProperty, windowsFor, type SearchConsoleApi, type SearchRow } from '../../src/sensors/searchConsole.js';
import { searchEvidenceForTerms } from '../../src/sensors/searchContext.js';
import { runSearchDetector } from '../../src/sensors/searchDetector.js';
import { inSearchScope, loadSearchScope, outOfScopeInsightIds, outOfScopePropertyIds } from '../../src/sensors/searchScope.js';
import { fixedClock } from '../../src/util/clock.js';
import { createTestDb } from '../helpers/db.js';
import { handlesIn, minimalReasoning, ScriptedReasoner } from '../helpers/scriptedReasoner.js';

const ORIGINAL_SCOPE_FILE = process.env.WENDY_SEARCH_SCOPE_FILE; // the isolated, non-existent path set by vitest.config.ts
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wendy-scope-'));
const file = path.join(tmp, 'search-scope.json');
const useScope = (content: string | null) => {
  process.env.WENDY_SEARCH_SCOPE_FILE = file;
  if (content === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, content);
};
afterEach(() => {
  process.env.WENDY_SEARCH_SCOPE_FILE = ORIGINAL_SCOPE_FILE;
  vi.restoreAllMocks();
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const REMAX = { label: 'Remax', site_url: 'sc-domain:remax.com.br' };
const AERIVA = { label: 'Aeriva', site_url: 'https://www.aeriva.io/' };
const AVALY = { label: 'Avaly', site_url: 'https://www.avaly.io/' };

describe('the setting itself', () => {
  it('no file: no restriction (the previous behaviour)', () => {
    useScope(null);
    expect(loadSearchScope()).toBeNull();
    expect([REMAX, AERIVA, AVALY].every((p) => inSearchScope(p))).toBe(true);
  });

  it('includes only what is named, by label or exact site URL, ignoring case and spaces', () => {
    useScope(JSON.stringify({ include: ['  remax '] }));
    expect([REMAX, AERIVA, AVALY].map((p) => inSearchScope(p))).toEqual([true, false, false]);
    useScope(JSON.stringify({ include: ['https://www.aeriva.io/'] }));
    expect([REMAX, AERIVA, AVALY].map((p) => inSearchScope(p))).toEqual([false, true, false]);
  });

  it('a present but invalid file fails closed (nothing considered) and says why, once', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of ['{ not json', '{}', JSON.stringify({ include: 'Remax' }), JSON.stringify({ include: ['Remax', ''] })]) {
      useScope(bad);
      expect(loadSearchScope()).toEqual({ include: [] });
      expect([REMAX, AERIVA, AVALY].some((p) => inSearchScope(p))).toBe(false);
    }
    expect(err.mock.calls.length).toBeLessThanOrEqual(1); // logged once per process, never spammed
  });
});

describe('where it applies (real queries, scripted API, no network, no model)', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let principalId: string;
  const ids: Record<string, string> = {};
  const now = new Date('2026-10-08T12:00:00Z');
  const queried: string[] = [];

  /** Every site: the page collapsed this week. */
  const api: SearchConsoleApi = {
    async query(site, body): Promise<SearchRow[]> {
      queried.push(site);
      const w = windowsFor(now);
      const cur = body.startDate === w.current.start;
      const dims = (body.dimensions as string[] | undefined) ?? [];
      if (dims[0] === 'date') return [{ keys: [w.current.end], clicks: 100, impressions: 3000, ctr: 0.033, position: 8 }];
      if (dims[0] === 'page') return [{ keys: [`${site}imoveis`], ...(cur ? { clicks: 80, impressions: 5000, ctr: 0.016, position: 9 } : { clicks: 800, impressions: 20000, ctr: 0.04, position: 5 }) }];
      if (dims[0] === 'query') return [];
      return [cur ? { clicks: 700, impressions: 24000, ctr: 0.029, position: 8.4 } : { clicks: 4000, impressions: 100000, ctr: 0.04, position: 8 }];
    },
  };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    principalId = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
    for (const p of [REMAX, AERIVA, AVALY]) ids[p.label] = await addWebProperty(db, principalId, { siteUrl: p.site_url, label: p.label, source: 'TEST' });
    useScope(null);
    for (const p of await listWebProperties(db, principalId)) await syncProperty(db, api, p, now); // all three stored: nothing about scope is baked into the data
  });
  afterAll(() => t.drop());

  it('answers (evidence) only consider the chosen properties', async () => {
    useScope(null);
    expect((await searchEvidenceForTerms(db, principalId, ['Aeriva', 'Remax'])).length).toBeGreaterThan(0);
    useScope(JSON.stringify({ include: ['Remax'] }));
    expect(await searchEvidenceForTerms(db, principalId, ['Aeriva'])).toEqual([]);
    expect(await searchEvidenceForTerms(db, principalId, ['Avaly'])).toEqual([]);
    expect((await searchEvidenceForTerms(db, principalId, ['Remax'])).length).toBeGreaterThan(0);
  });

  it('site cards and the "what is on screen" context leave the others out', async () => {
    useScope(JSON.stringify({ include: ['Remax'] }));
    expect(await siteCard(db, principalId, ids.Aeriva!)).toBeNull();
    expect(await siteCard(db, principalId, ids.Remax!)).not.toBeNull();
    const list = await resolveViewing(db, principalId, { kind: 'sites' });
    expect(list?.description).toContain('Remax');
    expect(list?.description).not.toMatch(/Aeriva|Avaly/);
    expect(await resolveViewing(db, principalId, { kind: 'site', id: ids.Aeriva })).toBeNull();
  });

  it('the scheduled sync does not even fetch the others from Google', async () => {
    useScope(JSON.stringify({ include: ['Remax'] }));
    queried.length = 0;
    await syncDueProperties(db, api, new Date('2099-01-01T12:00:00Z'), 0);
    expect(queried.length).toBeGreaterThan(0);
    expect(queried.every((s) => s === REMAX.site_url)).toBe(true);
  });

  it('nothing is deleted: lifting the setting brings everything back', async () => {
    useScope(JSON.stringify({ include: ['Remax'] }));
    expect(await outOfScopePropertyIds(db, principalId)).toHaveLength(2);
    expect(Number((await db.query('SELECT count(*) n FROM web_properties')).rows[0].n)).toBe(3);
    useScope(null);
    expect(await outOfScopePropertyIds(db, principalId)).toEqual([]);
    expect((await searchEvidenceForTerms(db, principalId, ['Aeriva'])).length).toBeGreaterThan(0);
  });

  it('events about an out-of-scope property are skipped by the cycle, and its past insights are identifiable', async () => {
    // First, with no restriction, every property yields insights (as before the setting existed).
    useScope(null);
    const reasoner = new ScriptedReasoner(db, {
      reason: (req) => {
        const sc = handlesIn(req.user, 'SC');
        return minimalReasoning({
          relevant_evidence: sc,
          claims: [{ id: 'C1', kind: 'INFERENCE', statement: 'Clicks fell sharply week over week.', confidence: 0.9, evidence: sc, derived_from: [], about_people: [] }],
          narrative: 'Queda [C1].',
          assessment: { urgency: null, business_impact: { value: 0.7, rationale: 'main page', evidence: sc }, applicable_preferences: [] },
        });
      },
    });
    const props = await listWebProperties(db, principalId);
    await runSearchDetector(db, principalId, props, now);
    const events = async () => (await db.query<{ property: string; status: string }>(`SELECT payload->>'property_id' AS property, processing_status AS status FROM events WHERE event_type = 'SEARCH_PERFORMANCE_CHANGE'`)).rows;
    const before = await events();
    expect(new Set(before.map((e) => e.property)).size).toBe(3);
    // Now restrict to Remax BEFORE the cycle runs: Aeriva / Avaly events must be skipped, not reasoned over.
    useScope(JSON.stringify({ include: ['Remax'] }));
    const report = await runCycle(createContext({ db, reasoner, clock: fixedClock(now), emailProvider: new DevMailboxProvider(db) }));
    expect(report.failures).toEqual([]);
    const after = await events();
    expect(after.filter((e) => e.property === ids.Remax).every((e) => e.status === 'PROCESSED')).toBe(true);
    expect(after.filter((e) => e.property !== ids.Remax).every((e) => e.status === 'SKIPPED')).toBe(true);
    const insightsOfOthers = await outOfScopeInsightIds(db, principalId);
    expect(insightsOfOthers.size).toBe(0); // skipped events raised nothing

    // And insights raised BEFORE the setting (a different past) are identified so the screens can hide them.
    await db.query(`UPDATE events SET processing_status = 'PENDING' WHERE event_type = 'SEARCH_PERFORMANCE_CHANGE'`);
    useScope(null);
    await runCycle(createContext({ db, reasoner, clock: fixedClock(now), emailProvider: new DevMailboxProvider(db) }));
    useScope(JSON.stringify({ include: ['Remax'] }));
    const hidden = await outOfScopeInsightIds(db, principalId);
    expect(hidden.size).toBeGreaterThan(0);
    const owners = (await db.query<{ property: string }>(`SELECT DISTINCT e.payload->>'property_id' AS property FROM insights i JOIN events e ON e.id = i.event_id WHERE i.id = ANY($1::uuid[])`, [[...hidden]])).rows.map((r) => r.property);
    expect(owners.every((o) => o !== ids.Remax)).toBe(true);
  });
});
