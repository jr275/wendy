import type { MarketOverview, MarketQuote } from "./wendy";
import { fmtChange, fmtDay, fmtPrice } from "./marketChart";

/** Friendly names for the reference series. Anything else is shown by its code. */
export const REFERENCE_NAME: Record<string, string> = { "^BVSP": "Ibovespa", QQQ: "Nasdaq-100 (ETF QQQ)" };
export const nameOf = (symbol: string) => REFERENCE_NAME[symbol] ?? symbol;
export const kindOf = (symbol: string, market: "B3" | "US"): "B3" | "US" | "index" => (symbol.startsWith("^") ? "index" : market);

const phrase = (q: MarketQuote) => `${nameOf(q.symbol)} fechou em ${fmtPrice(q.lastClose, kindOf(q.symbol, q.market))} (${fmtChange(q.changePct)}) em ${fmtDay(q.asOf)}`;

/**
 * One plain paragraph of the day, built ONLY from stored figures (no model, nothing inferred): what the references closed at, and the biggest
 * move among the assets the person follows. It says nothing about why, and nothing about what to do. Empty when there is nothing to say.
 */
export function summarizeMarket(o: Pick<MarketOverview, "references" | "gainers" | "losers">): string {
  const parts: string[] = [];
  if (o.references.length) parts.push(`${o.references.map(phrase).join("; ")}.`);
  const up = o.gainers[0];
  const down = o.losers[0];
  const moves = [up && up.changePct !== null ? `a maior alta foi ${up.symbol} (${fmtChange(up.changePct)})` : null, down && down.changePct !== null ? `a maior queda foi ${down.symbol} (${fmtChange(down.changePct)})` : null].filter(Boolean);
  if (moves.length) parts.push(`Entre os ativos que você acompanha, ${moves.join(" e ")}, considerando só os que negociam volume relevante.`);
  return parts.join(" ");
}
