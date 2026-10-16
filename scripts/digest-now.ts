/** npx tsx scripts/digest-now.ts — runs the reading digest now for the first principal (public RSS feeds; writes the items to the database). Same runner as the 07:30 schedule: at most one finished run per local day. */
import { databaseUrl, loadEnv } from '../src/config.js';
import { createPool } from '../src/db/db.js';
import { refreshDigest } from '../src/routines/digestService.js';

loadEnv();
const db = createPool(databaseUrl());
const pid = (await db.query<{ id: string }>('SELECT id FROM principals ORDER BY created_at LIMIT 1')).rows[0]?.id;
console.log(pid ? JSON.stringify(await refreshDigest(db, pid, new Date())) : 'no principal');
await db.end();
