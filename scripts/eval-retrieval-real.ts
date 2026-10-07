/**
 * npm run eval:retrieval:real -- --principal-email voce@empresa.com [--cases config/retrieval-cases.json] [--claude]
 *
 * Measures retrieval on YOUR imported data with YOUR questions (format: config/retrieval-cases.example.json).
 * Searches use a read-only connection. Results contain real subjects, so they are written to
 * eval-results/ (git-ignored), never to a committed file. --claude needs credit; without it: BLOCKED.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { readOnlyPool } from '../inspector/readOnlyPool.js';
import { ClaudeReasoningClient, hasClaudeCredentials } from '../src/cognition/llm.js';
import { databaseUrl, loadEnv } from '../src/config.js';
import { createPool } from '../src/db/db.js';
import { RealCasesSchema, runRealRetrievalEval } from '../src/eval/realRetrievalEval.js';
import { normalizeAddress } from '../src/repositories/pg.js';

loadEnv();
const { values: a } = parseArgs({ options: { 'principal-email': { type: 'string' }, cases: { type: 'string', default: 'config/retrieval-cases.json' }, claude: { type: 'boolean', default: false } } });
const fail = (m: string, code = 1): never => {
  console.error(m);
  process.exit(code);
};
if (!a['principal-email']) fail('✗ informe --principal-email');
if (!fs.existsSync(a.cases!)) fail(`✗ arquivo de perguntas não encontrado: ${a.cases} (copie config/retrieval-cases.example.json)`);
if (a.claude && !hasClaudeCredentials()) fail('BLOCKED: --claude requires ANTHROPIC_API_KEY. Nothing was simulated.', 2);
const cases = RealCasesSchema.parse(JSON.parse(fs.readFileSync(a.cases!, 'utf8')));

const ro = readOnlyPool(databaseUrl(), null);
const rw = a.claude ? createPool(databaseUrl()) : null;
try {
  const p = (await ro.query<{ id: string; display_name: string; timezone: string }>('SELECT id, display_name, timezone FROM principals WHERE primary_email = $1', [normalizeAddress(a['principal-email']!)])).rows[0];
  if (!p) fail('✗ executivo não encontrado');
  let r;
  try {
    r = await runRealRetrievalEval(ro, { id: p!.id, name: p!.display_name, timezone: p!.timezone }, cases, 10, rw ? new ClaudeReasoningClient(rw) : null);
  } catch (e) {
    if (a.claude) fail(`BLOCKED: the Claude call failed (${(e as Error).message}). Nothing was simulated.`, 2);
    throw e;
  }
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = [
    `# Busca nos seus dados — recall@10 (${new Date().toISOString().slice(0, 10)})`,
    '',
    `Perguntas: ${cases.length} · termos literais: **${pct(r.literal)}** · termos do Claude: **${r.claude === undefined ? 'não medido' : pct(r.claude)}**`,
    '',
    '| Pergunta | Literal | Claude (termos) | Não encontrado no banco |',
    '|---|---|---|---|',
    ...r.cases.map((c) => `| ${c.question} | ${c.literal.found}/${c.literal.of} | ${c.claude ? `${c.claude.found}/${c.claude.of} · ${c.claude.terms.join(', ')}` : '—'} | ${c.unresolved.join('; ') || '—'} |`),
    '',
  ];
  fs.mkdirSync('eval-results', { recursive: true });
  const out = `eval-results/retrieval-real-${new Date().toISOString().slice(0, 10)}.md`;
  fs.writeFileSync(out, lines.join('\n'));
  console.log(`recall@10 — literal ${pct(r.literal)} · Claude ${r.claude === undefined ? 'não medido' : pct(r.claude)}\nRelatório (fora do git): ${out}`);
} finally {
  await ro.end();
  await rw?.end();
}
