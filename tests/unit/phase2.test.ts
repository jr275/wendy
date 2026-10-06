import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decidePolicy, PolicyService, proposeAction } from '../../src/actions/actions.js';
import { verifyLedgerIntegrity } from '../../src/audit/ledger.js';
import { withTx, type Db } from '../../src/db/db.js';
import { createPerson, createPrincipal, storeMessage } from '../../src/events/world.js';
import { MemoryService, MemoryTransitionError } from '../../src/memory/memoryService.js';
import { PeopleService } from '../../src/people/peopleService.js';
import { relationshipMetrics, renderMetrics } from '../../src/people/relationshipMetrics.js';
import { pgRepositories } from '../../src/repositories/pg.js';
import { DAY_MS, HOUR_MS } from '../../src/util/clock.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let principalId: string;
let otherPrincipalId: string;
let personId: string;
const repos = pgRepositories();
const now = new Date('2026-10-01T12:00:00Z');

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  principalId = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'UTC', locale: 'en' });
  otherPrincipalId = await createPrincipal(db, { displayName: 'Q', primaryEmail: 'q@example.test', timezone: 'UTC', locale: 'en' });
  personId = await createPerson(db, principalId, { fullName: 'Metric Person', emails: ['m@example.test'], source: 'TEST' });
});
afterAll(() => t.drop());

const writeMemory = (status: 'PROPOSED' | 'ACTIVE', content: string, pid = principalId) =>
  repos.memories.write(db, { principalId: pid, kind: 'PREFERENCE', subjectPersonId: pid === principalId ? personId : null, content, confidence: 0.8, evidence: [], writtenBy: 'WENDY', createdAt: now, status });
const statusOf = async (id: string) => (await repos.memories.get(db, principalId, id))!.status;
const activeContents = async () => (await repos.memories.activeForPerson(db, principalId, personId, 50)).map((m) => m.content);

describe('memory lifecycle', () => {
  it('proposed memories never reach reasoning until the principal confirms them', async () => {
    const m = await writeMemory('PROPOSED', 'prefers short messages (proposed)');
    expect(await activeContents()).not.toContain(m.content);
    await new MemoryService(db).confirm(principalId, m.id, now);
    expect(await statusOf(m.id)).toBe('ACTIVE');
    expect(await activeContents()).toContain(m.content);
    const row = (await db.query('SELECT last_confirmed_at, confirmed_by FROM memories WHERE id = $1', [m.id])).rows[0];
    expect(row.confirmed_by).toBe('PRINCIPAL');
    expect(row.last_confirmed_at.getTime()).toBe(now.getTime());
  });

  it('retracted memories are terminal and cannot be revived', async () => {
    const svc = new MemoryService(db);
    const m = await writeMemory('PROPOSED', 'likes golf (wrong)');
    await svc.retract(principalId, m.id, 'not true', now);
    expect(await statusOf(m.id)).toBe('RETRACTED');
    await expect(svc.confirm(principalId, m.id, now)).rejects.toBeInstanceOf(MemoryTransitionError);
  });

  it('a principal cannot touch another principal\'s memory', async () => {
    const foreign = await writeMemory('PROPOSED', 'foreign', otherPrincipalId);
    await expect(new MemoryService(db).confirm(principalId, foreign.id, now)).rejects.toBeInstanceOf(MemoryTransitionError);
    expect((await repos.memories.get(db, otherPrincipalId, foreign.id))!.status).toBe('PROPOSED');
  });

  it('conflicts are recorded once per memory set and resolution supersedes the loser', async () => {
    const svc = new MemoryService(db);
    const a = await writeMemory('ACTIVE', 'prefers calls');
    const b = await writeMemory('ACTIVE', 'prefers email only');
    const c1 = await withTx(db, (tx) => svc.recordConflict(tx, principalId, [a.id, b.id], 'call vs email', { kind: 'insight', id: 'x' }, now));
    const c2 = await withTx(db, (tx) => svc.recordConflict(tx, principalId, [b.id, a.id, a.id], 'same again', { kind: 'insight', id: 'y' }, now));
    expect(c2).toBe(c1);
    expect(await withTx(db, (tx) => svc.recordConflict(tx, principalId, [a.id], 'single', { kind: 'insight', id: 'z' }, now))).toBeNull();

    await expect(svc.resolveConflict(principalId, c1!, [personId], now)).rejects.toBeInstanceOf(MemoryTransitionError);
    await svc.resolveConflict(principalId, c1!, [b.id], now);
    expect(await statusOf(a.id)).toBe('SUPERSEDED');
    expect(await statusOf(b.id)).toBe('ACTIVE');
    expect((await db.query('SELECT superseded_by FROM memories WHERE id = $1', [a.id])).rows[0].superseded_by).toBe(b.id);
    await expect(svc.resolveConflict(principalId, c1!, [b.id], now)).rejects.toThrow(/already resolved/);
  });

  it('every transition is in the ledger and the chain stays valid', async () => {
    const types = (await db.query(`SELECT event_type FROM audit_blocks WHERE principal_id = $1 AND event_type LIKE 'MEMORY_%'`, [principalId])).rows.map((r) => r.event_type);
    expect(types).toEqual(expect.arrayContaining(['MEMORY_ACTIVE', 'MEMORY_RETRACTED', 'MEMORY_SUPERSEDED', 'MEMORY_CONFLICT_DETECTED', 'MEMORY_CONFLICT_RESOLVED']));
    expect((await verifyLedgerIntegrity(db)).valid).toBe(true);
  });
});

