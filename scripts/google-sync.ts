/** One Google sync now (the worker also does it periodically). Prints counts only. */
import { databaseUrl, loadEnv } from '../src/config.js';
import { createPool, migrate } from '../src/db/db.js';
import { GoogleRestApi } from '../src/sensors/google/api.js';
import { authorizedClient } from '../src/sensors/google/auth.js';
import { syncGoogle } from '../src/sensors/google/sync.js';

loadEnv();
const db = createPool(databaseUrl());
await migrate(db);
const email = (process.env.WENDY_PRINCIPAL_EMAIL ?? '').toLowerCase();
const p = (await db.query<{ id: string }>('SELECT id FROM principals WHERE primary_email = $1', [email])).rows[0];
if (!p) throw new Error('principal not found');
const started = Date.now();
const r = await syncGoogle(db, new GoogleRestApi(authorizedClient()), p.id, new Date());
console.log(JSON.stringify({ mode: r.mode, messagesListed: r.messagesListed, mail: r.report.mail, calendar: r.report.calendar, people: r.report.people, seconds: Math.round((Date.now() - started) / 1000) }, null, 2));
await db.end();
