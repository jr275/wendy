/**
 * npx tsx scripts/market-backfill.ts SYMBOL [SYMBOL…]
 * Fetches the last ~3 months of daily candles for the given watched symbols (ONE request to the data provider per symbol) and stores them, so the
 * market screen has history before the next scheduled sweep. Only symbols already in the watched list are accepted. Prints counts, nothing else.
 */
import { databaseUrl, loadEnv } from '../src/config.js';
import { createPool } from '../src/db/db.js';
import { fetchDailyCandles, readBrapiToken } from '../src/market/brapi.js';
import { storeCandles } from '../src/market/candles.js';

loadEnv();
const symbols = process.argv.slice(2).map((s) => s.toUpperCase());
if (!symbols.length) throw new Error('give at least one symbol');
const token = readBrapiToken();
if (!token) throw new Error('no token at ~/.wendy/brapi-token');
const db = createPool(databaseUrl());
const pid = (await db.query<{ id: string }>('SELECT id FROM principals ORDER BY created_at LIMIT 1')).rows[0]!.id;
for (const [i, s] of symbols.entries()) {
  const known = (await db.query(`SELECT 1 FROM watchlist WHERE principal_id = $1 AND symbol = $2`, [pid, s])).rowCount;
  if (!known) { console.log(`${s}: not in the watched list, skipped`); continue; }
  if (i) await new Promise((r) => setTimeout(r, 800));
  try {
    const n = await storeCandles(db, pid, s, await fetchDailyCandles(s, token), new Date());
    console.log(`${s}: ${n} candles stored`);
  } catch (e) {
    console.log(`${s}: ${(e as Error).message}`);
  }
}
await db.end();
