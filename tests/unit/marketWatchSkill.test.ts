import { describe, expect, it } from 'vitest';
import { MARKET_NOTE, marketWatchSkill } from '../../src/skills/builtin/marketWatch.js';
import { builtinRegistry } from '../../src/skills/index.js';
import type { StepContext } from '../../src/skills/types.js';
import { Toolbox } from '../../src/tools/index.js';

const run = (r: object, input: object = {}) => {
  const calls: unknown[] = [];
  const ctx = { input, read: async (t: string, i: unknown) => { calls.push([t, i]); return r; } } as unknown as StepContext;
  return marketWatchSkill.steps[0]!.run(ctx).then((out) => ({ out: (out as { output: Record<string, unknown> }).output, calls }));
};

describe('market-watch skill', () => {
  it('is registered, read-only, not autonomous, and its tool exists', () => {
    expect(builtinRegistry().get('market-watch')).toBeTruthy();
    expect(marketWatchSkill.requiredTools).toEqual(['market.alerts']);
    expect(marketWatchSkill.autonomous).toBe(false);
    expect(new Toolbox({ search: () => { throw new Error('no'); } }).read('market.alerts')).toBeTruthy();
  });
  it('passes the observations through with their dates and always carries the "not advice" note', async () => {
    const { out, calls } = await run({ lastRun: { date: '2026-10-16', status: 'DONE', error: null }, symbolsWithAlerts: 7, alerts: [{ symbol: 'MELK3', kind: 'VOLUME_SPIKE', observedAt: '2026-10-15T03:00:00.000Z', explanation: 'MELK3: volume 3,1×' }] });
    expect(calls).toEqual([['market.alerts', { days: 7 }]]);
    expect(out).toMatchObject({ lastCheck: '2026-10-16', assetsWithObservations: 7, note: MARKET_NOTE });
    expect((out.observations as { candleDate: string }[])[0]!.candleDate).toBe('2026-10-15');
    expect(MARKET_NOTE).toMatch(/não são recomendação/);
  });
  it('says plainly that the monitor has not run yet, instead of implying a calm market', async () => {
    const { out } = await run({ lastRun: null, symbolsWithAlerts: 0, alerts: [] });
    expect(out.lastCheck).toBeNull();
    expect(String(out.note)).toMatch(/ainda não rodou/);
    expect(out.observations).toEqual([]);
  });
});
