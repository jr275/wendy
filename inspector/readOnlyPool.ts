import pg from 'pg';

/** Every session opened by the inspector is read-only at the database level: writes are rejected by Postgres. */
export function readOnlyPool(connectionString: string, schema: string | null): pg.Pool {
  const options = ['-c default_transaction_read_only=on', ...(schema ? [`-c search_path=${schema}`] : [])].join(' ');
  return new pg.Pool({ connectionString, max: 4, options });
}
