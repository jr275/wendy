import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyLedgerIntegrity } from '../../src/audit/ledger.js';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { applyMailRetention, assertKeepDays, planMailRetention } from '../../src/retention/mailRetention.js';
import { createTestDb } from '../helpers/db.js';

const NOW = new Date('2026-10-16T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let pid: string;
let other: string;

async function msg(principal: string, ext: string, ageDays: number, body: string) {
  await db.query(`INSERT INTO messages(id, principal_id, provider, external_id, direction, from_address, to_addresses, subject, body, sent_at) VALUES (gen_random_uuid(), $1, 'gmail', $2, 'INBOUND', 'a@example.test', ARRAY['p@example.test'], $3, $4, $5)`, [principal, ext, `assunto ${ext}`, body, daysAgo(ageDays)]);
}
beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  pid = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
  other = await createPrincipal(db, { displayName: 'Q', primaryEmail: 'q@example.test', timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
  await msg(pid, 'novo', 10, 'corpo recente');
  await msg(pid, 'limite', 100, 'corpo no limite');
  await msg(pid, 'velho1', 200, 'corpo velho um');
  await msg(pid, 'velho2', 400, 'corpo velho dois');
  await msg(pid, 'vazio', 500, '');
  await msg(other, 'alheio', 900, 'corpo de outra pessoa');
});
afterAll(() => t.drop());

describe('mail body retention', () => {
  it('only accepts a whole number of days between 30 and 3650', () => {
    for (const bad of [0, 29, 3651, 1.5, NaN, -1]) expect(() => assertKeepDays(bad), String(bad)).toThrow(/keepDays/);
    expect(assertKeepDays(30)).toBe(30);
    expect(assertKeepDays(3650)).toBe(3650);
  });
  it('the plan counts and changes nothing; an already empty body and another person\'s mail are not counted', async () => {
    const plan = await planMailRetention(db, pid, 180, NOW);
    expect(plan).toMatchObject({ keepDays: 180, withBody: 4, wouldEmpty: 2, wouldFreeChars: 'corpo velho um'.length + 'corpo velho dois'.length });
    expect(plan.cutoff).toBe(daysAgo(180).toISOString());
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE body <> ''`)).rows[0]).toEqual({ n: 5 });
  });
  it('a message exactly at the cutoff is kept (older than, not as old as)', async () => {
    expect((await planMailRetention(db, pid, 100, NOW)).wouldEmpty).toBe(2);
    expect((await planMailRetention(db, pid, 99, NOW)).wouldEmpty).toBe(3);
  });
  it('applying empties only this person\'s old bodies, keeps everything else of the message, and writes counts (no content) to the ledger', async () => {
    const r = await applyMailRetention(db, pid, 180, NOW);
    expect(r).toEqual({ emptied: 2 });
    const rows = (await db.query<{ external_id: string; body: string; subject: string; from_address: string }>(`SELECT external_id, body, subject, from_address FROM messages ORDER BY external_id`)).rows;
    const by = Object.fromEntries(rows.map((x) => [x.external_id, x]));
    expect(by.velho1!.body).toBe('');
    expect(by.velho2!.body).toBe('');
    expect(by.novo!.body).toBe('corpo recente');
    expect(by.limite!.body).toBe('corpo no limite');
    expect(by.alheio!.body).toBe('corpo de outra pessoa'); // another principal: untouched
    expect(by.velho1).toMatchObject({ subject: 'assunto velho1', from_address: 'a@example.test' });
    const audit = (await db.query(`SELECT payload FROM audit_blocks WHERE event_type = 'MAIL_BODIES_EMPTIED'`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toEqual({ payload: { keepDays: 180, emptied: 2 } });
    expect(JSON.stringify(audit)).not.toMatch(/corpo/);
    expect((await verifyLedgerIntegrity(db)).valid).toBe(true);
  });
  it('running it again changes nothing more, and the emptied text is no longer searchable', async () => {
    expect(await applyMailRetention(db, pid, 180, NOW)).toEqual({ emptied: 0 });
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE search @@ plainto_tsquery('simple', 'velho')`)).rows[0]).toEqual({ n: 0 });
  });
});
