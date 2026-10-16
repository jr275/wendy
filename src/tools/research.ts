/** research.digest (READ): the principal's reading digest; optionally fetches the public feeds first. */
import { z } from 'zod';
import { digestFor, refreshDigest } from '../routines/digestService.js';
import { TOOL_SPECS } from './specs.js';
import type { ReadTool } from './types.js';

export interface DigestToolOutput {
  /** What the refresh did: done | skipped (already ran today) | failed | no_routine | not_requested. */
  refresh: string;
  items: { id: string; title: string; url: string; source: string; publishedAt: string | null; summary: string | null; why: string | null; read: boolean }[];
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
  return { 'research.digest': digest };
}
