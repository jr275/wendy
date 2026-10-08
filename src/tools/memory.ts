/**
 * memory.propose (WRITE, automatic by default): stores memory PROPOSALS. A proposal is inert — it is
 * not used as active memory until the principal confirms it (MemoryService.confirm). Idempotent per
 * action: every proposal carries the action in its evidence, so a retried execution finds them.
 */
import { z } from 'zod';
import { appendAudit } from '../audit/ledger.js';
import { withTx } from '../db/db.js';
import { pgRepositories } from '../repositories/pg.js';
import { TOOL_SPECS } from './specs.js';
import type { ReadTool, ToolEffect } from './types.js';

export const MemoryProposalSchema = z.object({
  kind: z.enum(['PREFERENCE', 'FACT']),
  content: z.string().min(5).max(1200),
  evidence: z.array(z.object({ kind: z.enum(['document', 'web_page']), id: z.string() })).min(1).max(5),
});

const byAction = (actionId: string) => JSON.stringify([{ kind: 'action', id: actionId }]);
const shape = (m: { kind: string; content: string }) => ({ kind: m.kind, content: m.content });
const sorted = <T extends { content: string }>(ms: T[]) => [...ms].sort((a, b) => a.content.localeCompare(b.content));

export function memoryTools() {
  const propose: ToolEffect<{ memories: z.infer<typeof MemoryProposalSchema>[] }> = {
    spec: TOOL_SPECS['memory.propose'],
    input: z.object({ memories: z.array(MemoryProposalSchema).min(1).max(20) }),
    perform: async (ctx, i) =>
      withTx(ctx.db, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`memories:${ctx.actionId}`]);
        const existing = await tx.query('SELECT 1 FROM memories WHERE principal_id = $1 AND evidence @> $2::jsonb LIMIT 1', [ctx.principalId, byAction(ctx.actionId)]);
        if (!existing.rowCount) {
          const repo = pgRepositories().memories;
          for (const m of i.memories)
            await repo.write(tx, { principalId: ctx.principalId, kind: m.kind, subjectPersonId: null, content: m.content, confidence: 0.7, evidence: [...m.evidence, { kind: 'action', id: ctx.actionId }], writtenBy: 'WENDY', createdAt: ctx.now, status: 'PROPOSED' });
          await appendAudit(tx, { principalId: ctx.principalId, eventType: 'MEMORIES_PROPOSED', actor: 'WENDY', subjectType: 'action', subjectId: ctx.actionId, payload: { count: i.memories.length } });
        }
        return { providerRef: `memories:${ctx.actionId}` };
      }),
    readBack: async (ctx) => {
      const rows = (await ctx.db.query<{ kind: string; content: string }>('SELECT kind, content FROM memories WHERE principal_id = $1 AND evidence @> $2::jsonb', [ctx.principalId, byAction(ctx.actionId)])).rows;
      return rows.length ? { providerRef: `memories:${ctx.actionId}`, observed: { memories: sorted(rows.map(shape)) } } : null;
    },
    expected: (i) => ({ memories: sorted(i.memories.map(shape)) }),
  };
  const proposals: ReadTool<{ actionId: string }, { id: string; content: string; status: string }[]> = {
    spec: TOOL_SPECS['memory.proposals'],
    input: z.object({ actionId: z.uuid() }),
    run: async (ctx, i) =>
      (await ctx.db.query<{ id: string; content: string; status: string }>('SELECT id, content, status FROM memories WHERE principal_id = $1 AND evidence @> $2::jsonb ORDER BY created_at', [ctx.principalId, byAction(i.actionId)])).rows,
  };
  return { 'memory.propose': propose, 'memory.proposals': proposals };
}
