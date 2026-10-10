/**
 * Task registry and datasets. Tasks are validated on registration (a malformed fixture fails loudly,
 * never half-runs). Datasets are named, versioned lists of task ids; a regression dataset grows from
 * failures (regression.ts).
 */
import { POLICY_TASKS } from '../../../fixtures/agentEval/policy.js';
import { VOICE_TASKS } from '../../../fixtures/agentEval/voice.js';
import { EvaluationTaskSchema, type EvaluationTask, type EvaluationTaskInput } from './types.js';

export class TaskRegistryError extends Error {}

export class TaskRegistry {
  private readonly tasks = new Map<string, EvaluationTask>();
  private readonly datasets = new Map<string, string[]>();

  register(input: EvaluationTaskInput): this {
    const parsed = EvaluationTaskSchema.safeParse(input);
    if (!parsed.success) throw new TaskRegistryError(`task ${String((input as { id?: unknown }).id)}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    if (this.tasks.has(parsed.data.id)) throw new TaskRegistryError(`task ${parsed.data.id} is already registered`);
    this.tasks.set(parsed.data.id, parsed.data);
    return this;
  }

  dataset(id: string, taskIds: string[]): this {
    const missing = taskIds.filter((t) => !this.tasks.has(t));
    if (missing.length) throw new TaskRegistryError(`dataset ${id}: unknown tasks ${missing.join(', ')}`);
    this.datasets.set(id, [...taskIds]);
    return this;
  }

  get(id: string): EvaluationTask | null {
    return this.tasks.get(id) ?? null;
  }

  list(filter: { domain?: string; dataset?: string; ids?: string[] } = {}): EvaluationTask[] {
    let ids = [...this.tasks.keys()];
    if (filter.dataset) {
      const d = this.datasets.get(filter.dataset);
      if (!d) throw new TaskRegistryError(`unknown dataset ${filter.dataset}`);
      ids = d;
    }
    if (filter.ids) ids = ids.filter((i) => filter.ids!.includes(i));
    return ids.map((i) => this.tasks.get(i)!).filter((t) => !filter.domain || t.domain === filter.domain);
  }

  datasetIds(): string[] {
    return [...this.datasets.keys()];
  }
}

export function builtinTasks(): TaskRegistry {
  const r = new TaskRegistry();
  for (const t of [...VOICE_TASKS, ...POLICY_TASKS]) r.register(t);
  return r
    .dataset(
      'voice-concierge-v1',
      VOICE_TASKS.map((t) => t.id),
    )
    .dataset(
      'voice-policy-v1',
      POLICY_TASKS.map((t) => t.id),
    );
}
