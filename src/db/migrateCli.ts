import { databaseUrl, loadEnv } from '../config.js';
import { createPool, migrate } from './db.js';

loadEnv();
const db = createPool(databaseUrl());
const ran = await migrate(db);
console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Schema up to date.');
await db.end();
