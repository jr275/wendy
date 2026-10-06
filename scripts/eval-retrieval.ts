/**
 * npm run eval:retrieval [-- --claude]
 *
 * Measures the current lexical retrieval on the synthetic evaluation set (fixtures/retrievalEval.ts)
 * in a throwaway schema of the test database and writes WENDY_RETRIEVAL_EVAL.md.
 * Nothing in the core is changed.
 *
 * --claude: also asks the real understanding step (claude-opus-5-5) for the search terms of each
 * question — the only measurement that decides 3.4. Without a key or credit it stops with BLOCKED;
 * it never substitutes simulated terms.
 */
import fs from 'node:fs';
import { ClaudeReasoningClient } from '../src/cognition/llm.js';
import { loadEnv } from '../src/config.js';
import { runRetrievalEval, type EvalSummary } from '../src/eval/retrievalEval.js';
import { createTestDb } from '../tests/helpers/db.js';

loadEnv();
const withClaude = process.argv.includes('--claude');
if (withClaude && !process.env.ANTHROPIC_API_KEY) {
  console.error('BLOCKED: --claude requires ANTHROPIC_API_KEY (.env). Nothing was simulated.');
  process.exit(2);
}

const t = await createTestDb();
let r: EvalSummary;
try {
  r = await runRetrievalEval(t.db, 10, new Date(), withClaude ? new ClaudeReasoningClient(t.db) : null);
} catch (e) {
  if (withClaude) {
    console.error(`BLOCKED: the Claude call failed (${(e as Error).message}). Nothing was simulated; the report was not changed.`);
    process.exit(2);
  }
  throw e;
} finally {
  await t.drop();
}

const pct = (x: number | undefined) => (x === undefined ? '—' : `${Math.round(x * 100)}%`);
const decide = (x: number) => (x >= 0.8 ? 'acima do critério (0,8)' : 'ABAIXO do critério (0,8)');
const hasClaude = r.overall.claude !== undefined;
const miss = (expected: string[], found: string[]) => expected.filter((e) => !found.includes(e));
const cell = (expected: string[], x?: { found: string[]; recall: number }) => (x ? `${pct(x.recall)}${miss(expected, x.found).length ? ` (faltou ${miss(expected, x.found).join(', ')})` : ''}` : '—');

const lines = [
  '# WENDY — Medição da busca (recall@10)',
  '',
  `Gerado por \`npm run eval:retrieval${hasClaude ? ' -- --claude' : ''}\` em ${new Date().toISOString().slice(0, 10)}. **Corpus sintético** (\`fixtures/retrievalEval.ts\`): ${r.cases.length} perguntas sobre ${26} registros em português e inglês (mensagens, reuniões, compromissos e memórias).`,
  '',
  'Mede a busca textual **atual**: as mesmas funções que o núcleo usa, sem nenhuma mudança. Cada tipo de registro é buscado com limite 10 e sem filtro de data, para isolar a parte textual. As colunas mudam apenas **de onde vêm os termos de busca**:',
  '',
  '- **Literal:** as palavras como a pessoa escreveria. É o **piso**.',
  '- **Como o prompt pede:** variantes, sinônimos e as duas línguas, que é o que o prompt de entendimento pede ao Claude. **Atenção:** escrevi esses termos à mão, conhecendo o corpus, então é um **teto otimista**, não uma medição do Claude.',
  `- **Claude real:** os termos que o passo de entendimento do Claude realmente gera para cada pergunta. ${hasClaude ? 'Medido nesta execução.' : '**BLOCKED** (sem saldo de API): rode `npm run eval:retrieval -- --claude` quando houver crédito.'}`,
  '',
  '## Resultado',
  '',
  '| | Literal (piso) | Como o prompt pede (teto) | Claude real |',
  '|---|---|---|---|',
  `| **Geral** | **${pct(r.overall.literal)}** | **${pct(r.overall.instructed)}** | **${hasClaude ? pct(r.overall.claude) : 'BLOCKED'}** |`,
  ...Object.entries(r.byCategory).map(([c, b]) => `| ${c} (${b.n}) | ${pct(b.literal)} | ${pct(b.instructed)} | ${hasClaude ? pct(b.claude) : '—'} |`),
  '',
  '## O que isso significa',
  '',
  `- **Piso:** ${decide(r.overall.literal)}. A busca atual é puramente lexical (configuração \`simple\` do Postgres): não reduz palavras à raiz (proposta/propostas), não ignora acento (preco/preço), não conhece sinônimos e não traduz. Fora do termo exato, ela não acha nada sozinha.`,
  `- **Teto:** ${decide(r.overall.instructed)}. Se o Claude expandir os termos como o prompt pede, a busca textual basta para este corpus.`,
  `- **Decisão do 3.4 (pgvector):** ${hasClaude ? `com os termos reais do Claude, ${decide(r.overall.claude!)}.` : 'ainda **não dá para decidir**. Tudo depende de quanto o Claude expande os termos, e isso só a coluna "Claude real" mede.'}`,
  '- **Melhoria barata, sem pgvector (fica para depois do gate, porque muda o núcleo):** ignorar acentos (`unaccent`) e reduzir palavras à raiz em português e inglês. Isso cobre "flexão" e "acento" mesmo quando o Claude não expande os termos. Sinônimos, traduções e paráfrases continuam dependendo dos termos do Claude, ou de busca vetorial.',
  '- **Limite desta medição:** o corpus é sintético e pequeno. Com a importação dos seus dados reais (`npm run import`), dá para repetir a medição com perguntas suas.',
  '',
  '## Por pergunta',
  '',
  `| Categoria | Pergunta | Esperado | Literal | Como o prompt pede | Claude real${hasClaude ? ' (termos)' : ''} |`,
  '|---|---|---|---|---|---|',
  ...r.cases.map(
    (c) =>
      `| ${c.category} | ${c.question} | ${c.expected.join(', ')} | ${cell(c.expected, c.literal)} | ${cell(c.expected, c.instructed)} | ${c.claude ? `${cell(c.expected, c.claude)} · ${c.claude.terms.join(', ')}` : '—'} |`,
  ),
  '',
];
fs.writeFileSync('WENDY_RETRIEVAL_EVAL.md', lines.join('\n'));
console.log(`recall@10 — literal ${pct(r.overall.literal)} · como o prompt pede ${pct(r.overall.instructed)} · Claude real ${hasClaude ? pct(r.overall.claude) : 'BLOCKED'}\nRelatório: WENDY_RETRIEVAL_EVAL.md`);
