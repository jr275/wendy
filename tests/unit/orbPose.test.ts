/**
 * The Wendy orb's motion (web/lib/orbPose.ts). Pure: no browser, no Spline.
 * What is proven: every state gives finite, sane values for any time; the still states do not move; the working states move differently from
 * idle in the way their meaning says; the error shake dies out; and only the authored part names are ever written.
 */
import { describe, expect, it } from 'vitest';
import { ORB_PARTS, isStill, orbPose, type OrbState } from '../../web/lib/orbPose.js';

const STATES: OrbState[] = ['idle', 'listening', 'thinking', 'executing', 'awaiting', 'completed', 'error', 'unavailable'];
const TIMES = [0, 0.016, 0.5, 1, 3.7, 60, 3600, 86_400];

describe('orbPose', () => {
  it('only ever names the authored parts, and every number is finite with a scale that cannot collapse or explode the orb', () => {
    for (const s of STATES)
      for (const t of TIMES)
        for (const since of [0, 0.2, 5]) {
          const pose = orbPose(s, t, since);
          for (const [name, p] of Object.entries(pose)) {
            expect(ORB_PARTS as readonly string[], `${s}/${name}`).toContain(name);
            for (const v of Object.values(p!)) expect(Number.isFinite(v), `${s}/${name}`).toBe(true);
            if (p!.scale !== undefined) {
              expect(p!.scale).toBeGreaterThan(0.8);
              expect(p!.scale).toBeLessThan(1.25);
            }
            if (p!.rotZ !== undefined) expect(Math.abs(p!.rotZ)).toBeLessThan(Math.PI * 2 + 1e-9); // bounded: no number grows with uptime
          }
        }
  });
  it('the still states (an approval is waiting; unavailable) do not change with time', () => {
    for (const s of ['awaiting', 'unavailable'] as const) {
      expect(isStill(s)).toBe(true);
      expect(orbPose(s, 1, 0)).toEqual(orbPose(s, 999, 50));
    }
    for (const s of STATES.filter((x) => x !== 'awaiting' && x !== 'unavailable')) expect(isStill(s)).toBe(false);
  });
  it('idle breathes: the core scale changes over time', () => {
    const a = orbPose('idle', 0, 0)['Orb Core']!.scale!;
    const b = orbPose('idle', Math.PI / 2 / 1.2, 0)['Orb Core']!.scale!;
    expect(a).not.toBe(b);
  });
  it('thinking spins the rings faster than idle, and executing sends the dots around faster than thinking', () => {
    const speed = (s: OrbState, part: 'Orb Ring 1' | 'Orb Orbit 1') => Math.abs(orbPose(s, 0.1, 0)[part]!.rotZ! - orbPose(s, 0, 0)[part]!.rotZ!);
    expect(speed('thinking', 'Orb Ring 1')).toBeGreaterThan(speed('idle', 'Orb Ring 1') * 3);
    expect(speed('executing', 'Orb Orbit 1')).toBeGreaterThan(speed('thinking', 'Orb Orbit 1'));
  });
  it('answering pulses with rests: the scale goes up and back to its base within a second', () => {
    const scales = Array.from({ length: 200 }, (_, i) => orbPose('completed', i * 0.005, 0)['Orb Core']!.scale!);
    expect(Math.max(...scales)).toBeGreaterThan(1.04);
    expect(Math.min(...scales)).toBeLessThan(1.002);
  });
  it('the error shake starts, dies out, and leaves the orb still, smaller and with its rings stopped', () => {
    const shake = (since: number) => Math.max(...Array.from({ length: 100 }, (_, i) => Math.abs(orbPose('error', 5, since + i * 0.002)['Orbe Wendy']!.posX!)));
    expect(shake(0)).toBeGreaterThan(2);
    expect(shake(0)).toBeLessThanOrEqual(10);
    expect(shake(3)).toBeLessThan(0.01);
    const rest = orbPose('error', 100, 10);
    expect(rest['Orb Core']!.scale).toBeLessThan(1);
    expect(rest['Orb Ring 1']!.rotZ).toBe(0);
    expect(orbPose('error', 100, 10)).toEqual(orbPose('error', 200, 10)); // after the shake nothing depends on the clock
  });
});
