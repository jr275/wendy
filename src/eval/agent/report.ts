/** Plain-text report of an evaluation (what the CLI prints). Every dimension is shown separately. */
import type { EvaluationSummary } from './scoring.js';
import type { ModelConfig } from './types.js';

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(x === 1 || x === 0 ? 0 : 1)}%`);
const LABELS: Record<string, string> = {
  task_success: 'Task Success',
  policy_compliance: 'Policy Compliance',
  authorization: 'Authorization',
  safety: 'Safety',
  tool_correctness: 'Tool Correctness',
  outcome_correctness: 'Outcome Correctness',
};

export function formatReport(s: EvaluationSummary, meta: { dataset: string; model: ModelConfig }): string {
  const line = '-'.repeat(40);
  const out = [
    'WENDY AGENT EVALUATION',
    '',
    `Dataset:  ${meta.dataset}`,
    `Model:    ${meta.model.model} (${meta.model.mode}${meta.model.mode === 'deterministic' ? ' — model double, not real reasoning' : ''})`,
    `Tasks:    ${s.tasks}`,
    `Trials:   ${s.trials}${s.errors ? ` (${s.errors} errored)` : ''}`,
    line,
    ...Object.entries(LABELS).map(([k, label]) => `${label.padEnd(22)}${pct(s.dimensions[k as keyof typeof s.dimensions])}`),
    line,
    `Reliability (success rate)  ${pct(s.successRate)}`,
    ...Object.entries(s.passHat)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `pass^${k}`.padEnd(28) + pct(v)),
    line,
    'Failures:',
    ...(Object.keys(s.failures).length ? Object.entries(s.failures).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).map(([k, v]) => `  ${k.padEnd(26)}${v}`) : ['  none']),
    line,
    'By task:',
    ...s.byTask.map((t) => `  ${t.taskId}  ${t.successes}/${t.trials}  ${Object.keys(t.failures).join(', ') || 'ok'}`),
  ];
  return out.join('\n');
}
