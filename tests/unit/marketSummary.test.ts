import { describe, expect, it } from 'vitest';
import { kindOf, nameOf, summarizeMarket } from '@/lib/marketSummary.js';

const q = (symbol: string, lastClose: number, changePct: number | null, market: 'B3' | 'US' = 'B3') => ({ symbol, market, lastClose, prevClose: null, changePct, asOf: '2026-10-15' });

describe('the day in one paragraph (built only from stored figures)', () => {
  it('states what the references closed at and the biggest moves, with the day, and says nothing about why or what to do', () => {
    const t = summarizeMarket({ references: [q('^BVSP', 205430.33, 0.54), q('QQQ', 612.5, -0.4, 'US')], gainers: [q('MELK3', 3.5, 8.1)], losers: [q('DIRR3', 9.2, -9.26)] });
    expect(t).toBe('Ibovespa fechou em 205.430 (+0,54%) em 15/10; Nasdaq-100 (ETF QQQ) fechou em US$ 612,50 (−0,40%) em 15/10. Entre os ativos que você acompanha, a maior alta foi MELK3 (+8,10%) e a maior queda foi DIRR3 (−9,26%), considerando só os que negociam volume relevante.');
    expect(t.toLowerCase()).not.toMatch(/compre|venda|recomend|previs|alvo|deve|vai subir|vai cair/);
  });
  it('is empty when there is nothing to say, mentions only the side that exists, and leaves out the movers sentence when there are none', () => {
    expect(summarizeMarket({ references: [], gainers: [q('AAA3', 1, 2)], losers: [] })).toBe('Entre os ativos que você acompanha, a maior alta foi AAA3 (+2,00%), considerando só os que negociam volume relevante.');
    expect(summarizeMarket({ references: [], gainers: [], losers: [] })).toBe('');
    expect(summarizeMarket({ references: [q('^BVSP', 1000, 1)], gainers: [], losers: [] })).toBe('Ibovespa fechou em 1.000 (+1,00%) em 15/10.');
  });
  it('names the references and formats an index without a currency', () => {
    expect(nameOf('^BVSP')).toBe('Ibovespa');
    expect(nameOf('PETR4')).toBe('PETR4');
    expect(kindOf('^BVSP', 'B3')).toBe('index');
    expect(kindOf('AAPL', 'US')).toBe('US');
  });
});
