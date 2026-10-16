/** npx tsx scripts/market-now.ts — runs the market sweep now (reads brapi with the token in ~/.wendy/brapi-token; writes the watchlist and observations). One finished run per local day. Monitoring only. */
import { databaseUrl, loadEnv } from '../src/config.js';
import { createPool } from '../src/db/db.js';
import { marketWatchHandler } from '../src/routines/marketWatch.js';
import { runDueRoutines } from '../src/routines/runner.js';

loadEnv();
const db = createPool(databaseUrl());
console.log(JSON.stringify(await runDueRoutines(db, { handlers: { market_watch: marketWatchHandler() } }, new Date(), { force: true, onlyKind: 'market_watch' })));
await db.end();
