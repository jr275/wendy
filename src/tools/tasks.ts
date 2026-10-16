/** tasks.list (READ) and the effects tasks.create (WRITE), tasks.complete (WRITE), tasks.delete (DESTRUCTIVE). */
import { z } from 'zod';
import { getTask, listTasks, TaskService, tasksByAction, type Task, type TaskPatch } from '../tasks/taskService.js';
import { TOOL_SPECS } from './specs.js';
import { ToolError, type ReadTool, type ToolEffect } from './types.js';

export const NewTaskSchema = z.object({
  title: z.string().min(1).max(300),
  notes: z.string().max(4000).nullable().optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).nullable().optional().describe("Only when the person said it (e.g. 'urgente'); never inferred."),
  category: z.string().min(1).max(40).nullable().optional().describe("Only when the person named one; never inferred."),
  evidence: z.array(z.object({ kind: z.string(), id: z.string() })).max(20).optional(),
});

const shape = (t: { title: string; notes?: string | null; due?: Date | string | null; priority?: string | null; category?: string | null }) => ({
  title: t.title,
  notes: t.notes ?? null,
  due: t.due ? new Date(t.due).toISOString() : null,
  priority: t.priority ?? null,
  category: t.category ?? null,
});
/** Order-independent comparison of what was approved with what is stored. */
const sorted = <T extends { title: string; notes: string | null }>(ts: T[]) => [...ts].sort((a, b) => a.title.localeCompare(b.title) || (a.notes ?? '').localeCompare(b.notes ?? ''));

export function taskTools() {
  const list: ReadTool<{ includeSnoozed?: boolean; archived?: boolean }, { id: string; title: string; dueAt: string | null; priority: string | null; category: string | null }[]> = {
    spec: TOOL_SPECS['tasks.list'],
    input: z.object({ includeSnoozed: z.boolean().optional(), archived: z.boolean().optional() }).strict(),
    run: async (ctx, input) => (await listTasks(ctx.db, ctx.principalId, input.archived ? 'ARCHIVED' : 'OPEN', { includeSnoozed: input.includeSnoozed })).map((t) => ({ id: t.id, title: t.title, dueAt: t.due_at?.toISOString() ?? null, priority: t.priority, category: t.category })),
  };

  const create: ToolEffect<{ tasks: z.infer<typeof NewTaskSchema>[] }> = {
    spec: TOOL_SPECS['tasks.create'],
    input: z.object({ tasks: z.array(NewTaskSchema).min(1).max(10) }),
    perform: async (ctx, i) => {
      await new TaskService(ctx.db).createForAction(ctx.principalId, ctx.actionId, i.tasks, ctx.executionId ?? null, ctx.now);
      return { providerRef: `tasks:${ctx.actionId}` };
    },
    readBack: async (ctx) => {
      const ts = await tasksByAction(ctx.db, ctx.principalId, ctx.actionId);
      return ts.length ? { providerRef: `tasks:${ctx.actionId}`, observed: { tasks: sorted(ts.map((t) => shape({ ...t, due: t.due_at }))) } } : null;
    },
    expected: (i) => ({ tasks: sorted(i.tasks.map((t) => shape({ ...t, due: t.dueAt }))) }),
  };

  const UpdateInput = z
    .object({
      taskId: z.uuid(),
      priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).nullable().optional(),
      category: z.string().min(1).max(40).nullable().optional(),
      snoozedUntil: z.iso.datetime({ offset: true }).nullable().optional(),
      archived: z.boolean().optional(),
    })
    .strict()
    .refine((i) => ['priority', 'category', 'snoozedUntil', 'archived'].some((k) => k in i), 'nothing to change');
  const patchOf = (i: z.infer<typeof UpdateInput>): TaskPatch => {
    const { taskId: _id, ...rest } = i;
    return rest;
  };
  const update: ToolEffect<z.infer<typeof UpdateInput>> = {
    spec: TOOL_SPECS['tasks.update'],
    input: UpdateInput,
    perform: async (ctx, i) => {
      try {
        await new TaskService(ctx.db).update(ctx.principalId, i.taskId, patchOf(i), ctx.actionId, ctx.now);
      } catch (e) {
        throw new ToolError('NOT_FOUND', e instanceof Error ? e.message : String(e));
      }
      return { providerRef: `task:${i.taskId}` };
    },
    readBack: async (ctx, i) => {
      const t = await getTask(ctx.db, ctx.principalId, i.taskId);
      if (!t) return null;
      const observed: Record<string, unknown> = { taskId: i.taskId };
      if ('priority' in i) observed.priority = t.priority;
      if ('category' in i) observed.category = t.category;
      if ('snoozedUntil' in i) observed.snoozedUntil = t.snoozed_until?.toISOString() ?? null;
      if ('archived' in i) observed.archived = t.status === 'ARCHIVED';
      return { providerRef: `task:${i.taskId}`, observed };
    },
    expected: (i) => {
      const e: Record<string, unknown> = { taskId: i.taskId };
      if ('priority' in i) e.priority = i.priority ?? null;
      if ('category' in i) e.category = i.category ?? null;
      if ('snoozedUntil' in i) e.snoozedUntil = i.snoozedUntil ? new Date(i.snoozedUntil).toISOString() : null;
      if ('archived' in i) e.archived = i.archived === true;
      return e;
    },
  };

  const move = (name: 'tasks.complete' | 'tasks.delete', to: Task['status'] & ('DONE' | 'DELETED')): ToolEffect<{ taskId: string }> => ({
    spec: TOOL_SPECS[name],
    input: z.object({ taskId: z.uuid() }),
    perform: async (ctx, i) => {
      try {
        await new TaskService(ctx.db).setStatus(ctx.principalId, i.taskId, to, ctx.actionId, ctx.now);
      } catch (e) {
        throw new ToolError('NOT_FOUND', e instanceof Error ? e.message : String(e));
      }
      return { providerRef: `task:${i.taskId}` };
    },
    readBack: async (ctx, i) => {
      const t = await getTask(ctx.db, ctx.principalId, i.taskId);
      return t && t.status === to ? { providerRef: `task:${i.taskId}`, observed: { taskId: i.taskId, status: t.status } } : null;
    },
    expected: (i) => ({ taskId: i.taskId, status: to }),
  });

  return { 'tasks.list': list, 'tasks.create': create, 'tasks.update': update, 'tasks.complete': move('tasks.complete', 'DONE'), 'tasks.delete': move('tasks.delete', 'DELETED') };
}
