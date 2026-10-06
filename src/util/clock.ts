/** Injected time source: detectors, deadlines and tests never read the wall clock directly. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(at: Date | string): Clock & { set(d: Date | string): void } {
  let current = new Date(at);
  return {
    now: () => new Date(current),
    set: (d) => {
      current = new Date(d);
    },
  };
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
