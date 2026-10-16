import { describe, expect, it } from 'vitest';
import { chartGeometry, fmtChange, fmtDay, fmtPrice, niceTicks, sparkPoints, type Candle } from '@/lib/marketChart.js';

const c = (day: string, o: number, h: number, l: number, cl: number, volume = 100): Candle => ({ day, open: o, high: h, low: l, close: cl, volume });
const SERIES = [c('2026-10-01', 10, 12, 9, 11, 100), c('2026-10-02', 11, 13, 10, 10.5, 300), c('2026-10-03', 10.5, 11, 10, 10.5, 200)];

describe('chart geometry', () => {
  it('maps every price inside the plot, higher prices higher up, and keeps wick, body and volume consistent', () => {
    const g = chartGeometry(SERIES);
    expect(g.candles).toHaveLength(3);
    for (const d of g.candles) {
      expect(d.wickTop).toBeGreaterThanOrEqual(g.plot.top);
      expect(d.wickBottom).toBeLessThanOrEqual(g.plot.bottom);
      expect(d.wickTop).toBeLessThan(d.wickBottom);
      expect(d.bodyTop).toBeGreaterThanOrEqual(d.wickTop - 1e-9);
      expect(d.bodyTop + d.bodyHeight).toBeLessThanOrEqual(d.wickBottom + 1 + 1e-9);
      expect(d.volTop + d.volHeight).toBeCloseTo(g.vol.bottom, 6);
    }
    expect(g.candles[1]!.wickTop).toBeLessThan(g.candles[0]!.wickTop); // the 13 high is above the 12 high
    expect(g.candles[1]!.volHeight).toBeGreaterThan(g.candles[0]!.volHeight); // volume 300 > 100
  });
  it('up and down days are told apart by the numbers, not guessed, and a doji (open = close) still has a visible body', () => {
    const g = chartGeometry(SERIES);
    expect(g.candles.map((d) => d.up)).toEqual([true, false, true]);
    expect(g.candles[2]!.bodyHeight).toBeGreaterThanOrEqual(1);
  });
  it('spaces candles evenly left to right inside the plot', () => {
    const g = chartGeometry(SERIES);
    const xs = g.candles.map((d) => d.x);
    expect(xs[0]!).toBeGreaterThan(g.plot.left);
    expect(xs[2]!).toBeLessThan(g.plot.right);
    expect(xs[1]! - xs[0]!).toBeCloseTo(xs[2]! - xs[1]!, 6);
  });
  it('a flat series and a single candle still produce finite numbers (no NaN, no division by zero)', () => {
    for (const s of [[c('a', 5, 5, 5, 5, 0)], [c('a', 5, 5, 5, 5, 0), c('b', 5, 5, 5, 5, 0)]]) {
      const g = chartGeometry(s);
      expect(g.candles.length).toBe(s.length);
      for (const d of g.candles) for (const v of [d.x, d.wickTop, d.wickBottom, d.bodyTop, d.bodyHeight, d.volHeight]) expect(Number.isFinite(v)).toBe(true);
    }
  });
  it('drops malformed candles instead of drawing them, and an empty series is empty', () => {
    expect(chartGeometry([c('a', NaN, 2, 1, 1)]).candles).toEqual([]);
    expect(chartGeometry([c('a', 1, 1, 2, 1)]).candles).toEqual([]); // high below low
    expect(chartGeometry([]).candles).toEqual([]);
  });
  it('flags only the days that exist in the series, joins several observations of one day, and ignores the rest', () => {
    const g = chartGeometry(SERIES, [{ day: '2026-10-02', kind: 'VOLUME_SPIKE' }, { day: '2026-10-02', kind: 'MOVE_OUTLIER' }, { day: '2025-01-01', kind: 'X' }]);
    expect(g.marks).toHaveLength(1);
    expect(g.marks[0]).toMatchObject({ day: '2026-10-02', kinds: ['VOLUME_SPIKE', 'MOVE_OUTLIER'] });
    expect(g.marks[0]!.x).toBe(g.candles[1]!.x);
  });
  it('axis ticks are round values inside the range, and at most five dates are labelled, the first and last among them', () => {
    const g = chartGeometry(Array.from({ length: 60 }, (_, i) => c(`2026-09-${String((i % 28) + 1).padStart(2, '0')}`, 100 + i, 102 + i, 98 + i, 101 + i)));
    expect(g.yTicks.length).toBeGreaterThanOrEqual(2);
    for (const t of g.yTicks) {
      expect(t.value).toBeGreaterThanOrEqual(g.min);
      expect(t.value).toBeLessThanOrEqual(g.max);
      expect(t.y).toBeGreaterThanOrEqual(g.plot.top - 1e-9);
      expect(t.y).toBeLessThanOrEqual(g.plot.bottom + 1e-9);
    }
    expect(g.xTicks).toHaveLength(5);
    expect(g.xTicks[0]!.x).toBe(g.candles[0]!.x);
    expect(g.xTicks[4]!.x).toBe(g.candles[59]!.x);
  });
  it('nice ticks', () => {
    expect(niceTicks(0, 100, 4)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(9.7, 13.2, 4)).toEqual([10, 11, 12, 13]);
    expect(niceTicks(5, 5)).toEqual([5]);
  });
});

describe('sparkline and number formats', () => {
  it('a line that fills the box, rising prices go up, and fewer than two points draw nothing', () => {
    const pts = sparkPoints([1, 2, 3], 100, 20, 0).split(' ').map((p) => p.split(',').map(Number));
    expect(pts[0]).toEqual([0, 20]);
    expect(pts[2]).toEqual([100, 0]);
    expect(sparkPoints([5], 100, 20)).toBe('');
    expect(sparkPoints([])).toBe('');
    expect(sparkPoints([3, 3, 3], 100, 20)).not.toMatch(/NaN/);
  });
  it('formats in Brazilian Portuguese: reais, dollars, index points, a real minus sign, and day/month', () => {
    expect(fmtPrice(57.36, 'B3')).toBe('R$ 57,36');
    expect(fmtPrice(342, 'US')).toBe('US$ 342,00');
    expect(fmtPrice(205430.33, 'index')).toBe('205.430');
    expect(fmtChange(0.54)).toBe('+0,54%');
    expect(fmtChange(-7.67)).toBe('−7,67%');
    expect(fmtChange(0)).toBe('0,00%');
    expect(fmtChange(null)).toBe('—');
    expect(fmtDay('2026-10-15')).toBe('15/10');
  });
});
