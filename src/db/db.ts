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

/** Migration files the database has not applied yet. Read-only: creates nothing. */
export async function pendingMigrations(db: Db): Promise<string[]> {
  const has = (await db.query<{ t: string | null }>(`SELECT to_regclass('schema_migrations')::text AS t`)).rows[0]!.t;
  const applied = new Set(has ? (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name) : []);
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && !applied.has(f)).sort();
}

/**
 * For long-running processes (the worker): never change the schema just because the process restarted. A pending migration is the person's
 * decision (backup first, then `npm run migrate`), so the process refuses to start and says so, unless WENDY_AUTO_MIGRATE=1.
 */
export async function assertMigrated(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.WENDY_AUTO_MIGRATE === '1') {
    await migrate(db);
    return;
  }
  const pending = await pendingMigrations(db);
  if (pending.length) throw new Error(`há migrations pendentes (${pending.join(', ')}). Faça um backup e rode "npm run migrate"; o processo não altera o banco sozinho (WENDY_AUTO_MIGRATE=1 muda isso).`);
}

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
