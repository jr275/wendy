/**
 * Agent Evaluation Layer — CLI.
 *
 *   npm run eval:agent -- list
 *   npm run eval:agent -- run [--task V001,V003] [--domain voice] [--dataset voice-concierge-v1] [--trials 10] [--seed 1] [--model gemini]
 *   npm run eval:agent -- report [file]
 *
 * Runs in a throwaway schema of the TEST database (dropped at the end); never the dev database.
 * Default mode is deterministic (the model double each task carries — labeled, not real reasoning).
 * --model gemini uses the real Gemini reasoner (not Claude); it reaches Vertex, nothing else.
 * Results (machine-readable) go to eval-results/agent-<timestamp>.json (gitignored).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../src/config.js';
import { DEFAULT_GEMINI_MODEL, GeminiReasoningClient } from '../src/cognition/gemini.js';
import { builtinTasks } from '../src/eval/agent/registry.js';
import { formatReport } from '../src/eval/agent/report.js';
import { deterministicReasoner, modelReasoner, runEvaluation } from '../src/eval/agent/runner.js';
import { summarize } from '../src/eval/agent/scoring.js';
import { createTestDb } from '../tests/helpers/db.js';

loadEnv();
const [cmd = 'list', ...rest] = process.argv.slice(2);
const arg = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const DIR = 'eval-results';
const registry = builtinTasks();

if (cmd === 'list') {
  for (const d of registry.datasetIds()) console.log(`dataset ${d}: ${registry.list({ dataset: d }).map((t) => t.id).join(' ')}`);
  for (const t of registry.list()) console.log(`${t.id}  [${t.domain}]  ${t.description}`);
} else if (cmd === 'run') {
  const tasks = registry.list({ dataset: arg('dataset'), domain: arg('domain'), ids: arg('task')?.split(',') });
  if (!tasks.length) throw new Error('no task matches');
  const trials = Number(arg('trials') ?? 1);
  const reasoner =
    arg('model') === 'gemini'
      ? modelReasoner((db) => new GeminiReasoningClient(db), { model: process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL, provider: 'vertex', config: { location: process.env.GEMINI_LOCATION ?? 'global' } })
      : deterministicReasoner;
  const t = await createTestDb();
  try {
    const { results } = await runEvaluation(t.db, tasks, { trials, baseSeed: Number(arg('seed') ?? 1), reasoner, onTrial: (r) => console.error(`${r.taskId} #${r.trial} ${r.status}${r.failures.length ? ` — ${r.failures.map((f) => f.category).join(', ')}` : ''}`) });
    const summary = summarize(results, [1, 2, 3, 5, 10].filter((k) => k <= trials));
    const dataset = arg('dataset') ?? arg('domain') ?? arg('task') ?? 'all';
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, `agent-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ dataset, model: results[0]?.model, summary, results }, null, 1));
    console.log(formatReport(summary, { dataset, model: results[0]!.model }));
    console.log(`\nresults: ${file}`);
  } finally {
    await t.drop();
  }
} else if (cmd === 'report') {
  const file = rest[0] ?? (fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.startsWith('agent-')).sort().map((f) => path.join(DIR, f)).at(-1) : undefined);
  if (!file) throw new Error('no evaluation results yet: run `npm run eval:agent -- run` first');
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(formatReport(r.summary, { dataset: r.dataset, model: r.model }));
} else {
  console.error(`unknown command ${cmd} (list | run | report)`);
  process.exit(2);
}
