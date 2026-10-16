/**
 * market-watch: "o que o mercado mostrou?" — what the market monitor flagged as unusual in the assets Wendy watches (largest B3 stocks and US tech).
 * It reports OBSERVATIONS with their numbers. It does not recommend, predict or say what to do, and it places no orders. The information is delayed.
 */
import { z } from 'zod';
import type { MarketToolOutput } from '../../tools/research.js';
import type { SkillDefinition } from '../types.js';

const Input = z.object({ days: z.number().int().min(1).max(30).optional().describe('How many days back (default 7).') });
const Output = z.object({
  lastCheck: z.string().nullable(),
  assetsWithObservations: z.number().int(),
  observations: z.array(z.object({ symbol: z.string(), kind: z.string(), candleDate: z.string(), text: z.string() })),
  note: z.string(),
});
export type MarketWatchOutput = z.infer<typeof Output>;

export const MARKET_NOTE = 'Observações estatísticas sobre informações com atraso (cerca de 30 min), só para acompanhamento: não são recomendação de compra ou venda, nem previsão.';

export const marketWatchSkill: SkillDefinition<z.infer<typeof Input>, MarketWatchOutput> = {
  id: 'market-watch',
  name: 'Mercado',
  description: "What the market monitor flagged as unusual (price move, volume, trading range) in the watched B3 and US tech stocks in the last days. Observations only, with numbers; no advice, no predictions, no orders.",
  version: '1.0.0',
  category: 'research',
  triggers: [{ kind: 'intent', examples: ['O que o mercado mostrou hoje?', 'Alguma ação fora do comum?', 'Teve movimento estranho na bolsa?', 'O que se mexeu na B3 e nas techs americanas?'] }],
  requiredTools: ['market.alerts'],
  composable: true,
  autonomous: false,
  riskLevel: 'LOW',
  instructions: 'Report the observations as given, with the asset, the kind and the numbers. Never say to buy, sell or hold, never predict direction or give a target. State that the information is delayed.',
  inputs: Input,
  outputs: Output,
  steps: [
    {
      id: 'read',
      label: 'Olhando o monitor do mercado',
      timeoutMs: 30_000,
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        const r = (await ctx.read('market.alerts', { days: i.days ?? 7 })) as MarketToolOutput;
        const note = MARKET_NOTE;
        return {
          kind: 'done',
          output: {
            lastCheck: r.lastRun ? `${r.lastRun.date}${r.lastRun.status === 'FAILED' ? ' (falhou)' : ''}` : null,
            assetsWithObservations: r.symbolsWithAlerts,
            observations: r.alerts.map((a) => ({ symbol: a.symbol, kind: a.kind, candleDate: a.observedAt.slice(0, 10), text: a.explanation })),
            note: r.lastRun ? note : `O monitor ainda não rodou. ${MARKET_NOTE}`,
          },
        };
      },
    },
  ],
};
