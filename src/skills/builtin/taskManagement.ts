/**
 * task-management: list, create, complete or delete the principal's tasks.
 * Every change is an action: create asks by default (WRITE), complete runs by default (WRITE, declared
 * safe), delete always asks (DESTRUCTIVE). A refusal is an honest outcome, not a failure.
 */
import { z } from 'zod';
import { NewTaskSchema } from '../../tools/tasks.js';
import { SkillError, type SkillDefinition } from '../types.js';

const Input = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }),
  z.object({ operation: z.literal('create'), tasks: z.array(NewTaskSchema).min(1).max(10) }),
  z.object({ operation: z.literal('complete'), taskId: z.uuid() }),
  z.object({ operation: z.literal('delete'), taskId: z.uuid() }),
]);
const Output = z.object({
  operation: z.enum(['list', 'create', 'complete', 'delete']),
  status: z.enum(['done', 'declined']),
  actionId: z.string().nullable(),
  reason: z.string().nullable(),
  tasks: z.array(z.object({ id: z.string().nullable(), title: z.string(), dueAt: z.string().nullable() })),
});
export type TaskManagementOutput = z.infer<typeof Output>;

const TOOL = { create: 'tasks.create', complete: 'tasks.complete', delete: 'tasks.delete' } as const;

export const taskManagement: SkillDefinition<z.infer<typeof Input>, TaskManagementOutput> = {
  id: 'task-management',
  name: 'Tarefas',
  description: "Manage the principal's own to-do list: list open tasks, create tasks, mark one done, or delete one (by id from the open tasks list).",
  version: '1.0.0',
  category: 'productivity',
  triggers: [{ kind: 'intent', examples: ['Crie uma tarefa para revisar a proposta até sexta', 'Quais são minhas tarefas?', 'Marque como feita a tarefa de ligar para o banco', 'Apague a tarefa de revisar o site'] }],
  requiredTools: ['tasks.list', 'tasks.create', 'tasks.complete', 'tasks.delete'],
  composable: true,
  autonomous: false,
  riskLevel: 'MEDIUM',
  instructions: 'Only change tasks the principal asked about. Use task ids from the open tasks list.',
  inputs: Input,
  outputs: Output,
  steps: [
    {
      id: 'apply',
      label: 'Aplicando nas suas tarefas',
      timeoutMs: 30_000,
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        const listed = async () => (await ctx.read('tasks.list', {})) as { id: string; title: string; dueAt: string | null }[];
        if (i.operation === 'list') return { kind: 'done', output: { operation: 'list', status: 'done', actionId: null, reason: null, tasks: await listed() } };

        const content = i.operation === 'create' ? { tasks: i.tasks } : { taskId: i.taskId };
        const before = i.operation === 'create' ? [] : (await listed()).filter((t) => t.id === i.taskId);
        if (i.operation !== 'create' && !before.length) throw new SkillError('INVALID_INPUT', `task ${i.taskId} is not an open task of the principal`);

        const r = await ctx.effect(i.operation, TOOL[i.operation], content);
        if (r.status === 'pending') return { kind: 'wait_action', actionId: r.actionId };
        if (r.status === 'refused') {
          if (r.state === 'FAILED') throw new SkillError('TOOL_FAILED', `${TOOL[i.operation]} failed: ${r.reason ?? 'unknown'}`);
          const tasks = i.operation === 'create' ? i.tasks.map((t) => ({ id: null, title: t.title, dueAt: t.dueAt ?? null })) : before;
          return { kind: 'done', output: { operation: i.operation, status: 'declined', actionId: r.actionId, reason: r.reason ?? r.state, tasks } };
        }
        const tasks = i.operation === 'create' ? (await listed()).filter((t) => i.tasks.some((n) => n.title === t.title)) : before;
        return { kind: 'done', output: { operation: i.operation, status: 'done', actionId: r.actionId, reason: null, tasks } };
      },
    },
  ],
};
