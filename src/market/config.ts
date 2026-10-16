/** What is watched: the US technology list and how many of the most traded B3 assets. Edited in config/market-watch.json; a bad file falls back to the defaults (and says so). */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const Config = z.object({ b3Top: z.number().int().min(10).max(500), us: z.array(z.string().regex(/^[A-Z]{1,5}$/)).max(100) });
export type MarketWatchConfig = z.infer<typeof Config>;
export const DEFAULT_US = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'AMD', 'ORCL', 'ADBE', 'CRM', 'NFLX', 'INTC', 'CSCO', 'QCOM', 'TXN', 'IBM', 'AMAT', 'MU', 'NOW', 'INTU', 'PANW', 'SNPS', 'CDNS', 'UBER', 'SHOP', 'PLTR', 'ANET', 'LRCX'];
export const DEFAULT_CONFIG: MarketWatchConfig = { b3Top: 300, us: DEFAULT_US };

export function loadMarketConfig(file = process.env.WENDY_MARKET_CONFIG ?? path.resolve('config/market-watch.json')): { config: MarketWatchConfig; problem?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { config: DEFAULT_CONFIG };
  }
  try {
    const parsed = Config.safeParse(JSON.parse(raw));
    if (parsed.success) return { config: { ...parsed.data, us: [...new Set(parsed.data.us)] } };
  } catch {
    /* fall through */
  }
  return { config: DEFAULT_CONFIG, problem: 'config/market-watch.json inválido; usando a lista padrão' };
}
