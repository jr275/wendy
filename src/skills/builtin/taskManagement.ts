/**
 * task-management: list, create, complete or delete the principal's tasks.
 * Every change is an action: create asks by default (WRITE), complete runs by default (WRITE, declared
 * safe), delete always asks (DESTRUCTIVE). A refusal is an honest outcome, not a failure.
 */
import { z } from 'zod';
import { NewTaskSchema } from '../../tools/tasks.js';
import { SkillError, type SkillDefinition } from '../types.js';

const Input = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list'), includeSnoozed: z.boolean().optional().describe('Also show tasks snoozed for later.'), archived: z.boolean().optional().describe('Show the archived tasks instead of the open ones.') }),
  z.object({ operation: z.literal('create'), tasks: z.array(NewTaskSchema).min(1).max(10) }),
  z.object({
    operation: z.literal('update'),
    taskId: z.uuid(),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).nullable().optional().describe("Only the person's own words ('urgente', 'baixa'); never your guess."),
    category: z.string().min(1).max(40).nullable().optional().describe('Only a category the person named.'),
    snoozedUntil: z.iso.datetime({ offset: true }).nullable().optional().describe('Hide the task until this moment; null brings it back. Only when the person gave the date.'),
    archived: z.boolean().optional().describe('true = archive (kept, out of the list); false = bring an archived task back.'),
  }),
  z.object({ operation: z.literal('complete'), taskId: z.uuid() }),
  z.object({ operation: z.literal('delete'), taskId: z.uuid() }),
]);
const Output = z.object({
  operation: z.enum(['list', 'create', 'update', 'complete', 'delete']),
  status: z.enum(['done', 'declined']),
  actionId: z.string().nullable(),
  reason: z.string().nullable(),
  tasks: z.array(z.object({ id: z.string().nullable(), title: z.string(), dueAt: z.string().nullable() })),
});
export type TaskManagementOutput = z.infer<typeof Output>;

const TOOL = { create: 'tasks.create', update: 'tasks.update', complete: 'tasks.complete', delete: 'tasks.delete' } as const;

export const taskManagement: SkillDefinition<z.infer<typeof Input>, TaskManagementOutput> = {
  id: 'task-management',
  name: 'Tarefas',
  description:
    "Manage the principal's own to-do list: list open tasks, create tasks (optionally with the priority and category the person SAID), set priority/category, snooze or archive one, mark one done, or delete one (by id from the open tasks list). Never invent a due date, priority or category; when a date is ambiguous or incomplete, leave dueAt out instead of guessing.",
  version: '1.0.0',
  category: 'productivity',
  triggers: [{ kind: 'intent', examples: ['Crie uma tarefa para revisar a proposta até sexta', 'Quais são minhas tarefas?', 'Marque como feita a tarefa de ligar para o banco', 'Apague a tarefa de revisar o site'] }],
  requiredTools: ['tasks.list', 'tasks.create', 'tasks.update', 'tasks.complete', 'tasks.delete'],
  composable: true,
  autonomous: false,
  riskLevel: 'MEDIUM',
  instructions:
    'Only change tasks the principal asked about. Use task ids from the open tasks list. A due date, priority or category exists only if the principal said it: otherwise leave it out (no arbitrary deadlines). A date that is ambiguous ("sexta" without saying which, a time that was not given) is left out so Wendy can ask.',
  inputs: Input,
  outputs: Output,
  steps: [
    {
      id: 'apply',
      label: 'Aplicando nas suas tarefas',
      timeoutMs: 30_000,
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        type Row = { id: string; title: string; dueAt: string | null };
        const listed = async (opts: { includeSnoozed?: boolean; archived?: boolean } = {}) => (await ctx.read('tasks.list', opts)) as Row[];
        if (i.operation === 'list') return { kind: 'done', output: { operation: 'list', status: 'done', actionId: null, reason: null, tasks: await listed({ includeSnoozed: i.includeSnoozed, archived: i.archived }) } };
        // To change a task the person must be able to name one that is hidden right now (snoozed, or archived to bring back): look in all three places.
        const findable = async () => (i.operation === 'update' ? [...(await listed({ includeSnoozed: true })), ...(await listed({ archived: true }))] : await listed());

        // A due date that already passed is almost always a wrong year or day: stop and let the person confirm instead of saving a deadline nobody chose.
        if (i.operation === 'create') {
          const stale = i.tasks.find((t) => t.dueAt && new Date(t.dueAt).getTime() < ctx.now.getTime() - 60_000);
          if (stale) throw new SkillError('INVALID_INPUT', `a data "${stale.dueAt}" de "${stale.title}" já passou; confirme a data com a pessoa antes de criar a tarefa`);
        }
        const { operation: _op, ...rest } = i as Record<string, unknown> & { operation: string };
        const content = i.operation === 'create' ? { tasks: i.tasks } : i.operation === 'update' ? rest : { taskId: i.taskId };
        const before = i.operation === 'create' ? [] : (await findable()).filter((t) => t.id === i.taskId);
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
