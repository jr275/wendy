/**
 * Scoring across trials. Dimensions stay separate; the aggregate never replaces them.
 *
 * Reliability (definitions, as in τ-bench):
 *   For a task run n times with c successes (a success = every evaluated dimension PASS):
 *     success_rate = c / n
 *     pass@k = 1 − C(n−c, k) / C(n, k)   probability that AT LEAST ONE of k trials drawn without
 *                                         replacement from the n succeeds ("can it ever do it?")
 *     pass^k = C(c, k) / C(n, k)         probability that ALL k trials drawn without replacement
 *                                         from the n succeed ("does it do it every time?")
 *   Both are unbiased estimators of 1−(1−p)^k and p^k for a per-trial success probability p.
 *   Defined only for 1 ≤ k ≤ n (else null). Dataset values are the mean over tasks.
 */
import type { EvaluatorId, FailureCategory, TrialResult } from './types.js';

export function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

export function passHatK(n: number, c: number, k: number): number | null {
  if (k < 1 || k > n || c < 0 || c > n) return null;
  return binomial(c, k) / binomial(n, k);
}

export function passAtK(n: number, c: number, k: number): number | null {
  if (k < 1 || k > n || c < 0 || c > n) return null;
  return 1 - binomial(n - c, k) / binomial(n, k);
}

export interface TaskSummary {
  taskId: string;
  trials: number;
  successes: number;
  successRate: number;
  passHat: Record<number, number | null>;
  passAt: Record<number, number | null>;
  dimensions: Partial<Record<EvaluatorId, number>>;
  failures: Partial<Record<FailureCategory, number>>;
}

export interface EvaluationSummary {
  tasks: number;
  trials: number;
  successRate: number;
  /** Mean over tasks of each task's pass^k / pass@k (k = 1..max common n). */
  passHat: Record<number, number | null>;
  passAt: Record<number, number | null>;
  /** Mean score of each dimension over all trials. */
  dimensions: Partial<Record<EvaluatorId, number>>;
  failures: Partial<Record<FailureCategory, number>>;
  byTask: TaskSummary[];
  errors: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function dims(trials: TrialResult[]): Partial<Record<EvaluatorId, number>> {
  const out: Partial<Record<EvaluatorId, number>> = {};
  const ids = new Set(trials.flatMap((t) => Object.keys(t.scores) as EvaluatorId[]));
  for (const id of ids) out[id] = mean(trials.map((t) => t.scores[id]).filter((x): x is number => x !== undefined));
  return out;
}

function failureCounts(trials: TrialResult[]): Partial<Record<FailureCategory, number>> {
  const out: Partial<Record<FailureCategory, number>> = {};
  for (const f of trials.flatMap((t) => t.failures)) out[f.category] = (out[f.category] ?? 0) + 1;
  return out;
}

export function summarize(results: TrialResult[], ks: number[] = [1, 2, 3, 5, 10]): EvaluationSummary {
  const byId = new Map<string, TrialResult[]>();
  for (const r of results) byId.set(r.taskId, [...(byId.get(r.taskId) ?? []), r]);
  const byTask: TaskSummary[] = [...byId.entries()].map(([taskId, trials]) => {
    const n = trials.length;
    const c = trials.filter((t) => t.status === 'passed').length;
    return {
      taskId,
      trials: n,
      successes: c,
      successRate: n ? c / n : 0,
      passHat: Object.fromEntries(ks.map((k) => [k, passHatK(n, c, k)])),
      passAt: Object.fromEntries(ks.map((k) => [k, passAtK(n, c, k)])),
      dimensions: dims(trials),
      failures: failureCounts(trials),
    };
  });
  const across = (pick: (t: TaskSummary) => Record<number, number | null>) =>
    Object.fromEntries(
      ks.map((k) => {
        const vals = byTask.map((t) => pick(t)[k]);
        return [k, vals.length && vals.every((v) => v !== null) ? mean(vals as number[]) : null];
      }),
    );
  return {
    tasks: byTask.length,
    trials: results.length,
    successRate: results.length ? results.filter((r) => r.status === 'passed').length / results.length : 0,
    passHat: across((t) => t.passHat),
    passAt: across((t) => t.passAt),
    dimensions: dims(results),
    failures: failureCounts(results),
    byTask,
    errors: results.filter((r) => r.status === 'error').length,
  };
}
