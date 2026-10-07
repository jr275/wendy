/**
 * Memory freshness: a memory's weight halves every half-life since it was last confirmed by the
 * principal (or since it was written, if never confirmed). Nothing is deleted or hidden by age:
 * the weight is shown to the model and to the principal, and old preferences/facts are offered
 * for reconfirmation. Episodes and outcomes record things that happened, so they lose weight but
 * are never "due for review".
 */
import type { Memory, MemoryKind } from '../domain/types.js';
import { DAY_MS } from '../util/clock.js';

export const HALF_LIFE_DAYS: Record<MemoryKind, number> = { PREFERENCE: 180, FACT: 365, EPISODE: 60, OUTCOME: 120 };
const REVIEWABLE: MemoryKind[] = ['PREFERENCE', 'FACT'];

export interface Freshness {
  since: Date; // last confirmation, or creation
  ageDays: number;
  halfLifeDays: number;
  weight: number; // 1 → just confirmed; 0.5 → one half-life old
  needsReview: boolean; // reviewable kind, active, older than one half-life
}

export function memoryFreshness(m: Pick<Memory, 'kind' | 'status' | 'created_at' | 'last_confirmed_at'>, now: Date): Freshness {
  const since = m.last_confirmed_at ?? m.created_at;
  const ageDays = Math.max(0, (now.getTime() - since.getTime()) / DAY_MS);
  const halfLifeDays = HALF_LIFE_DAYS[m.kind];
  const weight = Math.round(Math.pow(0.5, ageDays / halfLifeDays) * 1000) / 1000;
  return { since, ageDays: Math.floor(ageDays), halfLifeDays, weight, needsReview: m.status === 'ACTIVE' && REVIEWABLE.includes(m.kind) && weight < 0.5 };
}
