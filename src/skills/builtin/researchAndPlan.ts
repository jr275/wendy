/**
 * research-and-plan (composite): web-research → tasks proposed from the validated claims →
 * task-management create (asks for approval). Composition is declared in `dependencies` and run by
 * the runtime; the model only proposes task text, each tied to claims it can cite.
 */
import { z } from 'zod';
import type { NewTask } from '../../tasks/taskService.js';
import { SkillError, type SkillDefinition, type StepContext } from '../types.js';
import { TASK_PLAN_SYSTEM } from '../prompts.js';
import type { TaskManagementOutput } from './taskManagement.js';
import type { WebResearchOutput } from './webResearch.js';

const Input = z.object({ topic: z.string().min(3).max(300), createTasks: z.boolean().default(true), maxTasks: z.number().int().min(1).max(5).default(3) });
const PlanSchema = z.object({ tasks: z.array(z.object({ title: z.string(), notes: z.string().nullable(), based_on: z.array(z.string()) })) });
const Output = z.object({
  topic: z.string(),
  researchExecutionId: z.string(),
  tasksExecutionId: z.string().nullable(),
  proposedTasks: z.number().int(),
  droppedTasks: z.number().int(),
  tasks: z.object({ status: z.enum(['done', 'declined', 'not_requested', 'none_justified']), reason: z.string().nullable(), items: z.array(z.object({ title: z.string() })) }),
});

/** Waits for a child: returns its output, parks, or fails with the child's reason. */
async function awaitChild<T>(ctx: StepContext, key: string, skillId: string, input: unknown): Promise<{ wait: string } | { output: T; id: string }> {
  const id = (ctx.state[key] as string | undefined) ?? (ctx.state[key] = await ctx.startChild(key, skillId, input));
  const c = await ctx.child(id);
  if (c.status === 'completed') return { output: c.output as T, id };
  if (c.status === 'failed' || c.status === 'cancelled') throw new SkillError('CHILD_FAILED', `${skillId}: ${c.error?.message ?? c.status}`);
  return { wait: id };
}

export const researchAndPlan: SkillDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  id: 'research-and-plan',
  name: 'Pesquisar e planejar',
  description: 'Research a topic on the web and turn the verified findings into follow-up tasks for the principal (tasks need approval).',
  version: '1.0.0',
  category: 'research',
  triggers: [{ kind: 'intent', examples: ['Pesquise como renovar meu passaporte e crie as tarefas para eu fazer', 'Veja o que preciso para tirar o visto e organize em tarefas'] }],
  requiredTools: [],
  dependencies: ['web-research', 'task-management'],
  composable: false,
  autonomous: false,
  riskLevel: 'MEDIUM',
  instructions: 'Tasks must follow from verified findings only.',
  inputs: Input,
  outputs: Output,
  steps: [
    {
      id: 'research',
      label: 'Pesquisando',
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        const r = await awaitChild<WebResearchOutput>(ctx, 'research', 'web-research', { query: i.topic, maxSources: 3 });
        return 'wait' in r ? { kind: 'wait_child', childId: r.wait } : { kind: 'next' };
      },
    },
    {
      id: 'plan',
      label: 'Transformando achados em tarefas',
      retry: { attempts: 2, backoffMs: 2000 },
      timeoutMs: 120_000,
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        if (!i.createTasks) return { kind: 'next' };
        const research = (await ctx.child(ctx.state.research as string)).output as WebResearchOutput;
        if (!research.claims.length) {
          ctx.state.plan = [];
          return { kind: 'next' };
        }
        const r = await ctx.reason({
          purpose: 'plan',
          system: TASK_PLAN_SYSTEM,
          user: [`Principal's language: ${await ctx.language()}.`, `Topic: ${i.topic}`, `At most ${i.maxTasks} tasks.`, '', 'Validated claims:', ...research.claims.map((c) => `[${c.label}] (${c.kind}) ${c.statement}`)].join('\n'),
          schema: PlanSchema,
          effort: 'low',
          evidenceRefs: [],
        });
        const labels = new Map(research.claims.map((c) => [c.label, c]));
        const valid: NewTask[] = [];
        let dropped = 0;
        for (const t of r.output.tasks) {
          const basis = t.based_on.filter((b) => labels.has(b));
          const title = t.title.trim().slice(0, 300);
          if (!basis.length || !title || valid.length >= i.maxTasks) {
            dropped++;
            continue;
          }
          const evidence = basis.flatMap((b) => labels.get(b)!.evidence).map((h) => research.sources.find((s) => s.handle === h)).filter((s) => !!s).map((s) => ({ kind: 'web_page', id: s.sourceId }));
          valid.push({ title, notes: t.notes?.slice(0, 4000) ?? null, evidence });
        }
        ctx.state.plan = valid;
        ctx.state.proposed = r.output.tasks.length;
        ctx.state.dropped = dropped;
        return { kind: 'next' };
      },
    },
    {
      id: 'create',
      label: 'Pedindo sua aprovação para as tarefas',
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        const base = { topic: i.topic, researchExecutionId: ctx.state.research as string, proposedTasks: (ctx.state.proposed as number) ?? 0, droppedTasks: (ctx.state.dropped as number) ?? 0 };
        const plan = (ctx.state.plan as NewTask[] | undefined) ?? [];
        if (!i.createTasks) return { kind: 'done', output: { ...base, tasksExecutionId: null, tasks: { status: 'not_requested', reason: null, items: [] } } };
        if (!plan.length) return { kind: 'done', output: { ...base, tasksExecutionId: null, tasks: { status: 'none_justified', reason: 'no task followed from verified findings', items: [] } } };
        const r = await awaitChild<TaskManagementOutput>(ctx, 'tasks', 'task-management', { operation: 'create', tasks: plan });
        if ('wait' in r) return { kind: 'wait_child', childId: r.wait };
        return { kind: 'done', output: { ...base, tasksExecutionId: r.id, tasks: { status: r.output.status, reason: r.output.reason, items: plan.map((t) => ({ title: t.title })) } } };
      },
    },
  ],
};
