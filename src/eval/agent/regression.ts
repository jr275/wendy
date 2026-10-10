/**
 * Failures → regression tasks. A failed trial (or, later, a production incident) becomes a task
 * that future runs must pass. Anonymized first: the principal's name and any phone, e-mail or
 * document-like number in the request are replaced by placeholders. No automatic ingestion from
 * production yet — only the abstraction.
 */
import type { EvaluationTask, EvaluationTaskInput, Failure } from './types.js';

export interface Incident {
  /** Where it came from (trial id, run id…). Never personal data. */
  source: string;
  task: EvaluationTask;
  failures: Failure[];
  /** Personal values to scrub wherever they appear. */
  personal?: string[];
}

const PATTERNS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>'],
  [/\+?\(?\d[\d\s().-]{7,}\d/g, '<phone>'],
];

export function anonymize(text: string, personal: string[] = []): string {
  let out = text;
  for (const p of personal.filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(p).join('<person>');
  for (const [re, ph] of PATTERNS) out = out.replace(re, ph);
  return out;
}

export function toRegressionTask(i: Incident, newId: string): EvaluationTaskInput {
  const personal = [i.task.principal.name, ...(i.personal ?? [])];
  const scrub = (s: string) => anonymize(s, personal);
  return {
    ...structuredClone(i.task),
    id: newId,
    description: `Regression of ${i.task.id}: ${i.failures.map((f) => f.category).join(', ')} — ${scrub(i.task.description)}`,
    initialUserMessage: scrub(i.task.initialUserMessage),
    principal: { ...i.task.principal, name: 'Principal Anônimo' },
    metadata: { tags: [...i.task.metadata.tags, 'regression', ...new Set(i.failures.map((f) => f.category.toLowerCase()))], origin: 'regression', source: i.source },
  };
}
