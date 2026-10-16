import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import { assertMigrated, pendingMigrations } from '../../src/db/db.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(() => t.drop());

describe('a restarting process never changes the schema by itself', () => {
  it('with everything applied it starts normally and has nothing pending', async () => {
    expect(await pendingMigrations(db)).toEqual([]);
    await expect(assertMigrated(db, {})).resolves.toBeUndefined();
  });
  it('with a migration pending it refuses to start and names it, and changes nothing', async () => {
    await db.query(`DELETE FROM schema_migrations WHERE name = '012_market_view.sql'`);
    expect(await pendingMigrations(db)).toEqual(['012_market_view.sql']);
    await expect(assertMigrated(db, {})).rejects.toThrow(/012_market_view\.sql.*npm run migrate/);
    expect(await pendingMigrations(db)).toEqual(['012_market_view.sql']); // still pending: nothing was applied
    await db.query(`INSERT INTO schema_migrations(name) VALUES ('012_market_view.sql')`);
  });
});
