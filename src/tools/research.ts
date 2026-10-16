/** research.digest (READ): the principal's reading digest; optionally fetches the public feeds first. */
import { z } from 'zod';
import { digestFor, marketAlertsFor, refreshDigest } from '../routines/digestService.js';
import { TOOL_SPECS } from './specs.js';
import type { ReadTool } from './types.js';

export interface DigestToolOutput {
  /** What the refresh did: done | skipped (already ran today) | failed | no_routine | not_requested. */
  refresh: string;
  items: { id: string; title: string; url: string; source: string; publishedAt: string | null; summary: string | null; why: string | null; read: boolean }[];
}

export interface MarketToolOutput {
  lastRun: { date: string; status: string; error: string | null } | null;
  /** How many assets had observations in the window (the list below shows only the strongest). */
  symbolsWithAlerts: number;
  alerts: { symbol: string; kind: string; observedAt: string; explanation: string }[];
}

export function researchTools() {
  const digest: ReadTool<{ refresh?: boolean }, DigestToolOutput> = {
    spec: TOOL_SPECS['research.digest'],
    input: z.object({ refresh: z.boolean().optional() }).strict(),
    run: async (ctx, input) => {
      const refresh = input.refresh ? (await refreshDigest(ctx.db, ctx.principalId, ctx.now)).outcome : 'not_requested';
      const v = await digestFor(ctx.db, ctx.principalId, 10);
      return { refresh, items: v.items.map(({ id, title, url, source, publishedAt, summary, why, read }) => ({ id, title, url, source, publishedAt, summary, why, read })) };
    },
  };
  const market: ReadTool<{ days?: number }, MarketToolOutput> = {
    spec: TOOL_SPECS['market.alerts'],
    input: z.object({ days: z.number().int().min(1).max(30).optional() }).strict(),
    run: async (ctx, input) => {
      const v = await marketAlertsFor(ctx.db, ctx.principalId, input.days ?? 7, 12);
      return { lastRun: v.lastRun, symbolsWithAlerts: v.symbolsWithAlerts, alerts: v.alerts.map(({ symbol, kind, observedAt, explanation }) => ({ symbol, kind, observedAt, explanation })) };
    },
  };
  return { 'research.digest': digest, 'market.alerts': market };
}
