import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

/** Parse bigint (int8) as number; our sequences stay well below 2^53. */
pg.types.setTypeParser(20, (v) => Number(v));
/** Keep DATE columns as 'YYYY-MM-DD' strings (no timezone shifting). */
pg.types.setTypeParser(1082, (v) => v);
/** numeric -> number */
pg.types.setTypeParser(1700, (v) => Number(v));

export function createPool(connectionString: string, schema?: string): Db {
  return new pg.Pool({
    connectionString,
    max: 10,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
}

/** Runs fn inside a transaction; rolls back on any error. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    await withTx(db, async (tx) => {
      await tx.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
      await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
    });
    ran.push(file);
  }
  return ran;
}
