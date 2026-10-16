/** npx tsx scripts/brapi-capabilities.ts SYMBOL... — last candles of a few assets (read-only; no token printed). */
import { fetchDailyCandles, readBrapiToken } from '../src/market/brapi.js';
const token = readBrapiToken()!;
for (const s of process.argv.slice(2)) {
  const c = await fetchDailyCandles(s, token);
  console.log(s, c.length, c.slice(-4).map((x) => `${x.at.toISOString().slice(5, 10)} c=${x.close} h=${x.high} l=${x.low} v=${x.volume}`).join(' | '));
}
