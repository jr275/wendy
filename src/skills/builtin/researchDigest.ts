/**
 * research-digest: "o que saiu de novo em ML?" — the best new reading in machine learning, AI and science, from the principal's digest.
 * Items come from public feeds and are ranked by an explained rule (src/research/rank.ts). The summaries are the SOURCES' own abstracts:
 * this skill writes no summary and calls no model.
 */
import { z } from 'zod';
import type { DigestToolOutput } from '../../tools/research.js';
import type { SkillDefinition } from '../types.js';

const Input = z.object({ refresh: z.boolean().optional().describe('Fetch the public feeds now before answering (default true).') });
const Output = z.object({
  refresh: z.string(),
  items: z.array(z.object({ title: z.string(), url: z.string(), source: z.string(), publishedAt: z.string().nullable(), summary: z.string().nullable(), why: z.string().nullable(), read: z.boolean() })),
  note: z.string(),
});
export type ResearchDigestOutput = z.infer<typeof Output>;

export const researchDigestSkill: SkillDefinition<z.infer<typeof Input>, ResearchDigestOutput> = {
  id: 'research-digest',
  name: 'Leituras de ML e IA',
  description: "What is new in machine learning, AI and science: the best recent papers and posts from public feeds, each with the source's own abstract excerpt and a link. Not a recommendation of what to believe; ranked by recency, source and topics.",
  version: '1.0.0',
  category: 'research',
  triggers: [{ kind: 'intent', examples: ['O que saiu de novo em ML?', 'Quais as novidades de inteligência artificial hoje?', 'Me mostra os melhores papers de machine learning desta semana', 'Resumo de IA do dia'] }],
  requiredTools: ['research.digest'],
  composable: true,
  autonomous: false,
  riskLevel: 'LOW',
  instructions: 'Show titles, sources and links as they are. Summaries are the source abstracts; never add claims that are not in them.',
  inputs: Input,
  outputs: Output,
  steps: [
    {
      id: 'read',
      label: 'Buscando as novidades',
      timeoutMs: 120_000,
      run: async (ctx) => {
        const i = Input.parse(ctx.input);
        const r = (await ctx.read('research.digest', { refresh: i.refresh ?? true })) as DigestToolOutput;
        const note =
          r.refresh === 'no_routine' ? 'A rotina de leituras ainda não está ativada; mostro o que já existe.' : r.refresh === 'failed' ? 'Não consegui buscar agora; mostro as últimas leituras guardadas.' : r.refresh === 'skipped' ? 'As leituras de hoje já tinham sido buscadas.' : '';
        const fresh = r.items.filter((x) => !x.read).slice(0, 8);
        return { kind: 'done', output: { refresh: r.refresh, items: (fresh.length ? fresh : r.items.slice(0, 8)).map(({ id: _id, ...x }) => x), note } };
      },
    },
  ],
};
