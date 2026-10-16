/** The reading digest as the person sees and uses it. Isolated test database only. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import { digestFor, markDigestRead, refreshDigest } from '../../src/routines/digestService.js';
import { createPrincipal } from '../../src/events/world.js';
import { newId } from '../../src/util/hash.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let a: string;
let b: string;
const NOW = new Date('2026-10-16T11:00:00Z');
beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  a = await createPrincipal(db, { displayName: 'A', primaryEmail: 'a@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
  b = await createPrincipal(db, { displayName: 'B', primaryEmail: 'b@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
});
afterAll(() => t.drop());

describe('digest service', () => {
  it('without a routine: no schedule, no items, and "update now" says there is no routine instead of inventing one', async () => {
    expect(await digestFor(db, a)).toEqual({ routine: null, lastRun: null, items: [] });
    expect(await refreshDigest(db, a, NOW)).toEqual({ outcome: 'no_routine' });
  });
  it('shows the schedule and only the person\'s own items; marking read is scoped and idempotent', async () => {
    const rid = newId();
    await db.query(`INSERT INTO routines(id, principal_id, kind, created_at, updated_at) VALUES ($1,$2,'research_digest',$3,$3)`, [rid, a, NOW]);
    const run = newId();
    await db.query(`INSERT INTO routine_runs(id, routine_id, principal_id, run_date, status, attempts, started_at) VALUES ($1,$2,$3,'2026-10-16','DONE',1,$4)`, [run, rid, a, NOW]);
    const item = newId();
    for (const [id, pid, url] of [[item, a, 'https://example.test/1'], [newId(), b, 'https://example.test/2']] as const)
      await db.query(`INSERT INTO digest_items(id, run_id, principal_id, kind, source_name, source_url, title, summary, why, score, created_at) VALUES ($1,$2,$3,'article','Fonte',$4,'Título','resumo','porquê',1,$5)`, [id, run, pid, url, NOW]);
    const v = await digestFor(db, a);
    expect(v.routine).toEqual({ enabled: true, localTime: '07:30', timezone: 'America/Sao_Paulo', pausedUntil: null });
    expect(v.lastRun).toEqual({ date: '2026-10-16', status: 'DONE', error: null });
    expect(v.items.map((i) => i.url)).toEqual(['https://example.test/1']);
    await expect(markDigestRead(db, b, item, NOW)).rejects.toThrow(/not found/); // someone else's item
    expect(await markDigestRead(db, a, item, NOW)).toEqual({ marked: true });
    await markDigestRead(db, a, item, new Date(NOW.getTime() + 1000));
    expect((await digestFor(db, a)).items[0]!.read).toBe(true);
    expect((await db.query(`SELECT read_at FROM digest_items WHERE id = $1`, [item])).rows[0]!.read_at.toISOString()).toBe(NOW.toISOString()); // first read time kept
  });
  it('"update now" runs the same runner with the given handler, and a second press the same day does not run again', async () => {
    let calls = 0;
    const handler = async () => { calls++; return { items: [] }; };
    await db.query(`DELETE FROM digest_items`, []);
    await db.query(`DELETE FROM routine_runs WHERE principal_id = $1`, [a]);
    expect(await refreshDigest(db, a, NOW, handler)).toMatchObject({ outcome: 'done' });
    expect(await refreshDigest(db, a, NOW, handler)).toMatchObject({ outcome: 'skipped', detail: 'done' });
    expect(calls).toBe(1);
  });
});