describe('approval policy overrides', () => {
  it('external actions can never be set to AUTO; overrides apply to internal ones', async () => {
    const svc = new PolicyService(db);
    await expect(svc.set(principalId, 'SEND_EMAIL', 'AUTO', now)).rejects.toThrow(/external/);
    expect(decidePolicy('SEND_EMAIL', 'AUTO').mode).toBe('REQUIRE_APPROVAL');

    await svc.set(principalId, 'PREPARE_BRIEFING', 'REQUIRE_APPROVAL', now);
    const held = await withTx(db, (tx) => proposeAction(tx, { principalId, insightId: null, type: 'PREPARE_BRIEFING', targetPersonId: personId, content: { title: 'B', sections: [] }, expiresAt: null }));
    expect(held.state).toBe('AWAITING_APPROVAL');

    // other principals keep the catalog default
    const other = await withTx(db, (tx) => proposeAction(tx, { principalId: otherPrincipalId, insightId: null, type: 'PREPARE_BRIEFING', targetPersonId: null, content: { title: 'B', sections: [] }, expiresAt: null }));
    expect(other.state).toBe('APPROVED');

    await svc.set(principalId, 'PREPARE_BRIEFING', null, now);
    const back = await withTx(db, (tx) => proposeAction(tx, { principalId, insightId: null, type: 'PREPARE_BRIEFING', targetPersonId: personId, content: { title: 'B', sections: [] }, expiresAt: null }));
    expect(back.state).toBe('APPROVED');
  });
});

describe('person importance', () => {
  it('is set only by the principal, validated, scoped and audited', async () => {
    const svc = new PeopleService(db);
    await expect(svc.setImportance(principalId, personId, 1.5, now)).rejects.toThrow();
    await expect(svc.setImportance(otherPrincipalId, personId, 0.5, now)).rejects.toThrow(/not found/);
    await svc.setImportance(principalId, personId, 0.9, now);
    expect((await db.query('SELECT explicit_importance FROM relationships WHERE person_id = $1', [personId])).rows[0].explicit_importance).toBe(0.9);
    await svc.setImportance(principalId, personId, null, now);
    expect((await db.query('SELECT explicit_importance FROM relationships WHERE person_id = $1', [personId])).rows[0].explicit_importance).toBeNull();
  });
});

describe('relationship metrics (derived from interactions)', () => {
  let n = 0;
  const msg = (from: string, to: string, at: Date) =>
    withTx(db, (tx) => storeMessage(tx, principalId, { provider: 'test', externalId: `m${n++}`, from, to: [to], subject: 's', body: 'b', sentAt: at }));
  const ago = (days: number, hours = 0) => new Date(now.getTime() - days * DAY_MS - hours * HOUR_MS);

  it('a person with no interactions has empty metrics', async () => {
    const lonely = await createPerson(db, principalId, { fullName: 'Nobody', emails: ['n@example.test'], source: 'TEST' });
    const m = await relationshipMetrics(db, principalId, lonely, now);
    expect(m).toMatchObject({ messages90d: 0, trend: 'NONE', daysSinceContact: null, reciprocity: null });
  });

  it('computes volume, reply latency, reciprocity, trend and recency', async () => {
    // 60–80 days ago: 4 exchanges (them → principal reply after 2h)
    for (const d of [80, 75, 70, 65]) {
      await msg('m@example.test', 'p@example.test', ago(d));
      await msg('p@example.test', 'm@example.test', ago(d, -2));
    }
    // last 30 days: only one inbound, principal replied after 10h; principal pinged once, they answered in 4h
    await msg('m@example.test', 'p@example.test', ago(20));
    await msg('p@example.test', 'm@example.test', ago(20, -10));
    await msg('p@example.test', 'm@example.test', ago(5));
    await msg('m@example.test', 'p@example.test', ago(5, -4));
    // outside the 90-day window: ignored for volume
    await msg('m@example.test', 'p@example.test', ago(120));

    const m = await relationshipMetrics(db, principalId, personId, now);
    expect(m.messages90d).toBe(12);
    expect(m.messages30d).toBe(4);
    expect(m.inbound90d).toBe(6);
    expect(m.outbound90d).toBe(6);
    expect(m.reciprocity).toBe(1);
    expect(m.principalReplyHoursMedian).toBe(2); // [2,2,2,2,10]
    expect(m.trend).toBe('STABLE'); // 4/30 vs 8/60 per day
    expect(m.daysSinceContact).toBe(4);
    expect(m.lastInboundAt!.getTime()).toBe(ago(5, -4).getTime());
    expect(renderMetrics(m)).toContain('12 in 90 days');
  });

  it('is scoped to the principal', async () => {
    const m = await relationshipMetrics(db, otherPrincipalId, personId, now);
    expect(m.messages90d).toBe(0);
  });
});
