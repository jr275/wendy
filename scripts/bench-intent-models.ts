/**
 * npx tsx scripts/bench-intent-models.ts model1 model2 …
 * Times the real `intent` step (src/skills/discovery.ts, real prompt and catalog) on a few phrases for each model and checks the skill it picks.
 * Calls Vertex (small, paid: ~5 calls per model). Writes NOTHING (no model_calls rows); prints no prompt content.
 */
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { databaseUrl, loadEnv } from '../src/config.js';
import { createPool } from '../src/db/db.js';
import type { ReasoningRequest, ReasoningResult } from '../src/cognition/llm.js';
import { createContext } from '../src/runtime/context.js';
import { createSkillRuntime } from '../src/skills/index.js';
import { discoverIntent } from '../src/skills/discovery.js';
import { systemClock } from '../src/util/clock.js';
import { DevMailboxProvider } from '../src/providers/devMailbox.js';

loadEnv();
const db = createPool(databaseUrl());
const pid = (await db.query<{ id: string }>('SELECT id FROM principals ORDER BY created_at LIMIT 1')).rows[0]!.id;
const ai = new GoogleGenAI({ vertexai: true, project: process.env.GOOGLE_CLOUD_PROJECT!, location: process.env.GEMINI_LOCATION ?? 'global' });
const CASES: [string, string][] = [
  ['Quais são as minhas tarefas?', 'task-management'],
  ['O que saiu de novo em ML?', 'research-digest'],
  ['O que o mercado mostrou hoje?', 'market-watch'],
  ['Pesquise na web como renovar o passaporte brasileiro', 'web-research|research-and-plan'],
  ['O que você sabe sobre mim?', 'none'],
];

const reasonerFor = (model: string, log: { ms: number }[]) => ({
  async generate<T>(req: ReasoningRequest<T>): Promise<ReasoningResult<T>> {
    const t0 = Date.now();
    const res = await ai.models.generateContent({ model, contents: req.user, config: { systemInstruction: req.system, responseMimeType: 'application/json', responseJsonSchema: z.toJSONSchema(req.schema), maxOutputTokens: 32000, thinkingConfig: { thinkingLevel: 'LOW' as never } } });
    log.push({ ms: Date.now() - t0 });
    return { output: req.schema.parse(JSON.parse(res.text ?? 'null')), modelCallId: 'bench', model };
  },
});

const base = createContext({ db, reasoner: undefined as never, clock: systemClock, emailProvider: new DevMailboxProvider(db) });
for (const model of process.argv.slice(2)) {
  const log: { ms: number }[] = [];
  const { registry, toolbox } = createSkillRuntime({ ...base, reasoner: reasonerFor(model, log) as never });
  let ok = 0;
  const rows: string[] = [];
  for (const [phrase, want] of CASES) {
    try {
      const r = await discoverIntent({ db, registry, toolbox, reasoner: reasonerFor(model, log) as never }, { principalId: pid, request: phrase, now: new Date() } as never);
      const got = r.kind === 'skill' ? r.skillId : 'none';
      const good = want.split('|').includes(got);
      ok += good ? 1 : 0;
      rows.push(`${good ? '✓' : '✗'} ${(log.at(-1)!.ms / 1000).toFixed(1)}s  ${got}`);
    } catch (e) {
      rows.push(`ERRO ${(e as Error).message.slice(0, 90)}`);
    }
  }
  const ms = log.map((l) => l.ms).sort((a, b) => a - b);
  console.log(`\n${model}: acertos ${ok}/${CASES.length} | mediana ${ms.length ? (ms[ms.length >> 1]! / 1000).toFixed(1) : '-'}s | máx ${ms.length ? (ms.at(-1)! / 1000).toFixed(1) : '-'}s\n  ${rows.join('\n  ')}`);
}
await db.end();
