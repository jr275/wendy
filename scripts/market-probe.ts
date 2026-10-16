/** npx tsx scripts/market-probe.ts PETR4 — one read-only brapi request and the signals it yields. Prints no token, writes nothing. */
import { fetchDailyCandles, readBrapiToken } from '../src/market/brapi.js';
import { DATA_NOTE, detect } from '../src/market/signals.js';

const symbol = (process.argv[2] ?? 'PETR4').toUpperCase();
const token = readBrapiToken();
if (!token) throw new Error('sem token em ~/.wendy/brapi-token');
const candles = await fetchDailyCandles(symbol, token);
const last = candles.at(-1);
console.log(`${symbol}: ${candles.length} candles diários; último em ${last?.at.toISOString().slice(0, 10)} fechamento ${last?.close} volume ${last?.volume}`);
const r = detect(symbol, candles);
console.log(r.skipped ?? (r.signals.length ? r.signals.map((s) => `• ${s.explanation}`).join('\n') : 'Nenhum sinal fora do comum no último pregão.'));
console.log(DATA_NOTE);
