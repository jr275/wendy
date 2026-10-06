import crypto from 'node:crypto';
import { createPool, migrate, type Db } from '../../src/db/db.js';

const TEST_DB_URL = process.env.WENDY_TEST_DATABASE_URL ?? 'postgres:///wendy_test';

/** Each test file gets its own fresh schema in the test database; nothing touches data/ or the dev DB. */
export async function createTestDb(): Promise<{ db: Db; schema: string; reconnect(): Db; drop(): Promise<void> }> {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const admin = createPool(TEST_DB_URL);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const db = createPool(TEST_DB_URL, schema);
  await migrate(db);
  const extra: Db[] = [];
  return {
    db,
    schema,
    /** A brand-new pool on the same schema — simulates a process restart. */
    reconnect() {
      const p = createPool(TEST_DB_URL, schema);
      extra.push(p);
      return p;
    },
    async drop() {
      await Promise.all([db.end(), ...extra.map((p) => p.end().catch(() => {}))]).catch(() => {});
      const a = createPool(TEST_DB_URL);
      await a.query(`DROP SCHEMA ${schema} CASCADE`);
      await a.end();
    },
  };
}
