import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit, assertLedgerIntegrity, LedgerIntegrityError, verifyLedgerIntegrity } from '../../src/audit/ledger.js';
import { withTx, type Db } from '../../src/db/db.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(() => t.drop());

async function reset(n: number) {
  await db.query('DELETE FROM audit_blocks');
  await db.query('DELETE FROM audit_head');
  for (let i = 0; i < n; i++)
    await withTx(db, (tx) => appendAudit(tx, { principalId: null, eventType: 'TEST', actor: 'tester', subjectType: 'test', subjectId: `s${i}`, payload: { i, nested: { a: [1, 2] } } }));
}

describe('audit ledger', () => {
  beforeEach(() => reset(5));

  it('verifies an intact chain', async () => {
    expect(await verifyLedgerIntegrity(db)).toEqual({ valid: true, blockCount: 5 });
  });

  it('rolls back the audit block together with a failed transaction', async () => {
    await expect(
      withTx(db, async (tx) => {
        await appendAudit(tx, { principalId: null, eventType: 'X', actor: 'a', subjectType: 's', subjectId: 'x', payload: {} });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await verifyLedgerIntegrity(db)).toEqual({ valid: true, blockCount: 5 });
  });

  const tamper: Record<string, string[]> = {
    'altered payload': [`UPDATE audit_blocks SET payload = '{"i": 99}' WHERE seq = 2`],
    'altered actor': [`UPDATE audit_blocks SET actor = 'attacker' WHERE seq = 2`],
    'altered event type': [`UPDATE audit_blocks SET event_type = 'FORGED' WHERE seq = 2`],
    'altered hash': [`UPDATE audit_blocks SET hash = repeat('f', 64) WHERE seq = 3`],
    'altered prev_hash': [`UPDATE audit_blocks SET prev_hash = repeat('f', 64) WHERE seq = 3`],
    'removed middle block': [`DELETE FROM audit_blocks WHERE seq = 3`],
    'reordered blocks': [`UPDATE audit_blocks SET seq = -1 WHERE seq = 2`, `UPDATE audit_blocks SET seq = 2 WHERE seq = 3`, `UPDATE audit_blocks SET seq = 3 WHERE seq = -1`],
    'duplicated block': [
      `DELETE FROM audit_blocks WHERE seq > 3`,
      `INSERT INTO audit_blocks SELECT 4, at, principal_id, event_type, actor, subject_type, subject_id, payload, prev_hash, hash FROM audit_blocks WHERE seq = 3`,
      `UPDATE audit_head SET seq = 4, hash = (SELECT hash FROM audit_blocks WHERE seq = 4)`,
    ],
    'truncated tail': [`DELETE FROM audit_blocks WHERE seq = 5`],
    'truncated tail with forged head': [`DELETE FROM audit_blocks WHERE seq = 5`, `UPDATE audit_head SET seq = 4, hash = repeat('0', 64)`],
    'missing head anchor': [`DELETE FROM audit_head`],
    'emptied ledger with surviving head': [`DELETE FROM audit_blocks`],
  };

  for (const [name, statements] of Object.entries(tamper)) {
    it(`detects ${name} and fails closed`, async () => {
      for (const sql of statements) await db.query(sql);
      const result = await verifyLedgerIntegrity(db);
      expect(result.valid).toBe(false);
      await expect(assertLedgerIntegrity(db)).rejects.toBeInstanceOf(LedgerIntegrityError);
    });
  }

  it('refuses to append when the tip does not match the head anchor', async () => {
    await db.query(`DELETE FROM audit_blocks WHERE seq = 5`);
    await expect(withTx(db, (tx) => appendAudit(tx, { principalId: null, eventType: 'X', actor: 'a', subjectType: 's', subjectId: 'x', payload: {} }))).rejects.toBeInstanceOf(LedgerIntegrityError);
  });

  it('serializes concurrent appends into a single valid chain', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => withTx(db, (tx) => appendAudit(tx, { principalId: null, eventType: 'C', actor: 'a', subjectType: 's', subjectId: `c${i}`, payload: { i } }))),
    );
    expect(await verifyLedgerIntegrity(db)).toEqual({ valid: true, blockCount: 25 });
  });
});
