/** tasks.list (READ) and the effects tasks.create (WRITE), tasks.complete (WRITE), tasks.delete (DESTRUCTIVE). */
import { z } from 'zod';
import { getTask, listTasks, TaskService, tasksByAction, type Task } from '../tasks/taskService.js';
import { TOOL_SPECS } from './specs.js';
import { ToolError, type ReadTool, type ToolEffect } from './types.js';

export const NewTaskSchema = z.object({
  title: z.string().min(1).max(300),
  notes: z.string().max(4000).nullable().optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  evidence: z.array(z.object({ kind: z.string(), id: z.string() })).max(20).optional(),
});

const shape = (t: { title: string; notes?: string | null; due?: Date | string | null }) => ({
  title: t.title,
  notes: t.notes ?? null,
  due: t.due ? new Date(t.due).toISOString() : null,
});
/** Order-independent comparison of what was approved with what is stored. */
const sorted = <T extends { title: string; notes: string | null }>(ts: T[]) => [...ts].sort((a, b) => a.title.localeCompare(b.title) || (a.notes ?? '').localeCompare(b.notes ?? ''));

export function taskTools() {
  const list: ReadTool<Record<string, never>, { id: string; title: string; dueAt: string | null }[]> = {
    spec: TOOL_SPECS['tasks.list'],
    input: z.object({}).strict(),
    run: async (ctx) => (await listTasks(ctx.db, ctx.principalId)).map((t) => ({ id: t.id, title: t.title, dueAt: t.due_at?.toISOString() ?? null })),
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

  return { 'tasks.list': list, 'tasks.create': create, 'tasks.complete': move('tasks.complete', 'DONE'), 'tasks.delete': move('tasks.delete', 'DELETED') };
}
